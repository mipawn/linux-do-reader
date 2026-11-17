(() => {
  const siteURL = "https://linux.do";
  const dateFormat = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  });

  function dateLabel(value, compact = false) {
    const date = new Date(value);
    if (!value || !Number.isFinite(date.getTime())) return "时间未知";
    const parts = Object.fromEntries(dateFormat.formatToParts(date).map(({ type, value }) => [type, value]));
    return compact
      ? `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`
      : `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
  }

  function safeURL(value) {
    if (typeof value !== "string" || !value.trim()) return null;
    try {
      const url = new URL(value, siteURL);
      return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url : null;
    } catch {
      return null;
    }
  }

  function jsonPath(path) {
    const url = safeURL(path);
    if (url?.origin !== siteURL) throw new Error("原站返回了无效的地址。");
    if (!url.pathname.endsWith(".json")) url.pathname = url.pathname.replace(/\/$/, "") + ".json";
    return url.pathname + url.search;
  }

  // Every reader request shares one lane. Separate panes must not compete with
  // timings (or a fast scroll) for the same site's request quota.
  class RequestQueue {
    constructor({ now = () => Date.now(), wait = ms => new Promise(resolve => setTimeout(resolve, ms)), interval = 1100, timeout = 15000, storage } = {}) {
      Object.assign(this, { now, wait, interval, timeout });
      try { this.storage = storage === undefined ? globalThis.localStorage : storage; } catch {}
      this.pending = [];
      this.running = false;
      this.lastStart = -Infinity;
      this.retryAt = 0;
    }

    cooldown() {
      try { this.retryAt = Math.max(this.retryAt, Number(this.storage?.getItem("linux-do-reader-retry-at")) || 0); } catch {}
      return Math.max(0, this.retryAt - this.now());
    }

    defer(ms) {
      this.cooldown();
      this.retryAt = Math.max(this.retryAt, this.now() + ms);
      // Share only a deadline, never account/content data, with other tabs.
      try { this.storage?.setItem("linux-do-reader-retry-at", String(this.retryAt)); } catch {}
    }

    busyError() {
      const error = new Error(`原站限流，已暂停请求，请 ${Math.ceil(this.cooldown() / 1000)} 秒后重试。`);
      Object.assign(error, { status: 429, retryAfter: this.cooldown() });
      return error;
    }

    schedule(task, { signal, priority = 0, background = false } = {}) {
      if (signal?.aborted) return Promise.reject(signal.reason || new DOMException("Aborted", "AbortError"));
      if (background && this.cooldown()) return Promise.reject(this.busyError());
      return new Promise((resolve, reject) => {
        const entry = { task, signal, priority, background, resolve, reject };
        entry.abort = () => {
          const index = this.pending.indexOf(entry);
          if (index < 0) return;
          this.pending.splice(index, 1);
          reject(signal.reason || new DOMException("Aborted", "AbortError"));
        };
        signal?.addEventListener("abort", entry.abort, { once: true });
        this.pending.push(entry);
        void this.drain();
      });
    }

    async drain() {
      if (this.running) return;
      this.running = true;
      try {
        while (this.pending.length) {
          const cooldown = this.cooldown();
          if (cooldown) {
            for (const entry of [...this.pending]) {
              if (!entry.background) continue;
              this.pending.splice(this.pending.indexOf(entry), 1);
              entry.signal?.removeEventListener("abort", entry.abort);
              entry.reject(this.busyError());
            }
          }
          if (!this.pending.length) break;
          const delay = Math.max(cooldown, this.lastStart + this.interval - this.now());
          if (delay > 0) { await this.wait(delay); continue; }
          // Pick AFTER waiting so newly clicked content overtakes background work.
          this.pending.sort((a, b) => a.priority - b.priority);
          const entry = this.pending.shift();
          entry.signal?.removeEventListener("abort", entry.abort);
          this.lastStart = this.now();
          try { entry.resolve(await entry.task()); }
          catch (error) { entry.reject(error); }
        }
      } finally {
        this.running = false;
      }
    }
  }

  const requestQueue = new RequestQueue();

  function retryDelay(response, payload) {
    const header = response.headers?.get("Retry-After");
    const seconds = header?.trim() && Number(header);
    const date = header && Date.parse(header);
    const headerDelay = Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(date) ? date - Date.now() : 0;
    const payloadDelay = Number(payload?.extras?.wait_seconds ?? payload?.wait_seconds) * 1000;
    return Math.max(30000, headerDelay || 0, payloadDelay || 0);
  }

  async function request(path, { signal, method = "GET", body, csrf, keepalive = false, headers: extraHeaders, priority = 0, background = false } = {}) {
    const url = safeURL(path);
    if (url?.origin !== siteURL) throw new Error("原站返回了无效的地址。");
    const headers = { Accept: "application/json", "X-Requested-With": "XMLHttpRequest", ...extraHeaders };
    if (csrf) headers["X-CSRF-Token"] = csrf;
    if (body) headers["Content-Type"] = "application/json";
    const perform = async () => {
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      let timer;
      const deadline = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error("原站响应超时，请重试。");
          error.name = "TimeoutError";
          controller.abort(error);
          reject(error);
        }, requestQueue.timeout);
      });
      try {
        return await Promise.race([deadline, (async () => {
      const response = await fetch(url.pathname + url.search, {
        signal: controller.signal, method, headers, body: body && JSON.stringify(body), keepalive,
        credentials: "same-origin", mode: "same-origin"
      });
      if (controller.signal.aborted) throw controller.signal.reason;
      if (response.ok && response.status === 204) return {};
      const payload = await response.json().catch(() => null);
      if (controller.signal.aborted) throw controller.signal.reason;
      const limited = response.status === 429 || payload?.error_type === "rate_limit";
      const busy = limited || response.status === 503;
      const recognized = payload && typeof payload === "object";
      // A 2xx HTML login/challenge page or damaged JSON must never look like an
      // accepted write: the reading tracker would otherwise acknowledge time
      // the server never stored.
      if (response.ok && !limited && !busy && recognized && !payload?.errors?.length) return payload;
      const messages = {
        401: "请先登录 Linux.do。",
        403: "当前账号无法访问此内容，可能需要登录或获得权限。",
        404: "原站找不到此内容，或当前账号无法访问。"
      };
      const error = new Error(messages[response.status] || payload?.errors?.[0] ||
        (response.ok ? "原站返回了无法识别的响应，请重试。" : "暂时无法读取 Linux.do，请重试。"));
      error.status = limited ? 429 : response.status;
      if (busy) {
        error.retryAfter = retryDelay(response, payload);
        requestQueue.defer(error.retryAfter);
        error.message = requestQueue.busyError().message;
      }
      throw error;
        })()]);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      }
    };
    // A content GET may recover once after the shared deadline. Never replay
    // writes here: only the reading tracker owns unacknowledged timing batches.
    for (let attempt = 0; ; attempt++) {
      try { return await requestQueue.schedule(perform, { signal, priority, background }); }
      catch (error) {
        if (method !== "GET" || background || ![429, 503].includes(error.status) || attempt >= 1) throw error;
      }
    }
  }

  let csrfPromise;
  function prepareCSRF(options = {}) {
    if (!csrfPromise) {
      csrfPromise = request("/session/csrf.json", { ...options, keepalive: true, priority: options.priority ?? 1 }).then(({ csrf }) => {
        if (!csrf) throw new Error("登录状态已失效，请在原站重新登录。");
        return csrf;
      }).catch(error => { csrfPromise = null; throw error; });
    }
    return csrfPromise;
  }

  async function change(path, method, body, options = {}) {
    const csrf = await prepareCSRF(options);
    try {
      return await request(path, { ...options, method, body, csrf });
    } catch (error) {
      if (error.status !== 403) throw error;
      csrfPromise = null;
      return request(path, { ...options, method, body, csrf: await prepareCSRF(options) });
    }
  }

  function visitTopic(id, options = {}) {
    return request(`/t/${Number(id)}.json?track_visit=true`, {
      ...options, priority: 2, background: true,
      headers: { "Discourse-Track-View": "true", "Discourse-Track-View-Topic-Id": String(id) }
    });
  }

  function recordReading(batch, options = {}) {
    // A paused background batch stays with the tracker, not in the content queue.
    if (requestQueue.cooldown()) return Promise.reject(requestQueue.busyError());
    return change("/topics/timings", "POST", batch, { ...options, keepalive: true, priority: 2, background: true });
  }

  async function account() {
    try {
      return (await request("/session/current.json", { priority: 1 })).current_user || null;
    } catch (error) {
      if ([401, 403, 404].includes(error.status)) return null;
      throw error;
    }
  }

  function topicPath(topic, number) {
    const base = `/t/${encodeURIComponent(topic.slug || "topic")}/${Number(topic.id)}`;
    return number > 1 ? `${base}/${Number(number)}` : base;
  }

  function tagInfo(tag) {
    return typeof tag === "string" ? { name: tag, slug: tag } : { ...tag, name: tag.name || tag.text, slug: tag.slug || tag.name || tag.text };
  }

  function categoryPath(category, categories) {
    const parent = categories.get(category.parent_category_id);
    const slug = parent ? `${encodeURIComponent(parent.slug)}/${encodeURIComponent(category.slug)}` : encodeURIComponent(category.slug);
    return `/c/${slug}/${category.id}`;
  }

  function feedPath(view, category, tag, query, categories) {
    if (view === "search") return `/search.json?${new URLSearchParams({ q: query, page: 1 })}`;
    if (view === "following") return "/filter.json?q=in%3Awatching%2Ctracking";
    if (view !== "latest") return `/${view}.json`;
    if (category && tag) return `${jsonPath(categoryPath(category, categories))}?${new URLSearchParams({ tags: tag.name })}`;
    if (category) return jsonPath(categoryPath(category, categories));
    if (tag) return jsonPath(`/tag/${encodeURIComponent(tag.slug)}${tag.id ? "/" + tag.id : ""}`);
    return "/latest.json";
  }

  async function feed(path, signal) {
    const data = await request(path, { signal });
    if (data.topic_list) {
      const users = new Map((data.users || []).map(user => [user.id, user]));
      const rows = data.topic_list.topics.map(topic => ({ ...topic, author: users.get(topic.posters?.[0]?.user_id) }));
      return { rows, tags: data.topic_list.top_tags || [], next: data.topic_list.more_topics_url && jsonPath(data.topic_list.more_topics_url) };
    }

    const search = data.grouped_search_result;
    if (!search) throw new Error("原站返回了无法识别的话题列表。");
    if (search.error) throw new Error(search.error);
    const hits = new Map();
    for (const post of data.posts || []) {
      if (!hits.has(post.topic_id)) hits.set(post.topic_id, post);
    }
    const rows = (data.topics || []).map(topic => ({
      ...topic,
      hit: hits.get(topic.id),
      author: hits.get(topic.id)
    }));
    const next = new URL(path, siteURL);
    next.searchParams.set("page", Number(next.searchParams.get("page") || 1) + 1);
    return { rows, tags: data.tags || [], next: search.more_full_page_results || search.more_posts ? next.pathname + next.search : null };
  }

  async function postsPage(topicId, ids, signal) {
    const params = new URLSearchParams();
    for (const id of ids) params.append("post_ids[]", id);
    return (await request(`/t/${topicId}/posts.json?${params}`, { signal })).post_stream?.posts || [];
  }

  function replyTree(posts) {
    const roots = [];
    const nodes = new Map();
    for (const post of [...posts].sort((a, b) => a.post_number - b.post_number)) {
      if (post.post_number === 1 || nodes.has(post.post_number)) continue;
      const node = { post, children: [] };
      nodes.set(post.post_number, node);
      const parent = nodes.get(post.reply_to_post_number);
      if (parent && parent !== node) parent.children.push(node);
      else roots.push(node);
    }
    return roots;
  }

  function sidebar() {
    const wrappers = [...document.querySelectorAll(".sidebar-section-wrapper, .sidebar-section")];
    return wrappers.filter(section => !wrappers.some(other => other !== section && other.contains(section)))
      .map(section => ({
        name: section.querySelector(".sidebar-section-header-text")?.textContent.trim() || "社区",
        links: [...section.querySelectorAll("a[href]")].map(link => ({
          label: link.querySelector(".sidebar-section-link-content-text")?.textContent.trim() ||
            link.textContent.replace(/[\u200B\uFEFF]/g, "").trim(),
          url: safeURL(link.getAttribute("href"))
        })).filter(link => link.label && link.url)
      })).filter(section => section.links.length);
  }

  const allowed = new Set("P DIV SPAN SMALL SUP SUB B STRONG EM I U S DEL INS MARK BR HR BLOCKQUOTE ASIDE HEADER H1 H2 H3 H4 H5 H6 PRE CODE KBD UL OL LI DL DT DD TABLE THEAD TBODY TFOOT TR TD TH A IMG DETAILS SUMMARY FIGURE FIGCAPTION VIDEO AUDIO SOURCE INPUT".split(" "));
  const discard = new Set("SCRIPT STYLE TEMPLATE NOSCRIPT IFRAME OBJECT EMBED SVG MATH BUTTON FORM SELECT TEXTAREA".split(" "));

  function cooked(html) {
    const template = document.createElement("template");
    template.innerHTML = html || "";
    const result = document.createDocumentFragment();
    function copy(source, parent) {
      if (source.nodeType === Node.TEXT_NODE) {
        parent.append(document.createTextNode(source.textContent));
        return;
      }
      if (source.nodeType !== Node.ELEMENT_NODE || discard.has(source.tagName) || source.namespaceURI !== "http://www.w3.org/1999/xhtml") return;
      if (!allowed.has(source.tagName)) {
        source.childNodes.forEach(child => copy(child, parent));
        return;
      }
      const target = document.createElement(source.tagName.toLowerCase());
      if (source.title) target.title = source.title;
      if (source.matches("a")) {
        const href = safeURL(source.getAttribute("href"));
        if (href) target.href = href.href;
        target.target = "_blank";
        target.rel = "noopener noreferrer";
      }
      if (source.matches("img,video,audio,source")) {
        const media = safeURL(source.getAttribute("src") || source.getAttribute("data-src"));
        if (media?.protocol === "https:") target.src = media.href;
        else if (source.matches("img,source")) return;
        if (source.matches("img")) {
          target.alt = source.alt;
          target.loading = "lazy";
          target.referrerPolicy = "no-referrer";
          if (source.classList.contains("emoji")) target.className = "emoji";
        }
        if (source.matches("video,audio")) {
          target.controls = true;
          target.preload = "none";
        }
      }
      if (source.matches("input")) {
        if (source.type !== "checkbox") return;
        target.type = "checkbox";
        target.disabled = true;
        target.checked = source.hasAttribute("checked");
      }
      if (source.matches("td,th")) {
        target.colSpan = Math.min(source.colSpan, 100);
        target.rowSpan = Math.min(source.rowSpan, 100);
      }
      if (source.matches("ol")) target.start = source.start;
      if (source.matches("details")) target.open = source.open;
      source.childNodes.forEach(child => copy(child, target));
      parent.append(target);
    }
    template.content.childNodes.forEach(child => copy(child, result));
    return result;
  }

  globalThis.LDForum = {
    siteURL, safeURL, dateLabel, RequestQueue, requestQueue, request, change, account, topicPath, tagInfo, categoryPath,
    prepareCSRF, visitTopic, recordReading,
    feedPath, feed, postsPage, replyTree, sidebar, cooked
  };
})();
