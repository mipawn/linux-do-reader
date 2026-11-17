(() => {
  if (globalThis.LDReaderReady) return;
  globalThis.LDReaderReady = true;
  const forum = globalThis.LDForum;
  const reading = globalThis.LDReading;
  const extension = globalThis.chrome?.runtime;
  const asset = (name) => extension?.getURL ? extension.getURL(name) : name;

  const modes = new Map([
    ["latest", "最新"], ["new", "新话题"], ["unseen", "未读"], ["hot", "热门"],
    ["top", "排行榜"], ["posted", "我参与的"], ["read", "已读"]
  ]);
  const privateModes = new Set(["new", "unseen", "posted", "read", "bookmarks", "following"]);
  const levels = new Map([[3, "关注"], [2, "跟踪"], [1, "常规"], [0, "静音"]]);
  const themes = new Map([["site", "跟随 Linux.do"], ["light", "浅色"], ["dark", "深色"]]);
  const number = new Intl.NumberFormat("zh-CN", { notation: "compact" });
  const state = {
    view: "latest", category: null, tag: null, query: "", initialFeedPath: null, next: null, listGeneration: 0, rows: [], categories: new Map(), tags: new Map(),
    user: undefined, selected: null, detail: null, openMenu: null, sidebarMenu: null, onScreen: false
  };
  const outletClass = "ld-reader-active";
  let host, root, listRequest, topicRequest, outlet, modeSwitch, nativeHeader, headerObserver, listPager, replyPager;
  let pendingOpen = false, readerMode = true, originalLocation, originalPosition, contextLoaded = false;
  let lastActivity = performance.now(), accountRequest, accountRetryAt = 0;
  const readProgress = new Map();
  let readingSyncEnabled = false;
  try { readingSyncEnabled = localStorage.getItem("linux-do-reader-sync") === "true"; } catch {}
  let syncController = new AbortController();
  const tracker = new reading.Tracker({
    enabled: readingSyncEnabled,
    send: batch => state.user && readingSyncEnabled
      ? forum.recordReading(batch, { signal: syncController.signal })
      : Promise.reject(new Error("阅读同步已关闭。")),
    visit: id => forum.visitTopic(id, { signal: syncController.signal }),
    acknowledge: acknowledgeReading,
    report: reportReading
  });
  let headerLogo;
  const $ = (selector) => root.querySelector(selector);

  function acknowledgeReading(topicId, floors) {
    if (!state.user || !floors.length) return;
    const previous = readProgress.get(topicId) || 0;
    const lastRead = Math.max(previous, ...floors);
    readProgress.set(topicId, lastRead);
    let changed = false;
    for (const topic of state.rows.filter(row => row.id === topicId)) {
      changed = reading.markRead(topic, lastRead) || changed;
    }
    if (changed && root && state.onScreen) renderList();
    if (lastRead > previous) document.dispatchEvent(new CustomEvent("linux-do-reader:read", {
      detail: JSON.stringify({ topicId, lastRead })
    }));
  }

  function reportReading({ topicId, phase, floors }) {
    if (!state.user || state.detail?.data.id !== topicId) return;
    state.detail.sync = { phase, floors };
    updateReadingStatus();
  }

  function updateReadingStatus() {
    const node = root && $("#reading-sync");
    if (!node) return;
    const sync = state.detail?.sync;
    node.textContent = !readingSyncEnabled ? "阅读同步：关（点击开启）" : !state.user ? "登录后同步阅读" :
      sync?.phase === "paused" ? "同步已暂停，优先加载内容" : sync?.phase === "failed" ? "阅读同步失败，稍后重试" :
      sync?.phase === "sending" ? "正在同步阅读…" : sync?.phase === "synced" ? `已同步阅读 #${Math.max(...sync.floors)}` : "阅读同步：开（30秒批量）";
    node.title = readingSyncEnabled
      ? "点击关闭阅读同步。仅按前台可见楼层累计，每30秒合并提交；服务器确认才更新已读标记。限流时暂停同步，优先加载内容。"
      : "点击开启原站阅读进度同步。当前不发送阅读时间或额外浏览登记，原站已读标记不会由阅读器更新。";
    node.setAttribute("aria-pressed", String(readingSyncEnabled));
    node.classList.toggle("error", readingSyncEnabled && sync?.phase === "failed");
  }

  function toggleReadingSync() {
    readingSyncEnabled = !readingSyncEnabled;
    syncController.abort();
    syncController = new AbortController();
    tracker.setEnabled(readingSyncEnabled);
    if (readingSyncEnabled && state.detail) tracker.start(state.detail.data.id);
    if (state.detail) state.detail.sync = null;
    try { localStorage.setItem("linux-do-reader-sync", String(readingSyncEnabled)); } catch {}
    updateReadingStatus();
    notify(readingSyncEnabled ? "已开启30秒批量阅读同步" : "已关闭阅读同步，未发送的时间已丢弃");
  }

  function sampleReading() {
    const pane = root && $("#read-scroll");
    const blocked = state.openMenu || state.sidebarMenu || [...document.querySelectorAll(".d-modal, .modal-backdrop, .fk-d-menu, .chat-drawer")].some(node => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== "hidden";
    });
    const active = readingSyncEnabled && state.user && state.onScreen && !blocked && !document.hidden && document.hasFocus() &&
      performance.now() - lastActivity < 180000 && pane?.getBoundingClientRect().width > 0;
    tracker.sample(active ? reading.visiblePosts(root, pane) : [], !!active);
  }

  function element(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content != null) node.append(content);
    return node;
  }

  function icon(name) {
    const node = element("i", `ic ic-${name}`);
    node.setAttribute("aria-hidden", "true");
    return node;
  }

  function button(label, action, { symbol, className = "", iconOnly = false, value } = {}) {
    const node = element("button", className);
    node.type = "button";
    node.dataset.action = action;
    if (value !== undefined) node.dataset.value = value;
    if (symbol) node.append(icon(symbol));
    if (iconOnly) {
      node.setAttribute("aria-label", label);
      node.title = label;
    } else node.append(label);
    return node;
  }

  function anchor(label, path, className = "", symbol) {
    const node = element("a", className);
    const url = forum.safeURL(path);
    if (url) node.href = url.href;
    node.target = "_blank";
    node.rel = "noopener noreferrer";
    if (symbol) node.append(icon(symbol));
    node.append(label);
    return node;
  }

  function add(parent, ...children) {
    parent.append(...children.filter(child => child != null));
    return parent;
  }

  function date(value, compact = false) {
    const node = element("time", "", forum.dateLabel(value, compact));
    if (value && Number.isFinite(new Date(value).getTime())) {
      node.dateTime = value;
      node.title = forum.dateLabel(value);
    }
    return node;
  }

  function avatar(user, size = 24) {
    const wrap = element("span", "avatar");
    wrap.style.setProperty("--avatar", size + "px");
    const initials = (user?.display_username || user?.username || "?").slice(0, 1).toUpperCase();
    wrap.textContent = initials;
    let color = 0;
    for (const char of user?.username || "") color = (color + char.charCodeAt(0) * 37) % 360;
    wrap.style.setProperty("--hue", color);
    const url = forum.safeURL(user?.avatar_template?.replace("{size}", String(size * 2)));
    if (url?.protocol === "https:") {
      const image = element("img");
      image.alt = "";
      image.width = size;
      image.height = size;
      image.referrerPolicy = "no-referrer";
      image.loading = "lazy";
      image.addEventListener("error", () => image.remove(), { once: true });
      image.src = url.href;
      wrap.append(image);
    }
    return wrap;
  }

  function categoryPill(category, interactive = true) {
    if (!category) return null;
    const node = interactive
      ? button(category.name, "category", { className: "category", value: category.id })
      : element("span", "category", category.name);
    const dot = element("i", "category-dot");
    if (/^[a-f\d]{6}$/i.test(category.color)) dot.style.setProperty("--dot", "#" + category.color);
    node.prepend(dot);
    return node;
  }

  function tagPill(raw, interactive = true) {
    const tag = forum.tagInfo(raw);
    if (!tag.name) return null;
    const node = interactive ? button(tag.name, "tag", { className: "tag" }) : element("span", "tag", tag.name);
    if (interactive) node._readerTag = tag;
    return node;
  }

  function stat(symbol, label, count) {
    if (count == null) return null;
    const node = add(element("span", "stat"), icon(symbol), element("span", "", number.format(count)));
    node.title = label + " " + count;
    node.setAttribute("aria-label", node.title);
    return node;
  }

  function mount() {
    host = element("div");
    host.id = "linux-do-reader-extension";
    host.hidden = true;
    root = host.attachShadow({ mode: "open" });
    const style = element("link");
    style.rel = "stylesheet";
    style.href = asset("reader.css");
    root.append(style);
    const shell = element("div", "shell");
    shell.innerHTML = `
      <header class="header">
        <div class="mainbar">
          <nav class="mainnav" aria-label="顶部导航">
            <div class="nav-group primary-nav"></div>
            <div class="nav-group view-nav" role="group" aria-label="列表与导航"></div>
          </nav>
          <div class="header-tools">
            <form id="search-form" role="search">
              <label class="search-label"><span class="search-icon"></span><input id="query" autocomplete="off" type="search" maxlength="160" placeholder="搜索话题" aria-label="搜索话题"><kbd aria-hidden="true">/</kbd></label>
            </form>
            <div id="header-actions"></div>
          </div>
        </div>
      </header>
      <div class="workspace">
        <section class="list-pane" aria-label="话题列表">
          <div class="list-header"><h1 id="list-title">最新话题</h1><div id="list-tools"></div></div>
          <div id="list-scroll" class="list-scroll"><div id="rows"></div><div id="list-footer"></div></div>
        </section>
        <section id="reading-pane" class="reading-pane" aria-label="阅读区">
          <div id="reading-toolbar" class="reading-toolbar"><div id="reading-back"></div><div id="reading-actions"></div></div>
          <div id="read-scroll" class="read-scroll" tabindex="0" aria-label="话题与回复">
            <div id="reading" class="reading"></div>
          </div>
        </section>
      </div>
      <div id="menu" class="popup" hidden></div>
      <div id="toast" class="toast" role="status" hidden></div>`;
    root.append(shell);
    try {
      const theme = localStorage.getItem("linux-do-reader-theme");
      if (theme === "light" || theme === "dark") host.dataset.theme = theme;
    } catch {}
    $(".primary-nav").append(
      button("话题", "mode", { className: "nav-link", value: "latest", symbol: "list" }),
      button("收藏", "mode", { className: "nav-link", value: "bookmarks", symbol: "bookmark" }),
      button("关注", "mode", { className: "nav-link", value: "following", symbol: "bell" })
    );
    const siteNavigation = button("原站导航", "sidebar", { className: "nav-link menu-toggle" });
    $(".view-nav").append(
      button("最新", "menu", { className: "nav-link menu-toggle", value: "feeds" }),
      button("筛选", "menu", { className: "nav-link menu-toggle", value: "filters" }),
      siteNavigation
    );
    for (const control of $(".view-nav").children) control.setAttribute("aria-expanded", "false");
    $(".search-icon").append(icon("search"));
    const themeToggle = button("配色", "menu", { className: "filter-button theme-toggle menu-toggle", symbol: "sun", value: "theme" });
    themeToggle.setAttribute("aria-expanded", "false");
    $("#header-actions").append(themeToggle, button("发帖", "new-topic", { className: "new-topic", symbol: "plus" }));
    describeTheme();
    $("#list-tools").append(button("刷新话题", "refresh", { className: "quiet-icon", symbol: "refresh", iconOnly: true }));
    $("#reading-back").append(
      button("返回列表", "back", { className: "mobile-back", symbol: "back" }),
      button("上一篇话题", "step", { className: "quiet-icon", symbol: "up", iconOnly: true, value: "-1" }),
      button("下一篇话题", "step", { className: "quiet-icon", symbol: "down", iconOnly: true, value: "1" })
    );
    root.addEventListener("click", clicked);
    root.addEventListener("keydown", keydown);
    listPager = new globalThis.LDScroll.Pager({
      viewport: $("#list-scroll"),
      canLoad: () => state.onScreen && !state.listBusy && !state.listError && !!state.next,
      getKey: () => `${state.listGeneration}:${state.view}:${state.category?.id || ""}:${state.tag?.slug || ""}:${state.query}:${state.initialFeedPath || ""}:${state.next}`,
      load: () => loadList(true)
    });
    root.addEventListener("submit", event => {
      if (event.target.id !== "search-form") return;
      event.preventDefault();
      const query = $("#query").value.trim();
      if (query) switchFeed("search", null, null, query);
      else if (state.view === "search") switchFeed("latest");
    });
  }

  function renderFilters() {
    for (const item of root.querySelectorAll(".primary-nav .nav-link")) {
      const active = item.dataset.value === state.view || (item.dataset.value === "latest" && !["bookmarks", "following"].includes(state.view));
      item.classList.toggle("active", active);
      item.setAttribute("aria-pressed", String(active));
    }
    const list = $('[data-value="feeds"]');
    list.textContent = modes.get(state.view) || "列表";
    list.setAttribute("aria-label", "话题列表 · " + list.textContent);
    const filter = $('[data-value="filters"]');
    const filters = [state.category?.name, state.tag?.name].filter(Boolean);
    filter.classList.toggle("filtered", filters.length > 0);
    filter.title = filters.length ? "筛选 · " + filters.join(" · ") : "筛选类别或标签";
    const title = {
      latest: "最新话题", new: "新话题", unseen: "未读话题", hot: "热门话题", top: "话题排行榜",
      bookmarks: "我的收藏", following: "我的关注", search: "搜索结果", posted: "我参与的话题", read: "已读话题"
    }[state.view];
    $("#list-title").textContent = [state.category?.name, state.tag?.name].filter(Boolean).join(" / ") || title;
    $("#query").value = state.query;
  }

  function topicRow(topic) {
    const selected = state.selected?.id === topic.id;
    const row = element("article", "topic-row" + (selected ? " selected" : ""));
    const summary = button("", "topic", { className: "topic-select", value: topic.id });
    summary.setAttribute("aria-current", selected ? "true" : "false");
    const marker = topic.unseen ? element("span", "unseen-dot") : null;
    if (marker) marker.title = "未读话题";
    const pin = topic.pinned || topic.pinned_globally ? element("span", "row-pin", "置顶") : null;
    if (pin) pin.title = "置顶，不表示未读";
    const title = add(element("span", "row-title"), marker, pin, element("span", "", topic.title));
    const chips = add(element("span", "chips"), categoryPill(state.categories.get(topic.category_id), false),
      ...(topic.tags || []).slice(0, 3).map(tag => tagPill(tag, false)));
    const author = topic.author;
    const person = add(element("span", "person"), avatar(author, 18),
      element("span", "", author?.username || "原站用户"),
      Number.isInteger(author?.trust_level) ? element("small", "level", "L" + author.trust_level) : null);
    const created = topic.hit?.created_at || topic.last_posted_at || topic.created_at;
    const clock = date(created, true);
    clock.title = (topic.hit ? "搜索命中时间 " : "最后活动 ") + forum.dateLabel(created);
    const metrics = add(element("span", "metrics"), stat("comment", "回复", topic.posts_count == null ? topic.reply_count : Math.max(0, topic.posts_count - 1)),
      stat("eye", "浏览", topic.views), clock);
    summary.append(title, chips, add(element("span", "row-meta"), person, metrics));
    row.append(summary);
    return row;
  }

  function status(message, action, label = "重试") {
    return add(element("div", "status"), element("p", "", message), action && button(label, action, { className: "secondary-button" }));
  }

  function renderList() {
    const rows = $("#rows");
    const footer = $("#list-footer");
    const scroll = $("#list-scroll");
    const position = scroll.scrollTop;
    const focusedTopic = root.activeElement?.matches('.topic-select') && root.activeElement.dataset.value;
    rows.replaceChildren(...state.rows.map(topicRow));
    footer.replaceChildren();
    if (state.listError) {
      if (privateModes.has(state.view) && state.user === null) {
        footer.append(add(status("登录后即可查看这个列表。"), anchor("前往 Linux.do 登录", "/login", "secondary-button", "out")));
      } else footer.append(status(state.listError, state.rows.length ? "more-topics" : "refresh"));
    } else if (state.listBusy) footer.append(status("正在加载话题…"));
    else if (!state.rows.length) {
      const message = state.view === "search" ? "原站未找到匹配的话题。" :
        state.view === "following" ? "你关注或跟踪的话题会显示在这里。" :
        state.view === "bookmarks" ? "收藏的话题会显示在这里。" : "这个列表暂时没有话题。";
      footer.append(status(message));
    } else if (state.next) footer.append(add(element("span", "", "滚动到底部自动加载"), button("手动加载更多", "more-topics", { className: "secondary-button", symbol: "down" })));
    scroll.scrollTop = position;
    if (focusedTopic) $(`.topic-select[data-value="${focusedTopic}"]`)?.focus({ preventScroll: true });
    updateSteps();
    listPager?.check();
  }

  async function loadList(append = false, keepTopic = false) {
    if (append && (!state.next || state.listBusy)) return;
    if (!append) {
      state.listGeneration++;
      listPager?.reset();
    }
    listRequest?.abort();
    const controller = new AbortController();
    listRequest = controller;
    const path = append ? state.next : state.initialFeedPath || forum.feedPath(state.view, state.category, state.tag, state.query, state.categories);
    state.listBusy = true;
    state.listError = null;
    if (!append && !keepTopic) {
      state.rows = [];
      state.next = null;
      $("#list-scroll").scrollTop = 0;
      clearTopic();
    }
    renderList();
    try {
      if (privateModes.has(state.view) && state.user === null) throw new Error("请先登录 Linux.do。");
      const data = await forum.feed(path, controller.signal);
      if (controller.signal.aborted) return;
      const unique = new Map((append ? state.rows : []).map(row => [row.id, row]));
      for (const row of data.rows) {
        const lastRead = readProgress.get(row.id);
        if (lastRead) reading.markRead(row, lastRead);
        unique.set(row.id, row);
      }
      state.rows = [...unique.values()];
      state.next = data.next === path ? null : data.next;
      rememberTags(data.tags);
      if (!state.selected && state.rows.length && host.clientWidth > 760) selectTopic(state.rows[0], false);
    } catch (error) {
      if (!controller.signal.aborted) state.listError = error.message;
    } finally {
      if (!controller.signal.aborted) {
        state.listBusy = false;
        renderList();
      }
    }
  }

  function switchFeed(view, category = null, tag = null, query = "") {
    Object.assign(state, { view, category, tag, query, initialFeedPath: null });
    closeMenu();
    renderFilters();
    loadList();
  }

  function clearTopic() {
    sampleReading();
    tracker.stop();
    topicRequest?.abort();
    state.selected = null;
    state.detail = null;
    resetReplyPager(null);
    $(".shell").dataset.reading = "false";
    renderReading();
  }

  function updateSteps() {
    const index = state.rows.findIndex(row => row.id === state.selected?.id);
    $('[data-action="step"][data-value="-1"]').disabled = index <= 0;
    $('[data-action="step"][data-value="1"]').disabled = index < 0 || index >= state.rows.length - 1;
  }

  function openTopicInView() {
    $(".shell").dataset.reading = "true";
  }

  async function selectTopic(topic, activate = true, initialFloor) {
    if (activate) openTopicInView();
    closeMenu();
    if (state.selected?.id === topic.id && state.detail) return;
    sampleReading();
    tracker.stop();
    lastActivity = performance.now();
    topicRequest?.abort();
    const controller = new AbortController();
    topicRequest = controller;
    state.selected = topic;
    state.detail = null;
    resetReplyPager(null);
    state.topicError = null;
    renderList();
    $("#read-scroll").scrollTop = 0;
    renderReading();

    try {
      const data = await forum.request(`/t/${Number(topic.id)}.json`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!data.post_stream?.posts?.length) throw new Error("原站未返回可阅读的楼层。");
      const posts = new Map(data.post_stream.posts.map(post => [post.id, post]));
      const stream = data.post_stream.stream || [...posts.keys()];
      state.detail = { data, stream, posts, attempted: new Set(posts.keys()), collapsed: new Set(), controller,
        pendingFloor: initialFloor || null, moreBusy: false };
      tracker.start(data.id);
      resetReplyPager(state.detail);
      rememberTags(data.tags);
      renderReading();
      if (initialFloor && initialFloor > 1) focusPost(initialFloor, false);
    } catch (error) {
      if (controller.signal.aborted) return;
      state.topicError = error.message;
      renderReading();
    }
  }

  function replyPerson(post, op, showLevel = true) {
    const label = post.display_username || post.username || "原站用户";
    const name = post.username
      ? anchor(label, "/u/" + encodeURIComponent(post.username), "author-name")
      : element("strong", "author-name", label);
    return add(element("span", "post-author"), avatar(post, op ? 36 : 29), name,
      op ? element("small", "op-badge", "楼主") : null,
      showLevel && Number.isInteger(post.trust_level) ? element("small", "level", "L" + post.trust_level) : null);
  }

  function postContent(post) {
    const node = element("div", "post-content");
    if (post?.cooked) node.append(forum.cooked(post.cooked));
    else node.textContent = "此楼层暂无可显示的内容。";
    return node;
  }

  function renderReading() {
    const toolbar = $("#reading-actions");
    const content = $("#reading");
    toolbar.replaceChildren();
    content.replaceChildren();
    updateSteps();
    // Keep the sync control reachable even before a topic is selected or while
    // its first page is loading; otherwise the list-only pane has no way to
    // discover that synchronization is off.
    const syncStatus = button("", "reading-sync", { className: "reading-sync" });
    syncStatus.id = "reading-sync";
    syncStatus.setAttribute("aria-live", "polite");
    toolbar.prepend(syncStatus);
    updateReadingStatus();
    if (!state.selected) {
      content.append(add(element("div", "reading-empty"), icon("list"), element("p", "", "从左侧选择一篇话题")));
      return;
    }
    const { selected, detail } = state;
    toolbar.append(anchor("在 Linux.do 打开", forum.topicPath(detail?.data || selected), "original", "out"));
    if (selected.hit?.post_number > 1) toolbar.prepend(anchor("查看命中楼层", forum.topicPath(selected, selected.hit.post_number), "original", "search"));
    if (!detail) {
      content.append(state.topicError ? status(state.topicError, "retry-topic") : status("正在读取话题…"));
      return;
    }

    const { data, posts } = detail;
    const bookmark = topicBookmark(data);
    const readingBookmark = button(bookmark ? "取消主题收藏" : "收藏主题", "bookmark", {
      className: "quiet-icon" + (bookmark ? " marked" : ""), symbol: "bookmark", iconOnly: true
    });
    readingBookmark.disabled = !!detail.bookmarkBusy;
    readingBookmark.setAttribute("aria-pressed", String(!!bookmark));
    const level = levels.get(data.details?.notification_level) || "常规";
    toolbar.prepend(readingBookmark, button(level, "menu", { className: "level-button menu-toggle", symbol: "bell", value: "notification" }));

    const op = [...posts.values()].find(post => post.post_number === 1);
    const category = state.categories.get(data.category_id);
    const breadcrumb = add(element("div", "breadcrumb"), categoryPill(category),
      data.closed ? element("span", "tag", "已关闭") : null);
    const header = element("header", "article-header");
    if (breadcrumb.childNodes.length) header.append(breadcrumb);
    header.append(element("h2", "article-title", data.title || selected.title));
    if (op) {
      header.append(add(element("div", "article-meta"), replyPerson(op, true), date(op.created_at),
        stat("comment", "回复", Math.max(0, data.posts_count - 1)),
        stat("eye", "浏览", data.views), stat("heart", "点赞", data.like_count)));
    } else header.append(date(data.created_at));
    const tags = (data.tags || []).slice(0, 12);
    if (tags.length) header.append(add(element("div", "chips article-tags"), ...tags.map(tag => tagPill(tag))));
    const mainPost = add(element("article", "op-content"), postContent(op));
    if (op) mainPost.dataset.postNumber = op.post_number;
    content.append(header, mainPost);
    if (detail.pendingFloor && ![...detail.posts.values()].some(post => post.post_number === detail.pendingFloor)) {
      content.append(anchor(`在原站查看 #${detail.pendingFloor}`, forum.topicPath(data, detail.pendingFloor), "secondary-button", "out"));
    }
    const replies = element("section", "replies");
    replies.id = "reply-section";
    content.append(replies);
    renderReplies();
  }

  function renderReplies() {
    const detail = state.detail;
    const section = $("#reply-section");
    if (!detail || !section) return;
    const { posts, data, collapsed, attempted, stream } = detail;
    const viewport = $("#read-scroll");
    const bounds = viewport.getBoundingClientRect();
    const visible = [...section.querySelectorAll(".reply-card")].find(node => {
      const rect = node.getBoundingClientRect();
      return rect.bottom > bounds.top && rect.top < bounds.bottom;
    });
    const anchorFloor = visible?.dataset.postNumber;
    const anchorTop = visible?.getBoundingClientRect().top;
    const byNumber = new Map([...posts.values()].map(post => [post.post_number, post]));
    const total = Math.max(0, data.posts_count - 1);
    const loaded = [...posts.values()].filter(post => post.post_number > 1).length;
    const heading = add(element("div", "replies-heading"),
      add(element("div", "reply-title"), icon("tree"), element("h3", "", "回复树"), element("span", "reply-count", total)));
    if (loaded) {
      heading.append(add(element("div", "reply-tools"),
        button("展开全部", "expand-all", { className: "text-button" }),
        button("折叠分支", "collapse-all", { className: "text-button" })));
    }
    section.replaceChildren(heading);
    if (!loaded && !total) section.append(status("还没有回复。"));
    const tree = element("ol", "tree");
    tree.setAttribute("aria-label", "按回复关系排列的楼层");
    const queue = [];
    for (const node of forum.replyTree(posts.values()).reverse()) queue.push({ node, depth: 0, list: tree });
    while (queue.length) {
      const { node, depth, list } = queue.pop();
      const { post, children } = node;
      const floor = post.post_number;
      const expanded = !collapsed.has(floor);
      const row = element("li", "tree-row");
      row.id = "reply-" + floor;
      const track = element("div", "tree-track");
      if (children.length) {
        const toggle = button(expanded ? "折叠分支" : "展开分支", "branch", {
          value: floor, iconOnly: true, symbol: expanded ? "minus" : "plus", className: "branch-toggle"
        });
        toggle.setAttribute("aria-expanded", String(expanded));
        track.append(toggle);
      } else track.append(element("span", "branch-dot"));
      const article = element("article", "reply-card");
      article.dataset.postNumber = floor;
      const head = add(element("div", "reply-header"), replyPerson(post, post.user_id != null && post.user_id === data.user_id),
        add(element("div", "reply-meta"), date(post.created_at), anchor("#" + floor, forum.topicPath(data, floor), "floor")));
      article.append(head);
      if (post.reply_to_post_number > 1) {
        const parent = byNumber.get(post.reply_to_post_number);
        const related = parent
          ? button("回复 #" + post.reply_to_post_number, "jump", { className: "parent-ref", value: post.reply_to_post_number, symbol: "reply" })
          : anchor("回复 #" + post.reply_to_post_number, forum.topicPath(data, post.reply_to_post_number), "parent-ref", "reply");
        article.append(related);
      }
      article.append(postContent(post));
      if (!expanded && children.length) article.append(button(`展开 ${children.length} 条直属回复`, "branch", {
        className: "collapsed-children", value: floor, symbol: "down"
      }));
      row.append(add(element("div", "tree-entry"), track, article));
      list.append(row);
      if (expanded && children.length) {
        const branch = element("ol", depth >= 4 ? "branch deep-branch" : "branch");
        row.append(branch);
        for (let i = children.length - 1; i >= 0; i--) queue.push({ node: children[i], depth: depth + 1, list: branch });
      }
    }
    if (loaded) section.append(tree);
    const pending = stream.some(id => !attempted.has(id));
    if (pending || detail.moreError) {
      const footer = add(element("div", "reply-footer"), element("span", "", `已载入 ${loaded} / ${Math.max(total, loaded)} 条回复`));
      if (pending && !detail.moreError) footer.append(element("span", "", "滚动到底部自动加载"));
      const more = button(detail.moreBusy ? "正在加载…" : detail.moreError ? "重试" : "手动加载更多",
        "more-posts", { className: "secondary-button", symbol: "down" });
      more.disabled = !!detail.moreBusy;
      footer.append(more);
      if (detail.moreError) footer.append(element("span", "error", detail.moreError));
      section.append(footer);
    }
    if (anchorFloor) {
      const replacement = section.querySelector(`[data-post-number="${anchorFloor}"]`);
      if (replacement) viewport.scrollTop += replacement.getBoundingClientRect().top - anchorTop;
    }
    replyPager?.check();
  }

  function resetReplyPager(detail) {
    replyPager?.destroy();
    replyPager = null;
    if (!detail) return;
    replyPager = new globalThis.LDScroll.Pager({
      viewport: $("#read-scroll"),
      canLoad: () => state.onScreen && state.detail === detail && !detail.moreBusy && !detail.moreError && detail.stream.some(id => !detail.attempted.has(id)),
      getKey: () => `${detail.data.id}:${detail.stream.find(id => !detail.attempted.has(id))}`,
      load: loadReplies
    });
  }

  async function loadReplies() {
    const detail = state.detail;
    if (!detail || detail.moreBusy) return;
    const ids = detail.stream.filter(id => !detail.attempted.has(id)).slice(0, Math.min(detail.data.chunk_size || 20, 30));
    if (!ids.length) return;
    detail.moreBusy = true;
    detail.moreError = null;
    renderReplies();
    try {
      const posts = await forum.postsPage(detail.data.id, ids, detail.controller.signal);
      if (detail.controller.signal.aborted || state.detail !== detail) return;
      for (const id of ids) detail.attempted.add(id);
      for (const post of posts) detail.posts.set(post.id, post);
    } catch (error) {
      detail.moreError = error.message;
    } finally {
      detail.moreBusy = false;
      if (state.detail === detail) renderReplies();
    }
  }

  function focusPost(floor, reveal = true) {
    const detail = state.detail;
    if (!detail) return;
    if (reveal) {
      const byNumber = new Map([...detail.posts.values()].map(post => [post.post_number, post]));
      let parent = byNumber.get(floor)?.reply_to_post_number;
      while (parent && parent < floor) {
        detail.collapsed.delete(parent);
        const next = byNumber.get(parent)?.reply_to_post_number;
        if (!next || next >= parent) break;
        parent = next;
      }
      renderReplies();
    }
    const row = $(`#reply-${floor}`);
    if (row) {
      row.tabIndex = -1;
      row.focus({ preventScroll: true });
      row.scrollIntoView({ block: "center" });
    }
  }

  function topicBookmark(data) {
    return data.bookmarks?.find(bookmark => bookmark.bookmarkable_type === "Topic" || bookmark.for_topic === true);
  }

  async function changeBookmark() {
    const detail = state.detail;
    if (!detail || detail.bookmarkBusy) return;
    const data = detail.data;
    const existing = topicBookmark(data);
    detail.bookmarkBusy = true;
    $('[data-action="bookmark"]').disabled = true;
    try {
      if (existing) {
        await forum.change(`/bookmarks/${Number(existing.id)}.json`, "DELETE");
        data.bookmarks = data.bookmarks.filter(bookmark => bookmark.id !== existing.id);
      } else {
        const response = await forum.change("/bookmarks.json", "POST", { bookmarkable_type: "Topic", bookmarkable_id: data.id });
        const created = response.bookmark || response;
        if (created.id) data.bookmarks = [...(data.bookmarks || []), { ...created, bookmarkable_type: "Topic" }];
        else data.bookmarks = (await forum.request(`/t/${data.id}.json`)).bookmarks || [];
      }
      notify(existing ? "已取消主题收藏" : "已收藏到 Linux.do");
      if (state.view === "bookmarks") loadList(false, true);
    } catch (error) {
      notify(error.message);
    } finally {
      detail.bookmarkBusy = false;
      if (state.detail === detail) renderToolbar();
    }
  }

  async function changeLevel(value) {
    const detail = state.detail;
    if (!detail || detail.levelBusy || !levels.has(value)) return;
    detail.levelBusy = true;
    try {
      await forum.change(`/t/${detail.data.id}/notifications`, "POST", { notification_level: value });
      detail.data.details ||= {};
      detail.data.details.notification_level = value;
      notify("通知设置已更新为" + levels.get(value));
      if (state.view === "following") loadList(false, true);
    } catch (error) {
      notify(error.message);
    } finally {
      detail.levelBusy = false;
      if (state.detail === detail) renderToolbar();
    }
  }

  function renderToolbar() {
    const detail = state.detail;
    const bookmark = topicBookmark(detail.data);
    const control = $('[data-action="bookmark"]');
    control.disabled = !!detail.bookmarkBusy;
    control.setAttribute("aria-pressed", String(!!bookmark));
    control.title = bookmark ? "取消主题收藏" : "收藏主题";
    control.setAttribute("aria-label", control.title);
    control.classList.toggle("marked", !!bookmark);
    $('[data-value="notification"]').replaceChildren(icon("bell"), levels.get(detail.data.details?.notification_level) || "常规");
  }

  function rememberTags(tags = []) {
    for (const raw of tags) {
      const tag = forum.tagInfo(raw);
      if (!tag.name) continue;
      const previous = state.tags.get(tag.name);
      if (previous?.id && !tag.id) continue;
      state.tags.set(tag.name, tag);
    }
  }

  function closeMenu(restore = false) {
    if (!state.openMenu) return;
    const trigger = state.openMenu.trigger;
    trigger.setAttribute("aria-expanded", "false");
    $("#menu").hidden = true;
    state.openMenu = null;
    if (restore && trigger.isConnected) trigger.focus();
  }

  function popupSection(popup, name, links) {
    if (name) popup.append(element("h3", "popup-label", name));
    for (const [label, url] of links) popup.append(anchor(label, url, "popup-item", "out"));
  }

  function populateMenu(name) {
    const menu = $("#menu");
    menu.replaceChildren();
    if (name === "feeds") {
      for (const [value, label] of modes) {
        const active = state.view === value && !state.category && !state.tag;
        const select = button(label, "mode", { value, className: "popup-item" + (active ? " checked" : "") });
        select.setAttribute("aria-pressed", String(active));
        menu.append(select);
      }
    }
    if (name === "filters") {
      for (const [value, label, current, symbol] of [
        ["categories", "类别", state.category, "folder"], ["tags", "标签", state.tag, "tag"]
      ]) {
        const item = button(label, "filter-section", { value, className: "popup-item", symbol });
        item.append(element("span", "filter-value", current?.name || "不限"));
        menu.append(item);
      }
    }
    if (name === "theme") {
      menu.append(element("h3", "popup-label", "阅读器配色"));
      const current = host.dataset.theme || "site";
      for (const [value, label] of themes) {
        const select = button(label, "theme", { value, className: "popup-item" + (value === current ? " checked" : "") });
        select.setAttribute("aria-pressed", String(value === current));
        menu.append(select);
      }
    }
    if (name === "categories" || name === "tags") {
      const isCategory = name === "categories";
      const input = element("input", "popup-search");
      input.type = "search";
      input.placeholder = isCategory ? "查找类别" : "查找标签";
      input.setAttribute("aria-label", input.placeholder);
      menu.append(button("返回筛选", "filter-section", { value: "filters", className: "popup-item", symbol: "back" }), input);
      const results = element("div", "popup-results");
      menu.append(results);
      const values = isCategory ? [...state.categories.values()] : [...state.tags.values()];
      const preferred = forum.sidebar().find(section => section.name === (isCategory ? "类别" : "标签"))?.links.map(link => link.label) || [];
      const sorted = [...values].sort((a, b) => {
        const ai = preferred.indexOf(a.name), bi = preferred.indexOf(b.name);
        const priority = (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi);
        return priority || (isCategory ? a.position - b.position : (b.count || 0) - (a.count || 0));
      });
      const fill = () => {
        const clear = button(isCategory ? "所有类别" : "所有标签", isCategory ? "category" : "tag", {
          className: "popup-item clear-filter"
        });
        results.replaceChildren(clear);
        const query = input.value.trim().toLocaleLowerCase();
        const candidates = sorted.filter(item => String(item.name).toLocaleLowerCase().includes(query) ||
          String(item.slug).toLocaleLowerCase().includes(query));
        const current = isCategory ? state.category : state.tag;
        for (const item of candidates.slice(0, 150)) {
          const control = isCategory ? categoryPill(item) : tagPill(item);
          control.classList.add("popup-item");
          if ((current?.id && current.id === item.id) || current?.name === item.name) control.classList.add("checked");
          results.append(control);
        }
        if (!candidates.length) results.append(element("p", "popup-empty", query ? "没有找到匹配项。" : "正在等待原站数据。"));
      };
      fill();
      input.addEventListener("input", fill);
      popupSection(menu, null, [[isCategory ? "原站类别目录" : "原站标签目录", isCategory ? "/categories" : "/tags"]]);
    }
    if (name === "notification") {
      menu.append(element("h3", "popup-label", "话题通知"));
      for (const [value, label] of levels) {
        const current = state.detail?.data.details?.notification_level ?? 1;
        const select = button(label, "level", { value, className: "popup-item" + (value === current ? " checked" : "") });
        if (value === current) select.setAttribute("aria-current", "true");
        menu.append(select);
      }
    }
  }

  function openMenu(name, trigger) {
    closeSidebar();
    const wasOpen = state.openMenu?.trigger === trigger;
    closeMenu();
    if (wasOpen) return;
    state.openMenu = { name, trigger };
    trigger.setAttribute("aria-expanded", "true");
    populateMenu(name);
    const menu = $("#menu");
    const { left, right, bottom } = trigger.getBoundingClientRect();
    const width = Math.min(298, innerWidth - 24);
    menu.style.width = width + "px";
    menu.style.left = Math.max(12, Math.min(left > innerWidth / 2 ? right - width : left, innerWidth - width - 12)) + "px";
    menu.style.top = bottom + 8 + "px";
    menu.style.maxHeight = Math.max(160, innerHeight - bottom - 20) + "px";
    menu.hidden = false;
    (menu.querySelector("input") || menu.querySelector("button, a"))?.focus({ preventScroll: true });
  }

  function nativeSidebarButton() {
    return nativeHeader?.querySelector(".header-sidebar-toggle button");
  }

  function nativeSidebar() {
    return outlet?.parentElement?.querySelector(":scope > .sidebar-wrapper");
  }

  function syncSidebar() {
    const menu = state.sidebarMenu;
    if (!menu) return;
    const sidebar = nativeSidebar();
    const nav = sidebar?.querySelector("#d-sidebar, .sidebar-container");
    if (!nav) return;
    sidebar.setAttribute("data-ld-sidebar-menu", "");
    const { left, bottom } = menu.trigger.getBoundingClientRect();
    const width = Math.min(300, innerWidth - 24);
    const top = Math.round(bottom + 7);
    sidebar.style.setProperty("--ld-sidebar-top", top + "px");
    sidebar.style.setProperty("--ld-sidebar-left", Math.round(Math.max(10, Math.min(left, innerWidth - width - 10))) + "px");
    sidebar.style.setProperty("--ld-sidebar-width", width + "px");
    sidebar.style.setProperty("--ld-sidebar-height", Math.max(120, Math.min(610, innerHeight - top - 12)) + "px");
    if (menu.panel !== sidebar) {
      menu.panel = sidebar;
      nav.querySelector(".sidebar-sections")?.scrollTo({ top: 0 });
      nav.querySelector("a[href], button")?.focus({ preventScroll: true });
    }
  }

  function closeSidebar(restoreFocus = false) {
    const menu = state.sidebarMenu;
    if (!menu) return;
    state.sidebarMenu = null;
    menu.trigger.setAttribute("aria-expanded", "false");
    menu.panel?.removeAttribute("data-ld-sidebar-menu");
    if (menu.nativeWasClosed && nativeSidebarButton()?.getAttribute("aria-expanded") === "true") nativeSidebarButton().click();
    if (restoreFocus && menu.trigger.isConnected) menu.trigger.focus({ preventScroll: true });
  }

  function openSidebar(trigger) {
    closeMenu();
    if (state.sidebarMenu) { closeSidebar(true); return; }
    const nativeButton = nativeSidebarButton();
    const nativeWasClosed = nativeButton?.getAttribute("aria-expanded") === "false";
    state.sidebarMenu = { trigger, nativeWasClosed };
    trigger.setAttribute("aria-expanded", "true");
    if (nativeWasClosed) nativeButton.click();
    syncSidebar();
    if (!nativeButton && !state.sidebarMenu.panel) {
      closeSidebar();
      notify("当前页面没有原站侧栏。可在首页打开原站导航。");
    }
  }

  let noticeTimer;
  function notify(message) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { toast.hidden = true; }, 4200);
  }

  function describeTheme() {
    const control = $('[data-value="theme"]');
    control.title = "配色 · " + themes.get(host.dataset.theme || "site");
    control.setAttribute("aria-label", control.title);
  }

  function setTheme(value) {
    if (!themes.has(value)) return;
    if (value === "site") delete host.dataset.theme;
    else host.dataset.theme = value;
    syncDocumentTheme();
    describeTheme();
    try {
      if (value === "site") localStorage.removeItem("linux-do-reader-theme");
      else localStorage.setItem("linux-do-reader-theme", value);
    } catch {}
  }

  function clicked(event) {
    const control = event.target.closest("[data-action]");
    const inMenu = event.target.closest("#menu");
    const action = control?.dataset.action;
    const value = control?.dataset.value;
    if (!inMenu && action !== "menu") closeMenu();
    if (action !== "sidebar") closeSidebar();
    if (!control) return;
    switch (action) {
      case "mode": closeMenu(true); switchFeed(value); break;
      case "category": switchFeed("latest", state.categories.get(Number(value)) || null, state.tag); break;
      case "tag": switchFeed("latest", state.category, control._readerTag || null); break;
      case "menu": openMenu(value, control); break;
      case "sidebar": openSidebar(control); break;
      case "filter-section": {
        state.openMenu.name = value;
        populateMenu(value);
        ($("#menu input") || $("#menu button"))?.focus({ preventScroll: true });
        break;
      }
      case "theme": setTheme(value); closeMenu(true); break;
      case "new-topic": newTopic(); break;
      case "back":
        $(".shell").dataset.reading = "false";
        $(".topic-row.selected .topic-select")?.focus({ preventScroll: true });
        break;
      case "topic": {
        const row = state.rows.find(topic => topic.id === Number(value));
        if (row) selectTopic(row);
        if (host.clientWidth <= 760) $(".mobile-back").focus({ preventScroll: true });
        break;
      }
      case "step": {
        const index = state.rows.findIndex(topic => topic.id === state.selected?.id);
        const row = state.rows[index + Number(value)];
        if (row) selectTopic(row);
        break;
      }
      case "refresh": loadList(false, true); break;
      case "more-topics": loadList(true); break;
      case "retry-topic": selectTopic(state.selected); break;
      case "more-posts": loadReplies(); break;
      case "reading-sync": toggleReadingSync(); break;
      case "bookmark": changeBookmark(); break;
      case "level": closeMenu(true); changeLevel(Number(value)); break;
      case "jump": focusPost(Number(value)); break;
      case "branch": {
        const floor = Number(value);
        const collapsed = state.detail.collapsed;
        if (collapsed.has(floor)) collapsed.delete(floor);
        else collapsed.add(floor);
        renderReplies();
        $(`.branch-toggle[data-value="${floor}"]`)?.focus({ preventScroll: true });
        break;
      }
      case "expand-all": state.detail.collapsed.clear(); renderReplies(); break;
      case "collapse-all":
        for (const post of state.detail.posts.values()) {
          if (post.reply_to_post_number > 1) state.detail.collapsed.add(post.reply_to_post_number);
        }
        renderReplies();
        break;
    }
  }

  function keydown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (state.openMenu) closeMenu(true);
      else if (state.sidebarMenu) closeSidebar(true);
      else if (event.target.id === "query" && event.target.value) event.target.value = "";
      else hideReader();
      return;
    }
    if (event.key === "/" && !event.ctrlKey && !event.metaKey && !event.target.matches("input, textarea, [contenteditable]")) {
      event.preventDefault();
      $("#query").focus();
    }
  }

  function loadAccount() {
    if (accountRequest) return accountRequest;
    if (performance.now() < accountRetryAt) return Promise.resolve();
    accountRequest = forum.account().then(user => {
      state.user = user;
      updateReadingStatus();
    }).catch(error => {
      accountRetryAt = performance.now() + 30000;
      throw error;
    }).finally(() => { accountRequest = null; });
    return accountRequest;
  }

  async function loadContext() {
    const operations = [
      loadAccount(),
      forum.request("/site.json", { priority: 1 }).then(site => {
        state.categories = new Map((site.categories || []).map(category => [category.id, category]));
        if (state.category) state.category = state.categories.get(state.category.id) || state.category;
        renderFilters();
        rememberTags(site.top_tags);
        rememberTags(site.navigation_menu_site_top_tags);
        renderList();
        if (state.detail) renderReading();
      }),
      forum.request("/tags.json", { priority: 1 }).then(data => rememberTags(data.tags))
    ];
    await Promise.allSettled(operations);
    if (state.openMenu && ["categories", "tags"].includes(state.openMenu.name) && $("#menu input")?.value === "") {
      populateMenu(state.openMenu.name);
      $("#menu input")?.focus({ preventScroll: true });
    }
  }

  function newTopic() {
    const native = document.querySelector('#create-topic, button[aria-label="新建话题"]');
    if (native) {
      hideReader(false);
      native.focus();
      native.click();
    } else location.assign("/new-topic");
  }

  function updateMode() {
    const original = modeSwitch.querySelector('[data-mode="original"]');
    const reader = modeSwitch.querySelector('[data-mode="reader"]');
    reader.setAttribute("aria-pressed", String(state.onScreen));
    original.setAttribute("aria-pressed", String(!state.onScreen));
  }

  function syncDocumentTheme() {
    const theme = state.onScreen && host.dataset.theme;
    if (theme) document.documentElement.dataset.ldReaderTheme = theme;
    else delete document.documentElement.dataset.ldReaderTheme;
    syncHeaderLogo();
  }

  function syncHeaderLogo() {
    const theme = document.documentElement.dataset.ldReaderTheme;
    if (headerLogo && (!theme || !nativeHeader?.contains(headerLogo.source))) {
      headerLogo.source.setAttribute("media", headerLogo.media);
      headerLogo = null;
    }
    if (!theme) return;
    if (!headerLogo) {
      const source = nativeHeader?.querySelector('.home-logo-wrapper-outlet picture source[media*="prefers-color-scheme: dark"]');
      if (!source) return;
      headerLogo = { source, media: source.getAttribute("media") };
    }
    const media = theme === "dark" ? "all" : "not all";
    if (headerLogo.source.getAttribute("media") !== media) headerLogo.source.setAttribute("media", media);
  }

  function hideReader(restore = true, preserveMode = false) {
    if (!preserveMode) readerMode = false;
    pendingOpen = false;
    sampleReading();
    void tracker.flush();
    tracker.resetClock();
    if (!state.onScreen) return;
    closeMenu();
    closeSidebar();
    state.onScreen = false;
    syncDocumentTheme();
    updateMode();
    outlet?.classList.remove(outletClass);
    host.hidden = true;
    if (restore) {
      window.scrollTo({ left: originalPosition.x, top: originalPosition.y, behavior: "instant" });
      modeSwitch.querySelector('[data-mode="original"]').focus({ preventScroll: true });
    }
  }

  function sizeReader() {
    if (!state.onScreen) return;
    const top = Math.max(0, outlet.getBoundingClientRect().top, nativeHeader?.getBoundingClientRect().bottom || 0);
    const height = Math.max(240, Math.floor(window.innerHeight - top));
    host.style.setProperty("--ld-reader-height", height + "px");
    syncSidebar();
  }

  function syncNativeLayout() {
    const header = document.querySelector(".d-header");
    const logo = header?.querySelector(".home-logo-wrapper-outlet");
    const position = logo || header?.querySelector(".contents") || header?.querySelector(".d-header-icons") || header;
    const siteOutlet = document.getElementById("main-outlet");
    if (logo && logo.nextElementSibling !== modeSwitch) logo.after(modeSwitch);
    else if (!logo && position && modeSwitch.parentNode !== position) position.prepend(modeSwitch);
    if (nativeHeader !== header) {
      headerObserver.disconnect();
      nativeHeader = header;
      if (header) headerObserver.observe(header);
    }
    if (state.onScreen && (outlet !== siteOutlet || !host.isConnected)) {
      hideReader(false, true);
      pendingOpen = readerMode && reading.readerRoute(location.pathname);
    }
    outlet = siteOutlet;
    if (pendingOpen && modeSwitch.isConnected && outlet) showReader();
    if (state.onScreen) syncHeaderLogo();
    syncSidebar();
  }

  function showReader() {
    readerMode = true;
    lastActivity = performance.now();
    tracker.resetClock();
    if (state.onScreen) return;
    if (!outlet?.isConnected || !modeSwitch?.isConnected) {
      pendingOpen = true;
      return;
    }
    pendingOpen = false;
    if (!host) mount();
    const page = location.pathname + location.search;
    const pageChanged = originalLocation !== page;
    originalLocation = page;
    originalPosition = { x: window.scrollX, y: window.scrollY };
    outlet.append(host);
    outlet.classList.add(outletClass);
    state.onScreen = true;
    host.hidden = false;
    syncDocumentTheme();
    updateMode();
    window.scrollTo({ top: 0, behavior: "instant" });
    sizeReader();
    renderFilters();
    if (!contextLoaded) {
      contextLoaded = true;
      loadContext();
    }
    if (pageChanged || (!state.rows.length && !state.listBusy)) {
      const topicRoute = location.pathname.match(/^\/t\/(?:([^/]+)\/)?(\d+)(?:\/(\d+))?\/?$/);
      const route = reading.feedRoute(location.pathname, location.search);
      Object.assign(state, {
        view: route.view, initialFeedPath: topicRoute ? null : route.path,
        category: route.categoryId ? state.categories.get(route.categoryId) || { id: route.categoryId, slug: route.categorySlug, name: route.categorySlug } : null,
        tag: route.tagSlug ? { slug: route.tagSlug, name: route.tagSlug, id: route.tagId } : null,
        query: ""
      });
      renderFilters();
      if (topicRoute) {
        selectTopic({ id: Number(topicRoute[2]), slug: topicRoute[1] || "topic" }, true, Number(topicRoute[3]));
        loadList(false, true);
      } else loadList();
    }
    listPager?.check();
    replyPager?.check();
  }

  function applyNativeNavigation() {
    if (state.onScreen && originalLocation === location.pathname + location.search) return;
    if (state.onScreen) hideReader(false, true);
    pendingOpen = readerMode && reading.readerRoute(location.pathname);
    if (pendingOpen) syncNativeLayout();
  }

  extension?.onMessage?.addListener((message, sender, respond) => {
    if (message.type !== "linux-do-reader:open") return;
    showReader();
    respond({ open: true });
  });

  function requestedURL() {
    const url = new URL(location.href);
    return url.searchParams.get("ld-reader") === "1" || url.hash === "#ld-reader";
  }

  function openFromURL() {
    const url = new URL(location.href);
    url.searchParams.delete("ld-reader");
    if (url.hash === "#ld-reader") url.hash = "";
    if (url.href !== location.href) history.replaceState(history.state, "", url);
    showReader();
  }

  const requestedAtStart = requestedURL();
  function initialize() {
    modeSwitch = element("div", "ld-reader-modes");
    modeSwitch.id = "linux-do-reader-mode-switch";
    const controls = element("div", "ld-reader-mode-options");
    controls.setAttribute("role", "group");
    controls.setAttribute("aria-label", "Linux.do 显示模式");
    const reader = element("button", "", "阅读器");
    const original = element("button", "", "原版");
    for (const [control, mode, action] of [[reader, "reader", showReader], [original, "original", hideReader]]) {
      control.type = "button";
      control.dataset.mode = mode;
      control.addEventListener("click", () => action());
      controls.append(control);
    }
    modeSwitch.append(controls);
    updateMode();
    headerObserver = new ResizeObserver(sizeReader);
    syncNativeLayout();
    new MutationObserver(syncNativeLayout).observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", sizeReader);
    window.addEventListener("popstate", applyNativeNavigation);
    window.navigation?.addEventListener("currententrychange", applyNativeNavigation);
    document.addEventListener("click", event => {
      if (!state.onScreen || !(event.target instanceof Element)) return;
      const nativeToggle = nativeSidebarButton();
      if (event.isTrusted && nativeToggle?.contains(event.target)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        openSidebar($('[data-action="sidebar"]'));
        return;
      }
      if (event.composedPath().includes(host) || (nativeToggle?.contains(event.target) && !event.isTrusted)) return;
      closeMenu();
      if (!state.sidebarMenu?.panel?.contains(event.target) && !event.target.closest(".fk-d-menu, .d-modal")) closeSidebar();
    }, true);
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && !event.defaultPrevented && state.sidebarMenu && !event.target.closest?.(".fk-d-menu, .d-modal")) closeSidebar(true);
    });
    if (requestedAtStart || requestedURL()) openFromURL();
    else if (reading.readerRoute(location.pathname)) showReader();
    for (const type of ["pointerdown", "pointermove", "keydown", "wheel", "scroll"]) {
      document.addEventListener(type, () => { lastActivity = performance.now(); }, { capture: true, passive: true });
    }
    document.addEventListener("visibilitychange", () => {
      tracker.resetClock();
      if (document.hidden) void tracker.flush();
    });
    window.addEventListener("blur", () => { tracker.resetClock(); void tracker.flush(); });
    window.addEventListener("focus", () => { lastActivity = performance.now(); tracker.resetClock(); });
    window.addEventListener("pagehide", () => { sampleReading(); void tracker.flush(); });
    setInterval(sampleReading, 1000);
    setInterval(() => { if (readingSyncEnabled && state.user) void tracker.flush(); }, 30000);
    setInterval(() => {
      if (state.user === undefined && state.onScreen) void loadAccount().catch(() => {});
    }, 10000);
    window.addEventListener("hashchange", () => { if (requestedURL()) openFromURL(); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
  else initialize();
})();
