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

  // Diagnostics are local and categorical: never retain a URL, topic/post id,
  // search query, token, request body, account data, or server error text.
  const sourceLabels = Object.freeze({
    presence: "正在回复状态", liveTopic: "实时话题补读", livePosts: "实时楼层更新", live: "实时更新",
    topic: "话题详情", posts: "回复分页", feed: "话题列表", search: "搜索", metadata: "社区元数据",
    account: "登录状态", csrf: "操作准备", bookmark: "书签操作", notification: "话题通知设置",
    draft: "原版草稿读取", composer: "原版编辑器", read: "其他读取", write: "其他操作"
  });
  const allowedSources = new Set(Object.values(sourceLabels));
  const safeSource = value => Object.hasOwn(sourceLabels, value) ? sourceLabels[value] : allowedSources.has(value) ? value : null;
  const safeMethod = value => ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(value) ? value : "GET";
  const safeStatus = value => Number.isInteger(value) && value >= 100 && value <= 599 ? value : 0;
  function inferSource(url, method) {
    const path = url.pathname;
    if (path === "/presence/get.json") return sourceLabels.presence;
    if (/^\/t\/[^/]+\/posts\.json$/.test(path)) return sourceLabels.posts;
    if (/^\/t\/(?:[^/]+\/)*[^/]+\.json$/.test(path)) return sourceLabels.topic;
    if (/^\/t\/[^/]+\/notifications(?:\.json)?$/.test(path)) return sourceLabels.notification;
    if (/^\/bookmarks(?:\/[^/]+)?\.json$/.test(path)) return sourceLabels.bookmark;
    if (path === "/session/csrf.json") return sourceLabels.csrf;
    if (path === "/session/current.json") return sourceLabels.account;
    if (["/site.json", "/tags.json"].includes(path)) return sourceLabels.metadata;
    if (path === "/search.json") return sourceLabels.search;
    if (/^\/(?:latest|new|unread|top|hot|filter)\.json$/.test(path) || /^\/(?:c|tag)\//.test(path)) return sourceLabels.feed;
    return method === "GET" ? sourceLabels.read : sourceLabels.write;
  }

  // Every reader request shares one lane. A server cooldown is an explicit
  // error, never a long invisible wait behind another pane's loading indicator.
  class RequestQueue {
    constructor({ now = () => Date.now(), wait = ms => new Promise(resolve => setTimeout(resolve, ms)), interval = 2000, timeout = 15000, storage, locks } = {}) {
      Object.assign(this, { now, wait, interval, timeout });
      try { this.storage = storage === undefined ? globalThis.localStorage : storage; } catch {}
      try { this.locks = locks === undefined ? globalThis.navigator?.locks : locks; } catch {}
      this.pending = [];
      this.running = false;
      this.lastStart = -Infinity;
      this.retryAt = 0;
      this.recentRequests = [];
      this.retryInfo = null;
      this.rateInterval = 0;
      this.rateUntil = 0;
    }

    diagnostics() { return this.recentRequests.map(entry => ({ ...entry })); }

    currentInterval() {
      const now = this.now();
      if (this.rateUntil <= now) { this.rateInterval = 0; this.rateUntil = 0; }
      try {
        const stored = JSON.parse(this.storage?.getItem("linux-do-reader-pacing") || "null");
        if (stored && [4000, 8000].includes(stored.interval) && Number.isFinite(stored.expiresAt) &&
            stored.expiresAt > now && stored.expiresAt <= now + 600000 &&
            (stored.interval > this.rateInterval || stored.interval === this.rateInterval && stored.expiresAt > this.rateUntil)) {
          this.rateInterval = stored.interval;
          this.rateUntil = stored.expiresAt;
        }
      } catch {}
      return Math.max(this.interval, this.rateInterval);
    }

    observeRateLimit() {
      // Only a real HTTP/JSON or native 429 reaches here. Rejected clicks do
      // not amplify the penalty or refresh its ten-minute lifetime.
      this.rateInterval = Math.min(8000, Math.max(4000, this.currentInterval() * 2));
      this.rateUntil = this.now() + 600000;
      try { this.storage?.setItem("linux-do-reader-pacing", JSON.stringify({ interval: this.rateInterval, expiresAt: this.rateUntil })); } catch {}
    }

    startDelay() {
      let shared = -Infinity;
      try {
        const raw = this.storage?.getItem("linux-do-reader-last-start");
        const value = raw == null || raw === "" ? NaN : Number(raw);
        if (Number.isFinite(value) && value >= 0 && value <= this.now()) shared = value;
      } catch {}
      return Math.max(0, Math.max(this.lastStart, shared) + this.currentInterval() - this.now());
    }

    reserveStart() {
      // A lock covers only this synchronous check/commit, not a delay or HTTP.
      // Pick after acquiring it so fresh content can still overtake metadata.
      this.rejectCooling();
      if (!this.pending.length) return null;
      const delay = this.startDelay();
      if (delay > 0) return { delay };
      this.pending.sort((a, b) => a.priority - b.priority);
      while (this.pending.length) {
        const entry = this.pending.shift();
        entry.signal?.removeEventListener("abort", entry.abort);
        if (entry.signal?.aborted) {
          entry.reject(entry.signal.reason || new DOMException("Aborted", "AbortError"));
          continue;
        }
        this.lastStart = this.now();
        try { this.storage?.setItem("linux-do-reader-last-start", String(this.lastStart)); } catch {}
        return { entry };
      }
      return null;
    }

    takeStart() {
      if (this.locks?.request) {
        try {
          return this.locks.request("linux-do-reader-http-start", () => this.reserveStart()).catch(() => {
            this.locks = null;
            return this.reserveStart();
          });
        } catch { this.locks = null; }
      }
      // Storage alone cannot make the read/commit atomic across processes;
      // still coordinate best-effort when Web Locks are unavailable.
      return this.reserveStart();
    }

    record({ requestSource, source, method = "GET", background = false } = {}) {
      const entry = { requestSource: safeSource(requestSource || source) || sourceLabels.read,
        method: safeMethod(method), background: !!background, startedAt: this.now(), completedAt: null, status: null };
      this.recentRequests.push(entry);
      if (this.recentRequests.length > 10) this.recentRequests.shift();
      return entry;
    }

    cooldown() {
      const now = this.now();
      if (this.retryAt <= now) { this.retryAt = 0; this.retryInfo = null; }
      try {
        const stored = Number(this.storage?.getItem("linux-do-reader-retry-at"));
        if (Number.isFinite(stored) && stored > now) this.retryAt = Math.max(this.retryAt, stored);
        if (this.retryInfo?.retryAt !== this.retryAt) this.retryInfo = null;
        const info = JSON.parse(this.storage?.getItem("linux-do-reader-retry-info") || "null");
        if (info && Number.isFinite(info.retryAt) && info.retryAt > now && info.retryAt === this.retryAt) {
          this.retryInfo = { requestSource: safeSource(info.requestSource), method: safeMethod(info.method),
            status: safeStatus(info.status), retryAt: info.retryAt };
        }
      } catch {}
      return Math.max(0, this.retryAt - now);
    }

    defer(ms, detail = {}) {
      if (!Number.isFinite(ms) || ms < 0) return;
      this.cooldown();
      if (detail.status === 429) { this.observeRateLimit(); ms = Math.max(5000, ms); }
      const retryAt = this.now() + ms;
      if (retryAt >= this.retryAt) {
        this.retryInfo = { requestSource: safeSource(detail.requestSource || detail.source), method: safeMethod(detail.method),
          status: safeStatus(detail.status), retryAt };
      }
      this.retryAt = Math.max(this.retryAt, retryAt);
      // Share only a deadline and whitelisted operation metadata with other
      // tabs, not the diagnostic history or any account/content data.
      try {
        this.storage?.setItem("linux-do-reader-retry-at", String(this.retryAt));
        this.storage?.setItem("linux-do-reader-retry-info", JSON.stringify(this.retryInfo));
      } catch {}
      if (["draft", "composer"].includes(detail.source)) {
        const entry = this.record(detail);
        entry.completedAt = this.now();
        entry.status = safeStatus(detail.status);
      }
      this.rejectCooling();
    }

    busyError(requestSource) {
      const retryAfter = this.cooldown();
      const info = this.retryInfo?.retryAt === this.retryAt ? this.retryInfo : null;
      const source = info?.requestSource || null;
      const status = [429, 502, 503, 504].includes(info?.status) ? info.status : 0;
      const label = source || "来源未记录，可能来自其他标签页";
      const reason = status === 429 ? `此前限流后的等待中（${label}）`
        : [502, 503, 504].includes(status) ? `原站暂时不可用（${label}，HTTP ${status}）`
          : `请求暂缓（${label}，等待原因未确认）`;
      const error = new Error(retryAfter > 0 ? `${reason}；本次未向原站重新请求，请 ${Math.ceil(retryAfter / 1000)} 秒后重试。`
        : "请求等待已结束，请重试。");
      Object.assign(error, { status, retryAfter, retryAt: this.now() + retryAfter, recoverable: true,
        requestSource: source, blockedRequestSource: safeSource(requestSource) });
      return error;
    }

    rejectCooling() {
      if (!this.cooldown()) return;
      for (const entry of this.pending.splice(0)) {
        entry.signal?.removeEventListener("abort", entry.abort);
        entry.reject(this.busyError(entry.requestSource));
      }
    }

    schedule(task, { signal, priority = 0, background = false, requestSource, method = "GET" } = {}) {
      if (signal?.aborted) return Promise.reject(signal.reason || new DOMException("Aborted", "AbortError"));
      if (this.cooldown()) return Promise.reject(this.busyError(requestSource));
      return new Promise((resolve, reject) => {
        const entry = { task, signal, priority, background, requestSource, method, resolve, reject };
        entry.abort = () => {
          const index = this.pending.indexOf(entry);
          if (index < 0) return;
          this.pending.splice(index, 1);
          signal?.removeEventListener("abort", entry.abort);
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
          this.rejectCooling();
          if (!this.pending.length) break;
          const delay = this.startDelay();
          if (delay > 0) { await this.wait(delay); continue; }
          const start = this.takeStart();
          const reservation = typeof start?.then === "function" ? await start : start;
          if (reservation?.delay > 0) { await this.wait(reservation.delay); continue; }
          if (!reservation?.entry) continue;
          const { entry } = reservation;
          const record = this.record(entry);
          try { entry.resolve(await entry.task(status => { record.status = safeStatus(status); })); record.status ??= 200; }
          catch (error) { record.status = safeStatus(error.status); entry.reject(error); }
          finally { record.completedAt = this.now(); }
        }
      } finally {
        this.running = false;
      }
    }
  }

  const requestQueue = new RequestQueue();

  function retryDelay(response, payload, fallback = 5000) {
    const header = response.headers?.get("Retry-After")?.trim();
    const seconds = header ? Number(header) : NaN;
    const date = header ? Date.parse(header) : NaN;
    // A server Date header makes HTTP-date deadlines robust to client clock skew.
    const serverDate = Date.parse(response.headers?.get("Date"));
    const origin = Number.isFinite(serverDate) ? serverDate : Date.now();
    const headerDelay = Number.isFinite(seconds) ? seconds >= 0 ? seconds * 1000 : NaN
      : Number.isFinite(date) ? Math.max(0, date - origin) : NaN;
    const delays = [headerDelay, payload?.extras?.wait_seconds, payload?.wait_seconds]
      .map((value, index) => index === 0 ? value : value == null || value === "" ? NaN : Number(value) * 1000)
      .filter(value => Number.isFinite(value) && value >= 0);
    return delays.length ? Math.max(...delays) : fallback;
  }

  async function request(path, { signal, method = "GET", body, csrf, keepalive = false, headers: extraHeaders, priority = 0, background = false, requestSource } = {}) {
    const url = safeURL(path);
    if (url?.origin !== siteURL) throw new Error("原站返回了无效的地址。");
    method = method.toUpperCase();
    requestSource = safeSource(requestSource) || inferSource(url, method);
    const headers = { Accept: "application/json", "X-Requested-With": "XMLHttpRequest", ...extraHeaders };
    if (csrf) headers["X-CSRF-Token"] = csrf;
    if (body) headers["Content-Type"] = "application/json";
    const perform = async reportStatus => {
      const controller = new AbortController();
      let timer, rejectAbort;
      const aborted = new Promise((resolve, reject) => { rejectAbort = reject; });
      const abort = () => {
        const error = signal.reason || new DOMException("Aborted", "AbortError");
        controller.abort(error);
        rejectAbort(error);
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      const deadline = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error("原站响应超时，请重试。");
          Object.assign(error, { name: "TimeoutError", recoverable: true });
          controller.abort(error);
          reject(error);
        }, requestQueue.timeout);
      });
      try {
        return await Promise.race([deadline, aborted, (async () => {
          if (controller.signal.aborted) throw controller.signal.reason;
          const response = await fetch(url.pathname + url.search, {
            signal: controller.signal, method, headers, body: body && JSON.stringify(body), keepalive,
            credentials: "same-origin", mode: "same-origin"
          });
          if (controller.signal.aborted) throw controller.signal.reason;
          reportStatus(response.status);
          if (response.ok && response.status === 204) return {};
          const payload = await response.json().catch(() => null);
          if (controller.signal.aborted) throw controller.signal.reason;
          const limited = response.status === 429 || payload?.error_type === "rate_limit";
          const retryAfter = retryDelay(response, payload, limited ? 5000 : null);
          const cooling = limited || [502, 503, 504].includes(response.status) && retryAfter !== null;
          const recognized = payload && typeof payload === "object" && !Array.isArray(payload);
          if (response.ok && !limited && recognized && !payload?.errors?.length) return payload;
          const messages = {
            401: "请先登录 Linux.do。",
            403: "当前账号无法访问此内容，可能需要登录或获得权限。",
            404: "原站找不到此内容，或当前账号无法访问。"
          };
          const error = new Error(messages[response.status] || payload?.errors?.[0] ||
            (response.ok ? "原站返回了无法识别的响应，请重试。" : "暂时无法读取 Linux.do，请重试。"));
          error.status = limited ? 429 : response.status;
          error.requestSource = requestSource;
          error.recoverable = cooling || [502, 503, 504].includes(response.status);
          if (cooling) {
            requestQueue.defer(retryAfter, { requestSource, method, status: error.status });
            error.retryAfter = requestQueue.cooldown();
            error.retryAt = requestQueue.now() + error.retryAfter;
            error.message = limited
              ? `原站返回限流（${requestSource}，${response.status === 429 ? "HTTP 429" : "JSON rate_limit"}），已暂停请求，请 ${Math.ceil(error.retryAfter / 1000)} 秒后重试。`
              : `原站暂时不可用（${requestSource}，HTTP ${response.status}），请 ${Math.ceil(error.retryAfter / 1000)} 秒后重试。`;
          }
          throw error;
        })()]);
      } catch (error) {
        if (error.name === "TypeError") error.recoverable = true;
        error.requestSource = requestSource;
        throw error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      }
    };
    // Only a short transient GET gets one paced recovery. Server cooldowns are
    // surfaced immediately; writes (including CSRF failures) are never replayed.
    for (let attempt = 0; ; attempt++) {
      try { return await requestQueue.schedule(perform, { signal, priority, background, requestSource, method }); }
      catch (error) {
        if (method !== "GET" || background || signal?.aborted || error.retryAfter != null || attempt >= 1 ||
            !(error.name === "TypeError" || [502, 503, 504].includes(error.status))) throw error;
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
      // Refresh the token for the next explicit action, never replay a write.
      if (error.status === 403) csrfPromise = null;
      throw error;
    }
  }

  async function account(options = {}) {
    try {
      return (await request("/session/current.json", { priority: 1, ...options })).current_user || null;
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

  async function feed(path, signal, options = {}) {
    const data = await request(path, { ...options, signal });
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

  async function postsPage(topicId, ids, signal, options = {}) {
    const params = new URLSearchParams();
    for (const id of ids) params.append("post_ids[]", id);
    const data = await request(`/t/${topicId}/posts.json?${params}`, { ...options, signal });
    if (!Array.isArray(data.post_stream?.posts)) throw new Error("原站未返回有效的回复分页，请重试。");
    return data.post_stream.posts;
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

  const previewExcluded = ".emoji, .emoji-custom, .avatar, .avatar-wrapper, .onebox, .onebox-body, .onebox-header, .onebox-avatar, .onebox-icon, .site-icon, .favicon, .logo";

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
          if (source.classList.contains("emoji") || source.classList.contains("emoji-custom")) target.className = "emoji";
          // Recreate only our own metadata; never copy source data-* attributes.
          // Icons and oneboxes keep their original link behavior, and ordinary
          // images inside non-image links must not hijack navigation.
          const link = source.closest("a");
          const original = safeURL(link?.getAttribute("href"));
          const lightbox = link?.classList.contains("lightbox");
          const imageLink = original?.protocol === "https:" &&
            (lightbox || original.href === media.href || /\.(?:avif|gif|jpe?g|png|svg|webp)$/i.test(original.pathname));
          if (!source.closest(previewExcluded) && (!link || imageLink)) {
            target.dataset.ldImageSrc = imageLink ? original.href : media.href;
          }
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
      if (source.matches("a") && target.querySelector("img[data-ld-image-src]")) {
        const original = safeURL(source.getAttribute("href"));
        if (original?.protocol === "https:") target.dataset.ldImageLink = original.href;
      }
      if (source.matches("img") && target.dataset.ldImageSrc && !source.closest("a")) {
        // A real anchor preserves native Ctrl/Cmd/Shift-click, middle click,
        // keyboard access, and the context-menu action for the original image.
        const link = document.createElement("a");
        link.href = target.dataset.ldImageSrc;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.dataset.ldImageLink = target.dataset.ldImageSrc;
        link.title = "点击在当前页面预览图片；按 Ctrl/Cmd 点击打开原图";
        link.append(target);
        parent.append(link);
      } else parent.append(target);
    }
    template.content.childNodes.forEach(child => copy(child, result));
    return result;
  }

  globalThis.LDForum = {
    siteURL, safeURL, dateLabel, RequestQueue, requestQueue, request, change, account, topicPath, tagInfo, categoryPath,
    prepareCSRF,
    feedPath, feed, postsPage, sidebar, cooked
  };
})();
