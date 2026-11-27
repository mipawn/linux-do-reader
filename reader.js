(() => {
  if (globalThis.LDReaderReady) return;
  globalThis.LDReaderReady = true;
  const forum = globalThis.LDForum;
  const navigation = globalThis.LDNavigation;
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
    user: undefined, selected: null, topicBusy: false, detail: null, openMenu: null, sidebarMenu: null, onScreen: false,
    challengeCleared: false, listChallenge: false, topicChallenge: false
  };
  const outletClass = "ld-reader-active";
  let host, root, listRequest, topicRequest, outlet, modeSwitch, nativeHeader, headerObserver, listPager, replyPager;
  let pendingOpen = false, readerMode = true, originalLocation, originalPosition, contextLoaded = false;
  let nativeClient, contextRequest, imagePreview, polls;
  let recoveryTimer;
  let headerLogo;
  const pageLoadedAt = Date.now();
  let pageClearedChallenge = false;
  const $ = (selector) => root.querySelector(selector);

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

  function stat(symbol, label, count, showLabel = false) {
    if (count == null || !Number.isFinite(Number(count)) || Number(count) < 0) return null;
    const node = add(element("span", "stat"), icon(symbol), element("span", "stat-number", number.format(count)));
    if (showLabel) node.append(element("span", "stat-label", label));
    node.title = label + " " + count;
    node.setAttribute("aria-label", node.title);
    return node;
  }

  function topicReplyCount(topic, fallback) {
    for (const source of [topic, fallback]) {
      if (Number.isFinite(source?.posts_count) && source.posts_count >= 1) return source.posts_count - 1;
      if (Number.isFinite(source?.reply_count) && source.reply_count >= 0) return source.reply_count;
    }
    return null;
  }

  function topicMetrics(detail) {
    const summary = element("div", "topic-metrics");
    summary.id = "topic-metrics";
    summary.setAttribute("aria-label", "话题统计");
    const replies = stat("comment", "回复", topicReplyCount(detail.data, state.selected), true);
    if (replies) replies.id = "topic-reply-count";
    const views = stat("eye", "浏览量", detail.data.views ?? state.selected?.views, true);
    if (views) views.id = "topic-view-count";
    add(summary, views, replies, stat("heart", "点赞", detail.data.like_count, true));
    return summary;
  }

  function initialReplySort(path) {
    const aliases = new Map([["old", "oldest"], ["new", "newest"], ["top", "top"], ["oldest", "oldest"], ["newest", "newest"]]);
    const explicit = path && forum.safeURL(path)?.searchParams.get("sort");
    return aliases.has(explicit) ? aliases.get(explicit) : "oldest";
  }

  function parsePayload(value) {
    if (value == null || typeof value !== "string") return value ?? null;
    try { return JSON.parse(value); } catch { return null; }
  }

  // The original page embeds its site settings and emoji catalogue in one
  // preloaded JSON script. Reading it keeps reactions and boosts offline: no
  // extra request, and custom emoji keep their real upload urls.
  let preloadedOnce;
  function preloaded() {
    if (preloadedOnce !== undefined) return preloadedOnce;
    preloadedOnce = null;
    try { preloadedOnce = parsePayload(document.getElementById?.("data-preloaded")?.textContent) || null; } catch {}
    return preloadedOnce;
  }

  let settingsOnce;
  function readerSettings() {
    if (!settingsOnce) settingsOnce = parsePayload(preloaded()?.siteSettings) || {};
    return settingsOnce;
  }

  function mainReactionId() {
    const value = readerSettings().discourse_reactions_reaction_for_like;
    return typeof value === "string" && value ? value : "heart";
  }

  let emojiCatalog;
  function emojiSources() {
    if (emojiCatalog) return emojiCatalog;
    const catalog = { set: "twemoji", custom: new Map(), list: [] };
    const settings = readerSettings();
    if (typeof settings.emoji_set === "string" && /^[a-z0-9_-]+$/i.test(settings.emoji_set)) catalog.set = settings.emoji_set;
    const custom = parsePayload(preloaded()?.customEmoji);
    for (const emoji of Array.isArray(custom) ? custom : []) {
      if (typeof emoji?.name === "string" && emoji.name && typeof emoji?.url === "string" && emoji.url) {
        catalog.custom.set(emoji.name.toLowerCase(), emoji.url);
        catalog.list.push({ name: emoji.name, group: typeof emoji.group === "string" && emoji.group ? emoji.group : "表情", url: emoji.url });
      }
    }
    emojiCatalog = catalog;
    return catalog;
  }

  function emojiSource(id) {
    const name = String(id || "").toLowerCase();
    if (!name) return null;
    const catalog = emojiSources();
    const custom = catalog.custom.get(name);
    if (custom) {
      const url = forum.safeURL(custom);
      return url?.protocol === "https:" ? url.href : null;
    }
    if (!/^[a-z0-9_+-]+$/.test(name)) return null;
    return `/images/emoji/${encodeURIComponent(catalog.set)}/${encodeURIComponent(name)}.png`;
  }

  function emojiImage(id, size = 16, className = "reaction-emoji") {
    const source = emojiSource(id);
    if (!source) return element("span", "reaction-name", `:${id}:`);
    const image = element("img", className);
    image.alt = "";
    image.width = size;
    image.height = size;
    image.loading = "lazy";
    image.referrerPolicy = "no-referrer";
    image.src = source;
    image.addEventListener("error", () => {
      image.replaceWith(element("span", "reaction-name", `:${id}:`));
    }, { once: true });
    return image;
  }

  function postByFloor(floor) {
    const detail = state.detail;
    if (!detail || !Number.isSafeInteger(floor)) return null;
    for (const post of detail.posts.values()) if (post.post_number === floor) return post;
    return null;
  }

  function reactionIds(post) {
    const ids = [];
    const seen = new Set();
    const push = id => { if (typeof id === "string" && id && !seen.has(id)) { seen.add(id); ids.push(id); } };
    const configured = readerSettings().discourse_reactions_enabled_reactions;
    const valid = typeof configured === "string" ? configured.split("|") : state.detail?.data?.valid_reactions;
    for (const id of Array.isArray(valid) ? valid : []) push(id);
    const main = mainReactionId();
    if (!seen.has(main)) ids.unshift(main);
    return ids;
  }

  function reactionInteractive(post) {
    return !!post && !post.yours && !(state.user && post.user_id === state.user.id) &&
      globalThis.LDDiscussion.postState(post) === "available";
  }

  function reactionAllowed(post) {
    if (!reactionInteractive(post) || state.detail?.data?.archived || post.topic?.archived) return false;
    if (post.current_user_reaction?.can_undo === false) return false;
    if (!state.user) return !state.detail?.data?.closed && !post.topic?.closed;
    const like = Array.isArray(post.actions_summary) ? post.actions_summary.find(action => Number(action?.id) === 2) : null;
    return !like || like.can_act !== false || like.can_undo === true;
  }

  function reactionSummary(post) {
    const { reactions, total } = globalThis.LDDiscussion.reactionSummary(post);
    if (!total) return null;
    const bar = element("div", "post-reactions");
    bar.setAttribute("role", "group");
    const labels = [];
    const shown = reactions.slice(0, 3);
    const mine = post.current_user_reaction && typeof post.current_user_reaction === "object" ? post.current_user_reaction : null;
    if (mine?.id && !shown.some(reaction => reaction.id === mine.id)) {
      const own = reactions.find(reaction => reaction.id === mine.id);
      if (own) shown.push(own);
    }
    for (const reaction of shown) {
      const item = add(element("span", "reaction"), emojiImage(reaction.id));
      item.setAttribute("title", `:${reaction.id}: ${reaction.count}`);
      labels.push(`:${reaction.id}: ${reaction.count}`);
      bar.append(item);
    }
    bar.append(element("span", "reaction-total", number.format(total)));
    const label = (labels.length ? labels.join("、") + "，" : "") + `共 ${total} 个表情回应`;
    bar.setAttribute("aria-label", label);
    if (labels.length) bar.setAttribute("title", label);
    return bar;
  }

  let interactionHoverTimer, interactionCloseTimer, interactionTouch;

  function clearInteractionTimers() {
    clearTimeout(interactionHoverTimer);
    clearTimeout(interactionCloseTimer);
    clearTimeout(interactionTouch?.timer);
    interactionHoverTimer = interactionCloseTimer = interactionTouch = null;
  }

  function interactionPointer(event) {
    const control = event.target.closest?.('[data-action="react"], [data-action="boost-compose"]');
    const menu = state.openMenu;
    const popup = $("#menu");
    if (event.pointerType === "mouse") {
      if (event.type === "pointerover") {
        if (popup?.contains(event.target) || menu?.trigger.contains(event.target)) clearTimeout(interactionCloseTimer);
        if (!control || control.closest("#menu") || control.contains(event.relatedTarget) || control.disabled ||
            !state.onScreen || (menu?.name === "boost" && popup?.contains(root.activeElement))) return;
        const post = postByFloor(Number(control.dataset.post || control.dataset.value));
        const isBoost = control.dataset.action === "boost-compose";
        if (!post || (isBoost ? !canBoost(post) || !state.user : !reactionAllowed(post) || readerSettings().enable_emoji === false)) return;
        if (menu?.trigger === control) return;
        clearTimeout(interactionCloseTimer);
        clearTimeout(interactionHoverTimer);
        const detail = state.detail;
        interactionHoverTimer = setTimeout(() => {
          if (state.detail === detail && state.onScreen && control.isConnected && !control.disabled) {
            openMenu(isBoost ? "boost" : "reactions", control, { post, width: isBoost ? 332 : 276, focus: false });
          }
        }, isBoost ? 200 : 100);
      } else if (event.type === "pointerout") {
        if (control && !control.contains(event.relatedTarget)) clearTimeout(interactionHoverTimer);
        if (!menu || !["boost", "reactions"].includes(menu.name) ||
            (!menu.trigger.contains(event.target) && !popup?.contains(event.target)) ||
            menu.trigger.contains(event.relatedTarget) || popup?.contains(event.relatedTarget) ||
            (menu.name === "boost" && popup?.contains(root.activeElement))) return;
        clearTimeout(interactionCloseTimer);
        interactionCloseTimer = setTimeout(() => { if (state.openMenu === menu) closeMenu(); }, 500);
      }
      return;
    }
    if (event.type === "pointerdown") {
      clearTimeout(interactionTouch?.timer);
      interactionTouch = null;
      if (!control || control.dataset.action !== "react" || control.closest("#menu") || control.disabled || !state.onScreen) return;
      const post = postByFloor(Number(control.dataset.post));
      if (!reactionAllowed(post) || readerSettings().enable_emoji === false) return;
      const detail = state.detail;
      const touch = { control, x: event.clientX, y: event.clientY };
      touch.timer = setTimeout(() => {
        if (interactionTouch === touch && state.detail === detail && state.onScreen && control.isConnected) {
          touch.fired = true;
          control._readerLongPressUntil = Date.now() + 1000;
          openMenu("reactions", control, { post, width: 276, focus: false });
        }
      }, 400);
      interactionTouch = touch;
    } else if (["pointerup", "pointercancel"].includes(event.type) ||
        (event.type === "pointermove" && interactionTouch && Math.hypot(event.clientX - interactionTouch.x, event.clientY - interactionTouch.y) > 10)) {
      clearTimeout(interactionTouch?.timer);
      if (interactionTouch?.fired) interactionTouch.control._readerLongPressUntil = Date.now() + 1000;
      interactionTouch = null;
    }
  }

  function reactionActions(detail, post) {
    if (!reactionInteractive(post)) return [];
    const floor = Number.isSafeInteger(post.post_number) ? post.post_number : 0;
    const mine = post.current_user_reaction && typeof post.current_user_reaction === "object" ? post.current_user_reaction : null;
    const undoable = !mine || mine.can_undo !== false;
    const allowed = reactionAllowed(post);
    const busy = detail?.reactionBusyFloors instanceof Set && detail.reactionBusyFloors.has(floor);
    const main = mainReactionId();
    const toggle = button("", "react", {
      className: "reaction-action" + (mine ? " active" : "") + (busy ? " busy" : ""),
      value: floor
    });
    toggle.dataset.post = String(floor);
    toggle.dataset.reaction = mine?.id || main;
    toggle.append(mine?.id && mine.id !== main ? emojiImage(mine.id, 18, "reaction-emoji") : icon("heart"));
    toggle.setAttribute("aria-pressed", String(!!mine));
    const title = !allowed ? (mine && !undoable ? "现在不能取消这个表情回应" : "现在不能表情回应") :
      mine ? "取消你的表情回应" : "点赞此帖子";
    toggle.setAttribute("title", title);
    toggle.setAttribute("aria-label", title);
    toggle.disabled = !allowed;
    if (busy) {
      toggle.setAttribute("aria-busy", "true");
      toggle.setAttribute("aria-disabled", "true");
    }

    if (readerSettings().enable_emoji !== false) {
      toggle.setAttribute("aria-haspopup", "dialog");
      toggle.setAttribute("aria-expanded", "false");
      toggle.setAttribute("aria-keyshortcuts", "ArrowDown");
      toggle.setAttribute("aria-description", "悬停或长按选择表情；键盘按下箭头打开选择面板。");
    }
    return [toggle];
  }

  function postControls(detail, post) {
    const row = element("div", "post-controls");
    const summary = reactionSummary(post);
    if (summary) row.append(summary);
    const actions = element("div", "post-actions");
    actions.append(...reactionActions(detail, post), replyButton(detail, post));
    row.append(actions);
    return row;
  }

  const mergedPostFields = ["reactions", "reaction_users_count", "current_user_reaction", "current_user_used_main_reaction", "actions_summary", "like_count", "yours"];

  function mergePostFields(post, response) {
    if (!response || typeof response !== "object") return;
    for (const key of mergedPostFields) if (Object.hasOwn(response, key)) post[key] = response[key];
  }

  function renderPostFloor(floor) {
    if (floor === 1) refreshReadingView();
    else renderReplies();
  }

  function pauseForWrite(error, detail) {
    if (error?.challenge || forum.requestQueue?.activeChallenge?.()) {
      detail?.live?.pause(forum.requestQueue?.challengeError?.() || error);
      renderChallengeBanner();
      return;
    }
    if (![429, 502, 503, 504].includes(error?.status)) return;
    detail?.live?.pause(forum.requestQueue.busyError());
    scheduleRecovery();
  }

  function postFieldSnapshot(post) {
    return mergedPostFields.map(key => [key, Object.hasOwn(post, key), post[key]]);
  }

  function restorePostFields(post, snapshot) {
    for (const [key, present, value] of snapshot) {
      if (present) post[key] = value;
      else delete post[key];
    }
  }

  function applyOptimisticReaction(post, reaction) {
    const current = post.current_user_reaction && typeof post.current_user_reaction === "object" ? post.current_user_reaction : null;
    const previousId = current?.id || null;
    const nextId = previousId === reaction ? null : reaction;
    const original = globalThis.LDDiscussion.reactionSummary(post);
    const source = Array.isArray(post.reactions) && post.reactions.length ? post.reactions : original.reactions;
    const reactions = source.map(item => ({ ...item }));
    const previousTotal = original.total;
    const change = (id, delta) => {
      if (!id || !delta) return;
      let item = reactions.find(value => value?.id === id);
      if (!item && delta > 0) {
        item = { id, type: "emoji", count: 0 };
        reactions.push(item);
      }
      if (item) item.count = Math.max(0, (Number(item.count) || 0) + delta);
    };
    change(previousId, -1);
    change(nextId, 1);
    post.reactions = reactions.filter(item => (Number(item?.count) || 0) > 0);
    const total = Number(post.reaction_users_count);
    const totalDelta = (nextId ? 1 : 0) - (previousId ? 1 : 0);
    post.reaction_users_count = Math.max(0, (Number.isFinite(total) ? total : previousTotal) + totalDelta);
    post.current_user_reaction = nextId ? { ...(current || {}), id: nextId, type: current?.type || "emoji", can_undo: true } : null;
    const main = mainReactionId();
    post.current_user_used_main_reaction = nextId === main;
    if (Number.isFinite(Number(post.like_count))) {
      const likeDelta = (nextId === main ? 1 : 0) - (previousId === main ? 1 : 0);
      post.like_count = Math.max(0, Number(post.like_count) + likeDelta);
    }
  }

  function refreshPostControls(floor, restoreAction = null) {
    const detail = state.detail;
    const post = postByFloor(floor);
    const article = root.querySelector(`[data-post-number="${floor}"]`);
    const current = article?.querySelector(".post-controls");
    if (!detail || !post || !current) return;
    const shouldRestoreFocus = !!restoreAction && current.contains(root.activeElement);
    const replacement = postControls(detail, post);
    current.replaceWith(replacement);
    if (shouldRestoreFocus) replacement.querySelector(`[data-action="${restoreAction}"]`)?.focus({ preventScroll: true });
    sizeReader();
  }

  // Match the original site's direct-like feel: update the clicked post at once,
  // keep only that post busy, then reconcile with the authoritative response.
  // A failed write restores the exact prior fields and never leaves a fake like.
  async function toggleReaction(floor, reaction) {
    const detail = state.detail;
    const post = postByFloor(floor);
    if (!detail || !post || !reaction || !reactionInteractive(post)) return;
    if (!state.user) { notify("请先登录 Linux.do 后再表情回应。"); return; }
    const busy = detail.reactionBusyFloors instanceof Set ? detail.reactionBusyFloors : (detail.reactionBusyFloors = new Set());
    if (busy.has(floor)) return;
    const mine = post.current_user_reaction;
    if (mine?.can_undo === false) {
      notify(mine.id === reaction ? "现在不能取消这个表情回应。" : "现在不能更换这个表情回应。");
      return;
    }
    if (!reactionAllowed(post)) { notify("现在不能表情回应。"); return; }
    if (!reactionIds(post).includes(reaction) && readerSettings().discourse_reactions_allow_any_emoji !== true && mine?.id !== reaction) return;
    const snapshot = postFieldSnapshot(post);
    busy.add(floor);
    applyOptimisticReaction(post, reaction);
    refreshPostControls(floor, "react");
    try {
      const response = await forum.change(
        `/discourse-reactions/posts/${Number(post.id)}/custom-reactions/${encodeURIComponent(reaction)}/toggle.json`, "PUT");
      if (state.detail !== detail) return;
      mergePostFields(post, response);
    } catch (error) {
      restorePostFields(post, snapshot);
      if (state.detail !== detail) return;
      notify(error.message);
      pauseForWrite(error, detail);
    } finally {
      busy.delete(floor);
      if (state.detail === detail) refreshPostControls(floor, "react");
    }
  }

  const boostMaxVisible = 16;
  const boostMaxEmoji = 5;

  function canBoost(post) {
    // can_boost is viewer-specific authority, not a whole-post single-boost limit.
    return !!post && post.can_boost === true && globalThis.LDDiscussion.postState(post) === "available";
  }

  // Boost bubbles wrap their cooked HTML in a paragraph; flatten it so a chip
  // stays on one line while keeping emoji images and inline links.
  function boostText(html) {
    const holder = element("span", "boost-text");
    holder.append(forum.cooked(html));
    for (const block of [...holder.children].filter(child => child.tagName === "P")) {
      const nodes = [...block.childNodes];
      block.remove();
      holder.append(...nodes);
    }
    return holder;
  }

  function boostList(post) {
    const list = globalThis.LDDiscussion.boosts(post);
    if (!list.length) return null;
    const wrap = element("div", "post-boosts");
    wrap.setAttribute("role", "list");
    wrap.setAttribute("aria-label", `表情评论 ${list.length} 条`);
    for (const boost of list) {
      const chip = add(element("span", "boost"), avatar(boost.user, 24), boostText(boost.cooked));
      chip.setAttribute("role", "listitem");
      if (boost.user?.username) chip.setAttribute("title", `@${boost.user.username}`);
      if (boost.can_delete && Number.isSafeInteger(boost.id)) {
        const remove = button("删除这条表情评论", "delete-boost", {
          className: "boost-delete", iconOnly: true, symbol: "close", value: boost.id
        });
        remove.dataset.post = String(post.post_number);
        chip.append(remove);
      }
      wrap.append(chip);
    }
    const trigger = boostTrigger(post, true);
    if (trigger) {
      const item = element("span", "boost-add");
      item.setAttribute("role", "listitem");
      item.append(trigger);
      wrap.append(item);
    }
    return wrap;
  }

  // Native uses the action row for empty posts and a list-tail entry once other
  // people have boosted. Both entries share the same viewer-specific permission.
  function boostTrigger(post, inList = false) {
    if (!canBoost(post) || (!inList && globalThis.LDDiscussion.boosts(post).length)) return null;
    const control = button("表情评论", "boost-compose", {
      className: "boost-action", symbol: "rocket", value: Number.isSafeInteger(post.post_number) ? post.post_number : 0
    });
    control.disabled = !!state.detail?.boostBusy;
    control.setAttribute("aria-haspopup", "dialog");
    control.setAttribute("aria-expanded", "false");
    control.setAttribute("title", `给这个帖子加一句表情评论（最多 ${boostMaxVisible} 个字、${boostMaxEmoji} 个表情）`);
    if (inList) return control;
    const row = element("div", "post-boost-actions");
    row.append(control);
    return row;
  }

  function boostRaw(editor) {
    let raw = "";
    const walk = node => {
      for (const child of node?.childNodes || []) {
        if (typeof child === "string") raw += child;
        else if (child.nodeType === 3) raw += child.textContent;
        else if (child.tagName === "IMG") raw += child.dataset?.emoji ? `:${child.dataset.emoji}:` : child.alt || "";
        else if (child.tagName === "BR") raw += " ";
        else {
          if (raw && /^(DIV|P)$/.test(child.tagName || "") && !raw.endsWith(" ")) raw += " ";
          walk(child);
        }
      }
    };
    walk(editor);
    return raw.replace(/\s+/g, " ").trim();
  }

  function boostStats(raw) {
    let emoji = 0;
    const withoutCodes = raw.replace(/:([a-z0-9_+-]+):/gi, () => { emoji += 1; return "\uFFFC"; });
    let segments;
    try {
      segments = typeof Intl?.Segmenter === "function"
        ? [...new Intl.Segmenter("zh", { granularity: "grapheme" }).segment(withoutCodes)].map(item => item.segment)
        : Array.from(withoutCodes);
    } catch { segments = Array.from(withoutCodes); }
    for (const segment of segments) if (/\p{Extended_Pictographic}/u.test(segment)) emoji += 1;
    return { visible: segments.length, emoji };
  }

  function focusBoostEditor(editor) {
    editor.focus?.({ preventScroll: true });
    try {
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    } catch {}
  }

  function updateBoostComposer(editor) {
    const stats = boostStats(boostRaw(editor));
    const busy = !!state.detail?.boostBusy;
    const over = stats.visible > boostMaxVisible || stats.emoji > boostMaxEmoji;
    const counter = $("#boost-counter");
    if (counter) {
      counter.textContent = `${stats.visible}/${boostMaxVisible}${stats.emoji ? ` · 表情 ${stats.emoji}/${boostMaxEmoji}` : ""}`;
      counter.classList.toggle("over", over);
    }
    const submit = $('[data-action="boost-submit"]');
    if (submit) submit.disabled = busy || !stats.visible || over;
    editor.dataset.empty = stats.visible ? "false" : "true";
    const canAddEmoji = stats.visible + (stats.visible ? 2 : 1) <= boostMaxVisible && stats.emoji < boostMaxEmoji;
    for (const control of root.querySelectorAll('[data-action="boost-emoji"]')) control.disabled = busy || !canAddEmoji;
  }

  function insertBoostEmoji(editor, name) {
    const source = emojiSource(name);
    const stats = boostStats(boostRaw(editor));
    if (!source || state.detail?.boostBusy || stats.visible + (stats.visible ? 2 : 1) > boostMaxVisible || stats.emoji >= boostMaxEmoji) return;
    if (stats.visible) editor.append(" ");
    const image = element("img", "emoji");
    image.dataset.emoji = name;
    image.alt = `:${name}:`;
    image.setAttribute("title", `:${name}:`);
    image.src = source;
    editor.append(image);
    updateBoostComposer(editor);
    try { editor.dispatchEvent(new Event("input", { bubbles: true })); } catch {}
    focusBoostEditor(editor);
  }

  function boostComposer(post) {
    const wrapper = element("div", "boost-composer");
    wrapper.append(element("h3", "popup-label", post.username ? `表情评论 @${post.username}` : "表情评论"));
    const editor = element("div", "boost-editor");
    editor.id = "boost-editor";
    editor.setAttribute("contenteditable", "true");
    editor.setAttribute("role", "textbox");
    editor.setAttribute("aria-label", "表情评论内容");
    editor.setAttribute("aria-multiline", "false");
    editor.setAttribute("data-placeholder", "说点什么… 可插入表情");
    wrapper.append(editor);
    const groups = new Map();
    for (const emoji of emojiSources().list) {
      if (!groups.has(emoji.group)) groups.set(emoji.group, []);
      groups.get(emoji.group).push(emoji);
    }
    const palette = element("div", "boost-palette");
    palette.setAttribute("aria-label", "可选表情");
    if (!groups.size) palette.append(element("p", "popup-empty", "没有可用的自定义表情，可以直接输入表情。"));
    for (const [group, list] of groups) {
      palette.append(element("h4", "boost-emoji-group", group));
      const grid = element("div", "boost-emoji-grid");
      for (const emoji of list) {
        const item = button("", "boost-emoji", { className: "boost-emoji", value: emoji.name });
        item.setAttribute("title", `:${emoji.name}:`);
        item.setAttribute("aria-label", `插入 :${emoji.name}:`);
        const image = element("img");
        image.alt = "";
        image.loading = "lazy";
        image.src = emojiSource(emoji.name) || "";
        item.append(image);
        grid.append(item);
      }
      palette.append(grid);
    }
    wrapper.append(palette);
    const footer = element("div", "boost-footer");
    const counter = element("span", "boost-counter", `0/${boostMaxVisible}`);
    counter.id = "boost-counter";
    const cancel = button("取消", "boost-cancel", { className: "secondary-button" });
    const submit = button("发布", "boost-submit", { className: "boost-submit" });
    submit.disabled = true;
    footer.append(counter, cancel, submit);
    wrapper.append(footer);
    const update = event => { if (!event?.isComposing) updateBoostComposer(editor); };
    editor.addEventListener("input", update);
    editor.addEventListener("compositionend", update);
    editor.addEventListener("paste", event => {
      event.preventDefault();
      const text = String(event.clipboardData?.getData("text/plain") || "").replace(/\s+/g, " ").trim().slice(0, 200);
      if (text) document.execCommand?.("insertText", false, text);
    });
    editor.addEventListener("keydown", event => {
      // Enter confirms an IME candidate for Chinese input instead of submitting.
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Enter") {
        event.preventDefault();
        void submitBoost(post.post_number);
      }
    });
    editor.dataset.empty = "true";
    return wrapper;
  }

  async function submitBoost(floor) {
    const detail = state.detail;
    const post = postByFloor(floor);
    if (!detail || !post || !canBoost(post) || detail.boostBusy) return;
    if (!state.user) { notify("请先登录 Linux.do 后再表情评论。"); return; }
    const editor = $("#boost-editor");
    const raw = editor ? boostRaw(editor) : "";
    const stats = boostStats(raw);
    if (!raw) return;
    if (stats.visible > boostMaxVisible || stats.emoji > boostMaxEmoji) {
      notify(`表情评论最多 ${boostMaxVisible} 个字、${boostMaxEmoji} 个表情。`);
      return;
    }
    detail.boostBusy = true;
    for (const control of root.querySelectorAll('[data-action="boost-submit"], [data-action="boost-cancel"], [data-action="boost-emoji"]')) control.disabled = true;
    try {
      const response = await forum.change(`/discourse-boosts/posts/${Number(post.id)}/boosts.json`, "POST", { raw });
      if (state.detail !== detail) return;
      post.boosts = [...(Array.isArray(post.boosts) ? post.boosts : []), response];
      post.can_boost = false;
      closeMenu();
      notify("表情评论已发布");
    } catch (error) {
      if (state.detail !== detail) return;
      notify(error.message);
      pauseForWrite(error, detail);
    } finally {
      detail.boostBusy = false;
      if (state.detail !== detail) return;
      for (const control of root.querySelectorAll('[data-action="boost-submit"], [data-action="boost-cancel"], [data-action="boost-emoji"]')) control.disabled = false;
      if (editor?.isConnected) updateBoostComposer(editor);
      renderPostFloor(floor);
    }
  }

  async function deleteBoost(boostId) {
    const detail = state.detail;
    if (!detail || detail.boostBusy || !Number.isSafeInteger(boostId)) return;
    if (!state.user) { notify("请先登录 Linux.do。"); return; }
    const post = [...detail.posts.values()].find(item => (Array.isArray(item.boosts) ? item.boosts : []).some(boost => boost.id === boostId));
    const boost = post?.boosts.find(item => item.id === boostId);
    if (!boost || boost.can_delete !== true) return;
    const own = boost.user?.id === state.user.id;
    if (!own && !window.confirm?.("确定删除这条表情评论？")) return;
    detail.boostBusy = true;
    for (const control of root.querySelectorAll('[data-action="delete-boost"]')) control.disabled = true;
    try {
      await forum.change(`/discourse-boosts/boosts/${boostId}.json`, "DELETE");
      if (state.detail !== detail) return;
      post.boosts = post.boosts.filter(boost => boost.id !== boostId);
      if (own) post.can_boost = true;
      notify("已删除表情评论");
    } catch (error) {
      if (state.detail !== detail) return;
      notify(error.message);
      pauseForWrite(error, detail);
    } finally {
      detail.boostBusy = false;
      if (state.detail === detail) renderPostFloor(post.post_number);
    }
  }

  const relatedLimit = 5;

  // Only inbound references are listed, matching the original post-links box;
  // outbound links stay inline in the cooked post instead.
  function linkList(post) {
    const links = globalThis.LDDiscussion.relatedLinks(post);
    if (!links.length) return null;
    const floor = post.post_number;
    const expanded = !!state.detail?.expandedLinks?.has(floor);
    const hidden = Math.max(0, links.length - relatedLimit);
    const container = element("div", "post-links");
    container.setAttribute("role", "group");
    container.setAttribute("aria-label", "相关链接");
    const list = element("ul", "post-links-list");
    for (const link of expanded ? links : links.slice(0, relatedLimit)) {
      const url = forum.safeURL(link.url);
      const row = element("li", "post-link-row");
      const item = element("a", "post-link");
      if (url) {
        item.href = url.href;
        item.target = "_blank";
        item.rel = "noopener noreferrer";
      }
      item.append(icon("link"), element("span", "post-link-title", link.title));
      if (link.clicks) item.append(element("span", "post-link-count", number.format(link.clicks)));
      item.setAttribute("title", (url?.href || link.url) + (link.clicks ? ` · 被点击 ${link.clicks} 次` : ""));
      row.append(item);
      list.append(row);
    }
    container.append(list);
    if (hidden) {
      const toggle = button(expanded ? "收起相关链接" : `其他 ${hidden} 个`, "post-links", {
        className: "post-links-more", value: floor
      });
      toggle.setAttribute("aria-expanded", String(expanded));
      container.append(toggle);
    }
    return container;
  }

  function postExtras(post) {
    if (!post || globalThis.LDDiscussion.postState(post) !== "available") return [];
    return [boostList(post), boostTrigger(post), linkList(post)].filter(Boolean);
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
    const previewStyle = element("link");
    previewStyle.rel = "stylesheet";
    previewStyle.href = asset("image-preview.css");
    root.append(previewStyle);
    const pollStyle = element("link");
    pollStyle.rel = "stylesheet";
    pollStyle.href = asset("polls.css");
    root.append(pollStyle);
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
        <div id="challenge-banner" class="challenge-banner" role="alert" hidden></div>
      </header>
      <div class="workspace">
        <section class="list-pane" aria-label="话题列表">
          <div class="list-header"><h1 id="list-title">最新话题</h1><div id="list-tools"></div></div>
          <div id="list-scroll" class="list-scroll" tabindex="0"><div id="rows"></div><div id="list-footer" aria-live="polite"></div><div id="list-sentinel" aria-hidden="true" style="height:1px"></div></div>
        </section>
        <section id="reading-pane" class="reading-pane" aria-label="阅读区">
          <div id="reading-toolbar" class="reading-toolbar"><div id="reading-back"></div><div id="reading-actions"></div></div>
          <div id="live-status" class="live-status" role="status" aria-live="polite" hidden></div>
          <div id="read-scroll" class="read-scroll" tabindex="0" aria-label="话题与回复">
            <div id="reading" class="reading"></div>
          </div>
        </section>
      </div>
      <div id="menu" class="popup" hidden></div>
      <div id="toast" class="toast" role="status" hidden></div>`;
    root.append(shell);
    imagePreview = globalThis.LDImagePreview?.create({ root, content: () => $("#reading") });
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
    for (const type of ["pointerover", "pointerout", "pointerdown", "pointerup", "pointercancel", "pointermove"]) {
      root.addEventListener(type, interactionPointer);
    }
    root.addEventListener("change", event => {
      if (event.target.id !== "reply-sort" || !state.detail) return;
      changeReplySort(event.target.value);
    });
    listPager = new globalThis.LDScroll.Pager({
      viewport: $("#list-scroll"),
      autoLoadLimit: 1,
      canLoad: () => state.onScreen && !state.listBusy && !state.listError && !!state.next,
      getKey: () => `${state.listGeneration}:${state.view}:${state.category?.id || ""}:${state.tag?.slug || ""}:${state.query}:${state.initialFeedPath || ""}:${state.next}`,
      getSentinel: () => $("#list-sentinel"),
      load: () => loadList(true, false, { background: true }),
      onStateChange: paging => {
        state.listPaging = paging;
        if (root) renderListFooter();
      }
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
    const summary = anchor("", forum.topicPath(topic, topic.hit?.post_number), "topic-select");
    summary.removeAttribute("target");
    summary.dataset.value = topic.id;
    summary.dataset.action = "topic";
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
    const metrics = add(element("span", "metrics"), stat("comment", "回复", topicReplyCount(topic), true),
      stat("eye", "浏览量", topic.views, true), clock);
    summary.append(title, chips, add(element("span", "row-meta"), person, metrics));
    row.append(summary);
    return row;
  }

  function challengeTargetPath() {
    return state.selected ? forum.topicPath(state.detail?.data || state.selected) : "/latest";
  }

  function renderChallengeBanner() {
    if (!root) return;
    const banner = $("#challenge-banner");
    if (!banner || typeof banner.replaceChildren !== "function") return;
    const active = forum.requestQueue?.activeChallenge?.() || null;
    if (!active && !state.challengeCleared) {
      banner.hidden = true;
      banner.classList?.remove?.("cleared");
      banner.replaceChildren();
      return;
    }
    banner.hidden = false;
    banner.classList?.toggle?.("cleared", !active && !!state.challengeCleared);
    let message;
    if (active) {
      const label = active.requestSource || "原站请求";
      const statusLabel = active.status ? `，HTTP ${active.status}` : "";
      message = `原站触发 Cloudflare 人机验证（${label}${statusLabel}），已暂停自动请求。请在新标签页完成验证后返回重试。`;
    } else {
      message = "检测到原站页面已恢复访问，请点击「继续重试」恢复阅读。";
    }
    const actions = add(element("div", "challenge-actions"),
      anchor("前往原站验证", challengeTargetPath(), "secondary-button", "out"),
      button(active ? "已完成验证，重试" : "继续重试", "challenge-retry", { className: "new-topic", symbol: "refresh" }),
      button("刷新本页", "reload-page", { className: "text-button" }));
    banner.replaceChildren(element("span", "challenge-message", message), actions);
  }

  function clearChallengeBeforeRetry() {
    state.challengeCleared = false;
    forum.requestQueue?.clearChallenge?.();
    renderChallengeBanner();
  }

  function retryAfterChallenge() {
    clearChallengeBeforeRetry();
    if (state.topicError && state.selected && !state.detail) selectTopic(state.selected);
    else if (state.listError) {
      if (state.next && state.rows.length) {
        listPager?.resume();
        loadList(true).catch(() => {});
      } else loadList(false, true).catch(() => {});
    } else if (state.detail?.moreError) {
      replyPager?.resume();
      loadReplies().catch(() => {});
    } else if (state.detail?.liveStatus?.error) {
      if (state.detail.live) state.detail.live.refresh();
      else startTopicLive(state.detail);
    } else {
      notify("已解除验证暂停，请重新执行刚才的操作。");
    }
  }

  function maybeClearChallengeFromLoadedPage() {
    if (pageClearedChallenge) return;
    if (!document.getElementById("main-outlet")) return;
    if (!document.querySelector?.(".d-header") && !document.getElementById("data-preloaded")) return;
    pageClearedChallenge = true;
    const active = forum.requestQueue?.activeChallenge?.();
    if (active && pageLoadedAt >= active.detectedAt) forum.requestQueue?.clearChallenge?.();
  }

  function status(message, action, label = "重试") {
    return add(element("div", "status"), element("p", "", message), action && button(label, action, { className: "secondary-button" }));
  }

  function recoveryMessage(message, retryAt) {
    if (!retryAt) return message;
    const reason = String(message).replace(/(?:，已暂停请求)?[，；]?请\s*\d+\s*秒后重试[。.]?$/, "");
    const seconds = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
    return `${reason} · ${seconds ? `${seconds} 秒后可重试` : "等待已结束，可手动重试"}`;
  }

  function renderListFooter() {
    const footer = $("#list-footer");
    footer.replaceChildren();
    const remaining = Math.max(0, (state.listRetryAt || 0) - Date.now());
    if (state.listError) {
      if (state.listChallenge) {
        const retryAction = state.next && state.rows.length ? "more-topics" : "refresh";
        footer.append(add(status(state.listError), add(element("div", "status-actions"),
          anchor("前往原站验证", challengeTargetPath(), "secondary-button", "out"),
          button("已完成验证，重试", retryAction, { className: "new-topic", symbol: "refresh" }))));
      } else if (privateModes.has(state.view) && state.user === null) {
        footer.append(add(status("登录后即可查看这个列表。"), anchor("前往 Linux.do 登录", "/login", "secondary-button", "out")));
      } else {
        const error = status(recoveryMessage(state.listError, state.listRetryAt),
          state.next && state.rows.length ? "more-topics" : "refresh");
        error.querySelector("button").disabled = remaining > 0;
        footer.append(error);
      }
    } else if (state.listBusy) footer.append(status("正在加载话题…"));
    else if (!state.rows.length) {
      const message = state.view === "search" ? "原站未找到匹配的话题。" :
        state.view === "following" ? "你关注或跟踪的话题会显示在这里。" :
        state.view === "bookmarks" ? "收藏的话题会显示在这里。" : "这个列表暂时没有话题。";
      footer.append(status(message));
    } else if (state.next) footer.append(add(element("span", "", state.listPaging?.status === "paused"
      ? "连续分页没有新增可见内容，已暂停自动加载，可手动继续。" : "接近底部按需加载，每次滚动至多一页"),
      button("加载更多", "more-topics", { className: "secondary-button", symbol: "down" })));
    else footer.append(element("span", "", "已加载全部话题"));
    scheduleRecovery();
  }

  // A countdown only updates an error footer; it never starts another request.
  function scheduleRecovery() {
    clearTimeout(recoveryTimer);
    if (!state.onScreen || !((state.listError && state.listRetryAt > Date.now()) ||
        (state.topicError && state.topicRetryAt > Date.now()) ||
        (state.detail?.moreError && state.detail.retryAt > Date.now()) ||
        (state.detail?.liveStatus?.error && state.detail.liveStatus.retryAt > Date.now()))) return;
    recoveryTimer = setTimeout(() => {
      if (state.listError) renderListFooter();
      if (state.topicError && !state.detail) renderReading();
      if (state.detail?.moreError) renderReplyFooter();
      if (state.detail?.liveStatus?.error) renderLiveStatus();
      scheduleRecovery();
    }, 1000);
  }

  function renderList() {
    const rows = $("#rows");
    const scroll = $("#list-scroll");
    const position = scroll.scrollTop;
    const focusedTopic = root.activeElement?.matches('.topic-select') && root.activeElement.dataset.value;
    rows.replaceChildren(...state.rows.map(topicRow));
    renderListFooter();
    scroll.scrollTop = position;
    listPager?.captureScrollPosition();
    if (focusedTopic) $(`.topic-select[data-value="${focusedTopic}"]`)?.focus({ preventScroll: true });
    updateSteps();
    listPager?.check();
  }

  async function loadList(append = false, keepTopic = false, { background = false } = {}) {
    if (append && (!state.next || state.listBusy || state.listRetryAt > Date.now())) return;
    if (append && !background) listPager?.consumeAutoBudget();
    const previousCount = append ? state.rows.length : 0;
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
    state.listChallenge = false;
    state.listRetryAt = 0;
    if (!append && !keepTopic) {
      state.rows = [];
      state.next = null;
      $("#list-scroll").scrollTop = 0;
      clearTopic();
    }
    if (append) renderListFooter();
    else renderList();
    let updated = false;
    try {
      if (privateModes.has(state.view) && state.user === null) throw new Error("请先登录 Linux.do。");
      const data = await forum.feed(path, controller.signal, { background });
      if (controller.signal.aborted) return;
      const unique = new Map((append ? state.rows : []).map(row => [row.id, row]));
      for (const row of data.rows) unique.set(row.id, row);
      state.rows = [...unique.values()];
      state.next = data.next;
      rememberTags(data.tags);
      state.challengeCleared = false;
      renderChallengeBanner();
      updated = true;
      return { progress: state.rows.length > previousCount };
    } catch (error) {
      if (!controller.signal.aborted) {
        state.listError = error.message;
        state.listChallenge = !!error.challenge;
        state.listRetryAt = error.challenge ? 0 : (error.retryAt || Date.now() + (error.retryAfter || 0));
        renderChallengeBanner();
      }
      throw error;
    } finally {
      if (!controller.signal.aborted) {
        state.listBusy = false;
        if (!append || updated) renderList();
        else {
          renderListFooter();
          listPager?.check();
        }
      }
    }
  }

  function switchFeed(view, category = null, tag = null, query = "") {
    Object.assign(state, { view, category, tag, query, initialFeedPath: null });
    closeMenu();
    renderFilters();
    loadList().catch(() => {});
  }

  function clearTopic() {
    clearInteractionTimers();
    imagePreview?.close({ restoreFocus: false });
    polls?.destroy();
    polls = null;
    state.detail?.live?.stop();
    topicRequest?.abort();
    state.selected = null;
    state.topicBusy = false;
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
    if (state.selected?.id === topic.id && (state.detail || state.topicBusy)) return;
    clearInteractionTimers();
    imagePreview?.close({ restoreFocus: false });
    polls?.destroy();
    polls = null;
    state.detail?.live?.stop();
    topicRequest?.abort();
    const controller = new AbortController();
    topicRequest = controller;
    state.selected = topic;
    state.topicBusy = true;
    state.detail = null;
    resetReplyPager(null);
    state.topicError = null;
    state.topicChallenge = false;
    state.topicRetryAt = 0;
    renderList();
    $("#read-scroll").scrollTop = 0;
    renderReading();

    try {
      const data = await forum.request(`/t/${Number(topic.id)}.json`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!data.post_stream?.posts?.length) throw new Error("原站未返回可阅读的楼层。");
      const posts = new Map(data.post_stream.posts.map(post => [post.id, post]));
      const stream = data.post_stream.stream || [...posts.keys()];
      const sort = initialReplySort(topic.readerPath);
      state.detail = { data, stream, posts, attempted: new Set(posts.keys()), collapsed: new Set(), expandedLinks: new Set(), controller,
        pendingFloor: initialFloor || null, moreBusy: false, sort, sortLoadPending: sort === "newest", retryAt: 0 };
      resetReplyPager(state.detail);
      rememberTags(data.tags);
      state.challengeCleared = false;
      renderChallengeBanner();
      renderReading();
      startTopicLive(state.detail);
      if (initialFloor && initialFloor > 1) focusPost(initialFloor, false);
    } catch (error) {
      if (controller.signal.aborted) return;
      state.topicError = error.message;
      state.topicChallenge = !!error.challenge;
      state.topicRetryAt = error.challenge ? 0 : (Number.isFinite(error.retryAt) ? error.retryAt : 0);
      renderReading();
      renderChallengeBanner();
      scheduleRecovery();
    } finally {
      if (topicRequest === controller) state.topicBusy = false;
    }
  }

  function getNativeClient() {
    if (!nativeClient) {
      if (!globalThis.LDLive) throw new Error("请重新加载扩展并刷新首页，以启用原版回复与实时消息。");
      nativeClient = new globalThis.LDLive.NativeClient();
    }
    return nativeClient;
  }

  function startTopicLive(detail) {
    if (!state.onScreen || state.detail !== detail) return;
    try {
      detail.live = new globalThis.LDLive.TopicSession({
        client: getNativeClient(), forum, detail,
        isVisible: () => state.onScreen && state.detail === detail && !document.hidden && navigation.readerRoute(location.pathname),
        currentUserId: state.user?.id, presenceEnabled: true,
        onStatus: live => {
          if (state.detail !== detail) return;
          detail.liveStatus = live;
          renderLiveStatus();
          renderChallengeBanner();
          if (!live.busy) {
            maybeLoadSortedPage();
            replyPager?.check();
          }
          scheduleRecovery();
        },
        onChange: ({ opChanged }) => {
          if (state.detail !== detail || !state.onScreen) return;
          if (opChanged) refreshReadingView();
          else {
            $("#topic-metrics")?.replaceWith(topicMetrics(detail));
            renderReplies();
          }
        }
      });
      void detail.live.start();
    } catch (error) {
      detail.liveStatus = { phase: "paused", error: error.message, users: [], count: 0 };
      renderLiveStatus();
    }
  }

  function refreshReadingView() {
    const viewport = $("#read-scroll");
    const top = viewport.getBoundingClientRect().top;
    const visible = [...root.querySelectorAll("[data-post-number]")].find(node => node.getBoundingClientRect().bottom > top);
    const floor = visible?.dataset.postNumber;
    const offset = visible?.getBoundingClientRect().top;
    const position = viewport.scrollTop;
    renderReading();
    const replacement = floor && $(`[data-post-number="${floor}"]`);
    if (replacement) viewport.scrollTop += replacement.getBoundingClientRect().top - offset;
    else viewport.scrollTop = position;
    replyPager?.captureScrollPosition();
  }

  function renderLiveStatus() {
    if (!root) return;
    const bar = $("#live-status");
    if (!bar) return;
    const detail = state.detail;
    bar.hidden = !detail;
    bar.replaceChildren();
    if (!detail) return;
    const live = detail.liveStatus || { phase: "connecting", users: [], count: 0 };
    const seconds = Math.max(0, Math.ceil(((live.retryAt || 0) - Date.now()) / 1000));
    const message = live.error ? `实时更新已暂停 · ${recoveryMessage(live.error, live.retryAt)}`
      : live.phase === "connecting" ? "正在连接原版实时消息…"
      : live.pending ? `等待更新 ${live.pending} 条回复` : live.busy && !live.presenceBusy ? "正在同步实时状态…" : "原版消息通道 · 新回复自动更新";
    bar.append(element("span", live.error ? "live-message error" : "live-message", message));
    const typing = element("span", "live-presence");
    typing.setAttribute("aria-label", "正在回复状态");
    if (live.presenceBusy) {
      typing.classList.add("muted");
      typing.append("正在同步正在回复状态…");
    } else if (live.presenceError || live.presenceUnavailable) {
      typing.classList.add("muted");
      typing.append(live.presenceError || "原站未提供正在回复状态。");
    } else if (live.presenceReady && live.count > 0) {
      for (const user of (live.users || []).slice(0, 5)) typing.append(avatar(user, 20));
      const names = (live.users || []).slice(0, 3).map(user => user.display_username || user.username).filter(Boolean).join("、");
      typing.append(element("span", "", names ? `${names}${live.count > 3 ? ` 等 ${live.count} 人` : ""}正在回复…` : `${live.count} 人正在回复…`));
    } else {
      typing.classList.add("muted");
      typing.append(live.presenceReady ? "暂无其他人正在回复" : "正在回复状态尚未同步");
    }
    bar.append(typing);
    const retry = button(live.challenge ? "已完成验证，重试" : live.error ? "重试实时更新" : "更新回复", "refresh-posts", { className: "text-button", symbol: "refresh" });
    retry.disabled = seconds > 0 || live.busy || live.phase === "connecting";
    const requests = button("请求记录", "menu", { value: "requests", className: "text-button" });
    requests.setAttribute("aria-expanded", "false");
    if (live.challenge) bar.append(anchor("前往原站验证", challengeTargetPath(), "text-button", "out"));
    bar.append(retry);
    if (live.presenceError && !live.presenceUnavailable) {
      const presenceRetry = button("重试正在回复状态", "refresh-presence", { className: "text-button", symbol: "refresh" });
      presenceRetry.disabled = seconds > 0 || live.busy || live.phase === "connecting" || !!live.error;
      bar.append(presenceRetry);
    }
    bar.append(requests);
  }

  function canReply(detail) {
    if (!state.user) return true; // The native login dialog handles guests.
    const allowed = detail.data.details?.can_create_post;
    if (typeof allowed === "boolean") return allowed;
    if (detail.data.archived) return false;
    return !detail.data.closed || !!(state.user.staff || state.user.admin || state.user.moderator);
  }

  function replyButton(detail, post, label = "回复") {
    const control = button(state.user === null ? "登录后回复" : label, "reply", {
      className: "reply-button", value: post?.post_number || 0, symbol: "reply"
    });
    control.disabled = !!detail.replyBusy || !canReply(detail);
    control.setAttribute("aria-label", post ? `回复 #${post.post_number}` : "回复主题");
    if (!canReply(detail)) control.title = "原站当前不允许回复此话题。";
    return control;
  }

  async function replyTo(floor) {
    const detail = state.detail;
    if (!detail || detail.replyBusy || !canReply(detail) || !state.onScreen || !navigation.readerRoute(location.pathname)) return;
    const post = floor > 0 ? [...detail.posts.values()].find(value => value.post_number === floor) : null;
    if (floor > 0 && (!post || globalThis.LDDiscussion.postState(post) !== "available")) return;
    if (forum.requestQueue.cooldown()) {
      const error = forum.requestQueue.busyError();
      detail.live?.pause(error);
      notify(error.message);
      return;
    }
    if (forum.requestQueue?.activeChallenge?.()) {
      const error = forum.requestQueue.challengeError();
      detail.live?.pause(error);
      renderChallengeBanner();
      notify(error.message);
      return;
    }
    detail.replyBusy = true;
    for (const control of root.querySelectorAll('[data-action="reply"]')) control.disabled = true;
    try {
      const { data } = detail;
      const topic = Object.fromEntries(["id", "title", "fancy_title", "slug", "category_id", "closed", "archived", "archetype", "draft_key", "draft_sequence", "posts_count", "highest_post_number"]
        .map(key => [key, data[key]]));
      topic.details = { can_create_post: data.details?.can_create_post };
      const target = post && Object.fromEntries(["id", "post_number", "topic_id", "user_id", "post_type", "username", "display_username", "name", "avatar_template"].map(key => [key, post[key]]));
      const result = await getNativeClient().reply(topic, target);
      if (result?.opened === false && !result.login && state.detail === detail) notify("原站编辑器尚未打开，请重试或在原站回复。");
    } catch (error) {
      if (error.challenge) {
        forum.requestQueue?.noteChallenge?.({ source: error.requestSource === "composer" ? "composer" : "draft", status: error.status });
        if (state.detail === detail) detail.live?.pause(forum.requestQueue?.challengeError?.() || error);
        renderChallengeBanner();
      } else if (error.status === 429 || [502, 503, 504].includes(error.status) && (error.retryAfter != null || error.retryAt != null)) {
        const delay = Number.isFinite(error.retryAt) ? Math.max(0, error.retryAt - Date.now())
          : Number.isFinite(error.retryAfter) ? Math.max(0, error.retryAfter) : 5000;
        forum.requestQueue.defer(delay, { source: error.requestSource === "composer" ? "composer" : "draft", status: error.status });
        if (state.detail === detail) detail.live?.pause(forum.requestQueue.busyError());
        scheduleRecovery();
      }
      if (error.name !== "AbortError" && state.detail === detail && state.onScreen) notify(error.message);
    } finally {
      detail.replyBusy = false;
      if (state.detail === detail && state.onScreen) {
        for (const control of root.querySelectorAll('[data-action="reply"]')) control.disabled = !canReply(detail);
        sizeReader();
      }
    }
  }

  function replyPerson(post, op, showLevel = true) {
    const postState = globalThis.LDDiscussion.postState(post);
    if (postState !== "available") {
      const label = postState === "deleted" ? "[已删除]" : post?.placeholder === "missing-parent" ? "[未加载或不可用]" : "[内容暂不可用]";
      return add(element("span", "post-author unavailable-author"), element("strong", "author-name", label));
    }
    const label = post.display_username || post.username || "原站用户";
    const name = post.username
      ? anchor(label, "/u/" + encodeURIComponent(post.username), "author-name")
      : element("strong", "author-name", label);
    return add(element("span", "post-author"), avatar(post, op ? 36 : 24), name,
      op ? element("small", "op-badge", "楼主") : null,
      showLevel && Number.isInteger(post.trust_level) ? element("small", "level", "L" + post.trust_level) : null);
  }

  function getPolls() {
    if (!polls && globalThis.LDPolls) polls = globalThis.LDPolls.create({
      forum, document,
      getContext: () => ({ detail: state.detail, user: state.user, onScreen: state.onScreen }),
      onChange: () => { if (state.detail && state.onScreen) refreshReadingView(); },
      onError: error => {
        if (error?.challenge || forum.requestQueue?.activeChallenge?.()) {
          state.detail?.live?.pause(forum.requestQueue?.challengeError?.() || error);
          renderChallengeBanner();
        } else if (forum.requestQueue.cooldown()) state.detail?.live?.pause(error);
        notify(error.message);
        scheduleRecovery();
      }
    });
    return polls;
  }

  function postContent(post) {
    const node = element("div", "post-content");
    const postState = globalThis.LDDiscussion.postState(post);
    if (postState === "deleted") {
      node.classList.add("post-placeholder", "deleted-content");
      node.textContent = "[此楼层已删除]";
    } else if (postState === "unavailable") {
      node.classList.add("post-placeholder", "unavailable-content");
      node.textContent = post?.placeholder === "missing-parent"
        ? "此父楼层未加载或不可用，无法判断是否已删除；已加载的子回复仍显示在下方。"
        : "此楼层内容暂不可用。";
    } else if (post?.cooked) {
      const widgets = getPolls()?.render(post) || [];
      const remaining = new Map(widgets.map(widget => [widget.dataset.pollName, widget]));
      node.append(forum.cooked(post.cooked, { renderPoll: name => {
        const widget = remaining.get(name);
        if (widget) remaining.delete(name);
        if (widget || !globalThis.LDPolls) return widget;
        return add(element("section", "ld-poll"), element("p", "poll-notice", "原站未返回此投票的数据，请到原站查看和参与。"),
          anchor("打开原站投票", forum.topicPath(state.detail.data, post.post_number), "poll-original-link"));
      } }));
      // Metadata may precede a recooked body; don't lose a serialized poll solely
      // because its static placeholder is absent from cooked HTML.
      node.append(...remaining.values());
    } else {
      const widgets = getPolls()?.render(post) || [];
      if (widgets.length) node.append(...widgets);
      else node.textContent = "此楼层暂无可显示的内容。";
    }
    return node;
  }

  function renderReading() {
    const toolbar = $("#reading-actions");
    const content = $("#reading");
    toolbar.replaceChildren();
    content.replaceChildren();
    renderLiveStatus();
    updateSteps();
    if (!state.selected) {
      content.append(add(element("div", "reading-empty"), icon("list"), element("p", "", "从左侧选择一篇话题")));
      return;
    }
    const { selected, detail } = state;
    toolbar.append(anchor("在 Linux.do 打开", forum.topicPath(detail?.data || selected), "original", "out"));
    if (selected.hit?.post_number > 1) toolbar.prepend(anchor("查看命中楼层", forum.topicPath(selected, selected.hit.post_number), "original", "search"));
    if (!detail) {
      if (state.topicError && state.topicChallenge) {
        content.append(add(status(state.topicError), add(element("div", "status-actions"),
          anchor("前往原站验证", challengeTargetPath(), "secondary-button", "out"),
          button("已完成验证，重试", "retry-topic", { className: "new-topic", symbol: "refresh" }))));
      } else {
        const message = state.topicError ? status(recoveryMessage(state.topicError, state.topicRetryAt), "retry-topic") : status("正在读取话题…");
        if (state.topicError) message.querySelector("button").disabled = state.topicRetryAt > Date.now();
        content.append(message);
      }
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
    toolbar.prepend(readingBookmark, button(level, "menu", { className: "level-button menu-toggle", symbol: "bell", value: "notification" }),
      replyButton(detail, null, "回复主题"));

    const op = [...posts.values()].find(post => post.post_number === 1);
    const category = state.categories.get(data.category_id);
    const breadcrumb = add(element("div", "breadcrumb"), categoryPill(category),
      data.closed ? element("span", "tag", "已关闭") : null);
    const header = element("header", "article-header");
    if (breadcrumb.childNodes.length) header.append(breadcrumb);
    header.append(element("h2", "article-title", data.title || selected.title));
    if (op) {
      header.append(add(element("div", "article-meta"), replyPerson(op, true), date(op.created_at)));
    } else header.append(date(data.created_at));
    const tags = (data.tags || []).slice(0, 12);
    if (tags.length) header.append(add(element("div", "chips article-tags"), ...tags.map(tag => tagPill(tag))));
    const mainPost = add(element("article", "op-content"), postContent(op));
    if (op) {
      mainPost.dataset.postNumber = op.post_number;
      mainPost.append(...postExtras(op), postControls(detail, op));
    }
    content.append(header, topicMetrics(detail), mainPost);
    if (detail.pendingFloor && ![...detail.posts.values()].some(post => post.post_number === detail.pendingFloor)) {
      content.append(anchor(`在原站查看 #${detail.pendingFloor}`, forum.topicPath(data, detail.pendingFloor), "secondary-button", "out"));
    }
    const replies = element("section", "replies");
    replies.id = "reply-section";
    content.append(replies);
    renderReplies();
  }

  // An explicit order change keeps the viewport, not the old floor's location.
  // Latest also reads one page from the stream's tail, even far from the footer.
  function changeReplySort(value) {
    const detail = state.detail;
    if (!detail || !["oldest", "newest", "top"].includes(value) || detail.sort === value) return;
    detail.sort = value;
    detail.sortGeneration = (detail.sortGeneration || 0) + 1;
    detail.sortLoadPending = value === "newest" && pendingPostIds(detail).length > 0;
    if (value === "newest" && detail.retryAt <= Date.now()) detail.moreError = null;
    replyPager?.reset();
    replyPager?.consumeAutoBudget();
    renderReplies({ preservePosition: true });
    $("#reply-sort")?.focus({ preventScroll: true });
    maybeLoadSortedPage();
  }

  function maybeLoadSortedPage() {
    const detail = state.detail;
    if (!detail?.sortLoadPending || detail.sort !== "newest" || !state.onScreen ||
        detail.moreBusy || detail.live?.busy || detail.moreError || detail.retryAt > Date.now() || detail.controller.signal.aborted) return;
    detail.sortLoadPending = false;
    if (!pendingPostIds(detail).length) return;
    void loadReplies({ preservePosition: true }).catch(() => {});
  }

  function renderReplies({ preservePosition = false } = {}) {
    const detail = state.detail;
    const section = $("#reply-section");
    if (!detail || !section) return;
    const { posts, data, collapsed, attempted, stream } = detail;
    const discussion = globalThis.LDDiscussion;
    const viewport = $("#read-scroll");
    const position = viewport.scrollTop;
    const keepPosition = preservePosition || !!detail.sortLoading ||
      detail.renderedSort != null && detail.renderedSort !== detail.sort;
    detail.renderedSort = detail.sort;
    const bounds = viewport.getBoundingClientRect();
    const visible = [...section.querySelectorAll(".reply-card")].find(node => {
      const rect = node.getBoundingClientRect();
      return rect.bottom > bounds.top && rect.top < bounds.bottom;
    });
    const anchorFloor = visible?.dataset.replyFloor;
    const anchorTop = visible?.getBoundingClientRect().top;
    const restoreSortFocus = root.activeElement?.id === "reply-sort";
    const byNumber = new Map([...posts.values()].map(post => [post.post_number, post]));
    const total = topicReplyCount(data, state.selected);
    const loaded = [...posts.values()].filter(post => post.post_number > 1).length;
    const heading = add(element("div", "replies-heading"),
      add(element("div", "reply-title"), icon("tree"), element("h3", "", "树状讨论"), element("span", "reply-count", total ?? "—")));
    const tools = element("div", "reply-tools");
    const sortLabel = element("label", "reply-sort-label", "排序");
    sortLabel.htmlFor = "reply-sort";
    const sortSelect = element("select", "reply-sort");
    sortSelect.id = "reply-sort";
    sortSelect.setAttribute("aria-describedby", "reply-sort-note");
    for (const [value, label] of [["oldest", "最早"], ["newest", "最新"], ["top", "最多点赞"]]) {
      const option = element("option", "", label);
      option.value = value;
      sortSelect.append(option);
    }
    sortSelect.value = ["oldest", "newest", "top"].includes(detail.sort) ? detail.sort : "oldest";
    tools.append(sortLabel, sortSelect);
    heading.append(tools);
    const sortNote = element("p", "reply-sort-note", detail.sort === "newest"
      ? "优先读取最新回复；各分支的同级回复分别按最新排序。"
      : detail.sort === "top" ? "点赞排序仅基于已加载回复；各分支的同级回复分别排序。"
      : "从最早的未加载回复继续读取；各分支的同级回复分别排序。");
    sortNote.id = "reply-sort-note";
    section.replaceChildren(heading, sortNote);
    if (!loaded && total === 0) section.append(status("还没有回复。"));
    else if (!loaded && total == null) section.append(status("回复总数暂不可用。"));
    const tree = element("ol", "tree");
    tree.setAttribute("aria-label", "按回复关系排列的楼层");
    const queue = [];
    for (const node of discussion.replyTree(posts.values(), sortSelect.value).reverse()) queue.push({ node, depth: 0, list: tree });
    while (queue.length) {
      const { node, depth, list } = queue.pop();
      const { post, children, state: postState } = node;
      const floor = post.post_number;
      const expanded = !collapsed.has(floor);
      const placeholder = post.placeholder === "missing-parent";
      const row = element("li", "tree-row" + (postState === "deleted" ? " deleted-row" : placeholder ? " unavailable-row" : ""));
      row.id = "reply-" + floor;
      const track = element("div", "tree-track");
      if (children.length) {
        const toggle = button(expanded ? "折叠分支" : "展开分支", "branch", {
          value: floor, iconOnly: true, symbol: expanded ? "minus" : "plus", className: "branch-toggle"
        });
        toggle.setAttribute("aria-expanded", String(expanded));
        toggle.setAttribute("aria-label", `${expanded ? "折叠" : "展开"} #${floor} 的回复分支`);
        track.append(toggle);
      } else track.append(element("span", "branch-dot"));
      const article = element("article", "reply-card");
      article.dataset.replyFloor = floor;
      if (!placeholder) article.dataset.postNumber = floor;
      const meta = add(element("div", "reply-meta"),
        post.created_at ? date(post.created_at, true) : null,
        anchor("#" + floor, forum.topicPath(data, floor), "floor"));
      if (depth > 3) meta.prepend(element("span", "depth-label", `层级 ${depth + 1}`));
      const head = add(element("div", "reply-header"), replyPerson(post, post.user_id != null && post.user_id === data.user_id), meta);
      article.append(head);
      if (post.reply_to_post_number > 1) {
        const related = byNumber.has(post.reply_to_post_number)
          ? button("回复 #" + post.reply_to_post_number, "jump", { className: "parent-ref", value: post.reply_to_post_number, symbol: "reply" })
          : anchor("回复 #" + post.reply_to_post_number, forum.topicPath(data, post.reply_to_post_number), "parent-ref", "reply");
        article.append(related);
      }
      article.append(postContent(post));
      if (postState === "available") {
        article.append(...postExtras(post), postControls(detail, post));
      }
      if (placeholder) article.append(anchor(`在原站查看 #${floor}`, forum.topicPath(data, floor), "parent-ref", "out"));
      if (!expanded && children.length) article.append(button(`展开 ${children.length} 条直属回复`, "branch", {
        className: "collapsed-children", value: floor, symbol: "down"
      }));
      row.append(add(element("div", "tree-entry"), track, article));
      list.append(row);
      if (expanded && children.length) {
        const branch = element("ol", depth >= 2 ? "branch deep-branch" : "branch");
        row.append(branch);
        for (let i = children.length - 1; i >= 0; i--) queue.push({ node: children[i], depth: depth + 1, list: branch });
      }
    }
    if (loaded) section.append(tree);
    section.append(populateReplyFooter(element("div", "reply-footer"), detail));
    viewport.scrollTop = position;
    if (!keepPosition && anchorFloor) {
      const replacement = section.querySelector(`[data-reply-floor="${anchorFloor}"]`);
      if (replacement) viewport.scrollTop += replacement.getBoundingClientRect().top - anchorTop;
    }
    replyPager?.captureScrollPosition();
    if (restoreSortFocus) sortSelect.focus({ preventScroll: true });
    replyPager?.check();
  }

  function populateReplyFooter(footer, detail) {
    const total = topicReplyCount(detail.data, state.selected);
    const loaded = [...detail.posts.values()].filter(post => post.post_number > 1).length;
    const pending = pendingPostIds(detail).length > 0;
    const paused = detail.paging?.status === "paused";
    const retrySeconds = Math.max(0, Math.ceil(((detail.retryAt || 0) - Date.now()) / 1000));
    const children = [element("span", "", total == null
      ? `已载入 ${loaded} 条回复，总数暂不可用`
      : `已载入 ${loaded} / ${Math.max(total, loaded)} 条回复`)];
    if (paused) children.push(element("span", "paging-paused", "自动加载已暂停：未取得高度进展或遇到重复游标，可手动继续。"));
    else if (pending && !detail.moreError && !retrySeconds) children.push(element("span", "", "继续滚动或手动加载，每次至多一页"));
    if (pending || detail.moreError || paused || detail.moreBusy || retrySeconds) {
      if (detail.moreChallenge) children.push(anchor("前往原站验证", challengeTargetPath(), "secondary-button", "out"));
      const more = button(detail.moreBusy ? "正在加载…" : detail.moreChallenge ? "已完成验证，重试"
        : retrySeconds ? `${retrySeconds} 秒后重试` : detail.moreError ? "重试" : "手动加载更多",
        "more-posts", { className: detail.moreChallenge ? "new-topic" : "secondary-button", symbol: detail.moreChallenge ? "refresh" : "down" });
      more.disabled = !!detail.moreBusy || (!detail.moreChallenge && retrySeconds > 0);
      children.push(more);
    }
    if (detail.moreError) children.push(element("span", "error", detail.moreChallenge ? detail.moreError : recoveryMessage(detail.moreError, detail.retryAt)));
    footer.replaceChildren(...children);
    return footer;
  }

  function renderReplyFooter() {
    const detail = state.detail;
    const footer = $("#reply-section .reply-footer");
    if (!detail || !footer) return;
    const hadMoreFocus = root.activeElement?.dataset?.action === "more-posts" && footer.contains(root.activeElement);
    populateReplyFooter(footer, detail);
    if (hadMoreFocus) {
      const more = footer.querySelector('[data-action="more-posts"]');
      if (more && !more.disabled) more.focus({ preventScroll: true });
    }
    scheduleRecovery();
  }

  function pendingPostIds(detail) {
    const pending = detail.stream.filter(id => !detail.attempted.has(id) && !detail.live?.hasPending(id));
    // The topic JSON stream is chronological. Reverse a copy, never its source:
    // live reconciliation and a later oldest order still use the original stream.
    return detail.sort === "newest" ? pending.reverse() : pending;
  }

  function resetReplyPager(detail) {
    replyPager?.destroy();
    replyPager = null;
    if (!detail) return;
    replyPager = new globalThis.LDScroll.Pager({
      viewport: $("#read-scroll"),
      autoLoadLimit: 1,
      canLoad: () => state.onScreen && state.detail === detail && !detail.moreBusy && !detail.live?.busy && !detail.moreError && pendingPostIds(detail).length > 0,
      getKey: () => `${detail.data.id}:${detail.sort}:${pendingPostIds(detail)[0]}`,
      getSentinel: () => $("#reply-section .reply-footer"),
      load: () => loadReplies({ background: true }),
      onStateChange: paging => {
        detail.paging = paging;
        // Only a safety pause needs another footer render; loading/error states
        // already render from loadReplies, preserving the current anchor.
        if (paging.status === "paused" && state.detail === detail) renderReplyFooter();
      }
    });
  }

  async function loadReplies({ background = false, preservePosition = false } = {}) {
    const detail = state.detail;
    if (!detail || detail.moreBusy || detail.live?.busy || detail.retryAt > Date.now()) return;
    const sortGeneration = detail.sortGeneration || 0;
    const previousCount = detail.posts.size;
    const ids = pendingPostIds(detail).slice(0, Math.min(detail.data.chunk_size || 20, 30));
    if (!ids.length) return;
    if (detail.sort === "newest") detail.sortLoadPending = false;
    if (!background) replyPager?.consumeAutoBudget();
    detail.loadingIds = new Set(ids);
    detail.sortLoading = preservePosition;
    detail.moreBusy = true;
    detail.moreError = null;
    detail.moreChallenge = false;
    detail.retryAt = 0;
    let updated = false;
    renderReplyFooter();
    try {
      const posts = await forum.postsPage(detail.data.id, ids, detail.controller.signal, { background });
      if (detail.controller.signal.aborted || state.detail !== detail) return;
      for (const id of ids) detail.attempted.add(id);
      for (const post of posts) {
        if (!detail.live?.tombstones.has(post.id)) {
          detail.posts.set(post.id, post);
          updated = true;
        }
      }
      state.challengeCleared = false;
      renderChallengeBanner();
      return { progress: detail.posts.size > previousCount };
    } catch (error) {
      if (!detail.controller.signal.aborted && state.detail === detail) {
        detail.moreError = error.message;
        detail.moreChallenge = !!error.challenge;
        detail.retryAt = error.challenge ? 0 : (error.retryAt || Date.now() + (error.retryAfter || 0));
        renderChallengeBanner();
        scheduleRecovery();
      }
      throw error;
    } finally {
      detail.loadingIds.clear();
      detail.moreBusy = false;
      detail.sortLoading = false;
      if (state.detail === detail) {
        if (updated || sortGeneration !== (detail.sortGeneration || 0)) {
          renderReplies({ preservePosition: preservePosition || sortGeneration !== (detail.sortGeneration || 0) });
        } else {
          renderReplyFooter();
          replyPager?.check();
        }
        maybeLoadSortedPage();
        detail.live?.kick();
      }
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
      if (state.view === "bookmarks") loadList(false, true).catch(() => {});
    } catch (error) {
      notify(error.message);
      pauseForWrite(error, detail);
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
      if (state.view === "following") loadList(false, true).catch(() => {});
    } catch (error) {
      notify(error.message);
      pauseForWrite(error, detail);
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
    if (name === "requests") {
      menu.append(element("h3", "popup-label", "最近 10 次阅读器请求"));
      menu.append(element("p", "popup-empty", "仅本页内存记录，不含网址或正文；不涵盖原站自身请求，也不能证明是哪次操作累积触发限流。"));
      const records = forum.requestQueue.diagnostics?.() || [];
      if (!records.length) menu.append(element("p", "popup-empty", "本页暂无阅读器请求记录。"));
      const timeFormat = new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
      for (const record of [...records].reverse()) {
        const timestamp = Number.isFinite(record.startedAt) ? timeFormat.format(record.startedAt) : "时间未知";
        const nativeFailure = ["原版草稿读取", "原版编辑器"].includes(record.requestSource);
        const result = record.challenge ? (record.status ? `人机验证 (${record.status})` : "人机验证")
          : record.completedAt == null ? "进行中" : record.status === 0 ? "网络失败或取消" : `结果码 ${record.status}`;
        menu.append(add(element("div", "request-record"), element("strong", "", record.requestSource),
          element("span", "muted", `${nativeFailure ? "收到失败 " : ""}${timestamp} · ${record.background ? "后台" : "前台"}${nativeFailure ? "" : ` ${record.method}`} · ${result}`)));
      }
      menu.append(button("关闭记录", "close-menu", { className: "popup-item" }));
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
    if (name === "reactions") {
      const post = state.openMenu?.context?.post;
      if (!post) return;
      menu.append(element("h3", "popup-label", "表情回应"));
      const grid = element("div", "reaction-picker");
      const mine = post.current_user_reaction;
      for (const id of reactionIds(post)) {
        const choice = button("", "react", { className: "reaction-choice", value: id });
        choice.dataset.post = String(post.post_number);
        choice.setAttribute("title", `:${id}:`);
        choice.setAttribute("aria-label", `回应 :${id}:`);
        choice.append(emojiImage(id, 22, "reaction-emoji"));
        const selected = mine?.id === id;
        choice.setAttribute("aria-pressed", String(selected));
        if (selected) choice.classList.add("checked");
        choice.disabled = !reactionAllowed(post) || !!state.detail?.reactionBusyFloors?.has(post.post_number);
        grid.append(choice);
      }
      menu.append(grid, element("p", "popup-empty", "点击即回应，再点同一个表情可取消。"));
    }
    if (name === "boost") {
      const post = state.openMenu?.context?.post;
      if (!post) return;
      menu.append(boostComposer(post));
    }
  }

  function openMenu(name, trigger, context = null) {
    closeSidebar();
    const wasOpen = state.openMenu?.trigger === trigger;
    closeMenu();
    if (wasOpen) return;
    state.openMenu = { name, trigger, context };
    trigger.setAttribute("aria-expanded", "true");
    populateMenu(name);
    const menu = $("#menu");
    const { left, right, bottom } = trigger.getBoundingClientRect();
    const width = Math.min(context?.width || 298, innerWidth - 24);
    menu.style.width = width + "px";
    menu.style.left = Math.max(12, Math.min(left > innerWidth / 2 ? right - width : left, innerWidth - width - 12)) + "px";
    menu.style.top = bottom + 8 + "px";
    menu.style.maxHeight = Math.max(160, innerHeight - bottom - 20) + "px";
    menu.hidden = false;
    const focusable = menu.querySelector("input") || menu.querySelector("[contenteditable]") || menu.querySelector("button") || menu.querySelector("a");
    if (context?.focus !== false) {
      focusable?.focus({ preventScroll: true });
      if (focusable?.getAttribute?.("contenteditable") === "true") focusBoostEditor(focusable);
    }
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
    if (imagePreview?.handleClick(event)) { closeMenu(); closeSidebar(); return; }
    const control = event.target.closest("[data-action]");
    const inMenu = event.target.closest("#menu");
    const action = control?.dataset.action;
    const value = control?.dataset.value;
    if (control?.disabled || control?.getAttribute("aria-disabled") === "true") return;
    if (["react", "boost-compose"].includes(action)) {
      clearTimeout(interactionHoverTimer);
      clearTimeout(interactionCloseTimer);
    }
    if (action === "react" && control._readerLongPressUntil > Date.now()) {
      control._readerLongPressUntil = 0;
      event.preventDefault?.();
      return;
    }
    if (!inMenu && !["menu", "close-menu", "boost-compose"].includes(action)) closeMenu();
    if (action !== "sidebar") closeSidebar();
    if (!control) return;
    switch (action) {
      case "poll-option":
      case "poll-submit":
      case "poll-results":
      case "poll-remove":
        event.preventDefault();
        void getPolls()?.handle(action, control);
        break;
      case "mode": closeMenu(true); switchFeed(value); break;
      case "category": switchFeed("latest", state.categories.get(Number(value)) || null, state.tag); break;
      case "tag": switchFeed("latest", state.category, control._readerTag || null); break;
      case "menu": openMenu(value, control); break;
      case "close-menu": closeMenu(true); break;
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
        clearTopic();
        $(".topic-select")?.focus({ preventScroll: true });
        break;
      case "topic": {
        // Keep native modifier/middle-click behavior; ordinary activation opens
        // the tree in-place without an extra native detail navigation/request.
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button > 0) return;
        event.preventDefault();
        const row = state.rows.find(topic => topic.id === Number(value));
        if (row) selectTopic({ ...row, readerPath: control.href }, true, row.hit?.post_number);
        if (host.clientWidth <= 760) $(".mobile-back").focus({ preventScroll: true });
        break;
      }
      case "step": {
        const index = state.rows.findIndex(topic => topic.id === state.selected?.id);
        const row = state.rows[index + Number(value)];
        if (row) selectTopic(row);
        break;
      }
      case "challenge-retry": retryAfterChallenge(); break;
      case "reload-page": location.reload(); break;
      case "refresh": clearChallengeBeforeRetry(); loadList(false, true).catch(() => {}); break;
      case "more-topics": clearChallengeBeforeRetry(); listPager?.resume(); loadList(true).catch(() => {}); break;
      case "retry-topic": clearChallengeBeforeRetry(); selectTopic(state.selected); break;
      case "reply": void replyTo(Number(value)); break;
      case "refresh-presence":
        clearChallengeBeforeRetry();
        state.detail?.live?.refreshPresence();
        break;
      case "refresh-posts":
        clearChallengeBeforeRetry();
        if (state.detail?.live) state.detail.live.refresh();
        else if (state.detail) startTopicLive(state.detail);
        break;
      case "more-posts": clearChallengeBeforeRetry(); replyPager?.resume(); loadReplies().catch(() => {}); break;
      case "bookmark": changeBookmark(); break;
      case "level": closeMenu(true); changeLevel(Number(value)); break;
      case "jump": focusPost(Number(value)); break;
      case "post-links": {
        const detail = state.detail;
        const floor = Number(value);
        if (!detail || !Number.isSafeInteger(floor)) break;
        const post = [...detail.posts.values()].find(item => item.post_number === floor);
        const current = control.closest(".post-links");
        if (!post || !current) break;
        const expanded = detail.expandedLinks ||= new Set();
        if (expanded.has(floor)) expanded.delete(floor);
        else expanded.add(floor);
        const replacement = linkList(post);
        if (replacement) current.replaceWith(replacement);
        else current.remove();
        replacement?.querySelector(".post-links-more")?.focus({ preventScroll: true });
        break;
      }
      case "react": {
        const floor = Number(control.dataset.post || 0);
        const reaction = String(control.dataset.reaction || value || "");
        if (state.openMenu) closeMenu(true);
        void toggleReaction(floor, reaction);
        break;
      }
      case "boost-compose": {
        const post = postByFloor(Number(value));
        if (!post || !canBoost(post)) break;
        if (!state.user) { notify("请先登录 Linux.do 后再表情评论。"); break; }
        openMenu("boost", control, { post, width: 332 });
        break;
      }
      case "boost-emoji": {
        const editor = $("#boost-editor");
        if (editor) insertBoostEmoji(editor, String(value || ""));
        break;
      }
      case "boost-submit": {
        const floor = Number(state.openMenu?.context?.post?.post_number || 0);
        void submitBoost(floor);
        break;
      }
      case "boost-cancel": closeMenu(true); break;
      case "delete-boost": void deleteBoost(Number(value)); break;
      case "branch": {
        const floor = Number(value);
        const collapsed = state.detail.collapsed;
        if (collapsed.has(floor)) collapsed.delete(floor);
        else collapsed.add(floor);
        renderReplies();
        $(`.branch-toggle[data-value="${floor}"]`)?.focus({ preventScroll: true });
        break;
      }
    }
  }

  function keydown(event) {
    if (imagePreview?.handleKeydown(event)) return;
    if (event.key === "ArrowDown" && !event.defaultPrevented && !event.isComposing &&
        !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      const control = event.target.closest?.('.reaction-action[data-action="react"]');
      const floor = Number(control?.dataset.value);
      const post = control && postByFloor(floor);
      if (state.onScreen && control && root.contains(control) && !control.disabled &&
          control.getAttribute("aria-disabled") !== "true" && post && reactionAllowed(post) &&
          !state.detail?.reactionBusyFloors?.has(floor) && readerSettings().enable_emoji !== false) {
        event.preventDefault();
        event.stopPropagation();
        clearInteractionTimers();
        if (state.openMenu?.name !== "reactions" || state.openMenu.trigger !== control) {
          openMenu("reactions", control, { post, width: 276 });
        } else {
          $("#menu button")?.focus({ preventScroll: true });
        }
        return;
      }
    }
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

  async function loadContext() {
    contextRequest?.abort();
    const controller = new AbortController();
    contextRequest = controller;
    const render = () => {
      if (controller.signal.aborted || !state.onScreen) return;
      renderFilters();
      renderList();
      if (state.detail) {
        if (state.detail.live) state.detail.live.currentUserId = state.user?.id;
        refreshReadingView();
      }
    };
    try {
      // Reuse the already-loaded native account/site data: no account poller or
      // duplicate /site + /tags reads during the usual page initialization.
      const context = await getNativeClient().context();
      if (controller.signal.aborted) return;
      state.nativeContext = context;
      state.user = context.user || null;
      state.categories = new Map((context.categories || []).map(category => [category.id, category]));
      rememberTags(context.tags);
      render();
    } catch (error) {
      if (controller.signal.aborted) return;
      // A bounded fallback for Discourse versions without a compatible owner;
      // it is never retried on a timer and is canceled on leaving home.
      await Promise.allSettled([
        forum.account({ signal: controller.signal, background: true }).then(user => { if (!controller.signal.aborted) state.user = user; }),
        forum.request("/site.json", { signal: controller.signal, priority: 1, background: true }).then(site => {
          if (controller.signal.aborted) return;
          state.categories = new Map((site.categories || []).map(category => [category.id, category]));
          rememberTags(site.top_tags);
          rememberTags(site.navigation_menu_site_top_tags);
        }),
        forum.request("/tags.json", { signal: controller.signal, priority: 1, background: true }).then(data => {
          if (!controller.signal.aborted) rememberTags(data.tags);
        })
      ]);
      render();
    }
    if (controller.signal.aborted || !state.onScreen) return;
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
    modeSwitch.hidden = !navigation.readerRoute(location.pathname);
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
    clearInteractionTimers();
    imagePreview?.close({ restoreFocus: false });
    if (!preserveMode) readerMode = false;
    pendingOpen = false;
    clearTimeout(recoveryTimer);
    listRequest?.abort();
    contextRequest?.abort();
    nativeClient?.close();
    nativeClient = null;
    if (!state.nativeContext && state.user === undefined) contextLoaded = false;
    state.listBusy = false;
    topicRequest?.abort();
    if (state.detail) state.detail.moreBusy = false;
    if (!state.onScreen) return;
    clearTopic();
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
    const composer = document.getElementById("reply-control")?.getBoundingClientRect();
    const bottom = composer?.height > 0 && composer.bottom > 0 ? Math.min(window.innerHeight, composer.top) : window.innerHeight;
    const height = Math.max(160, Math.floor(bottom - top));
    host.style.setProperty("--ld-reader-height", height + "px");
    syncSidebar();
  }

  function syncNativeLayout() {
    maybeClearChallengeFromLoadedPage();
    if (!navigation.readerRoute(location.pathname)) {
      // Discourse is an SPA: leaving home must also tear down an already-open
      // reader, not just prevent the next mount. No controls/theme/layout remain.
      pendingOpen = false;
      hideReader(false, true);
      outlet?.classList.remove(outletClass);
      host?.remove();
      modeSwitch?.remove();
      headerObserver?.disconnect();
      outlet = null;
      nativeHeader = null;
      readerMode = true;
      return;
    }
    if (readerMode && !state.onScreen) pendingOpen = true;
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
      pendingOpen = readerMode && navigation.readerRoute(location.pathname);
    }
    outlet = siteOutlet;
    updateMode();
    if (pendingOpen && modeSwitch.isConnected && outlet) showReader();
    const composer = document.getElementById("reply-control");
    if (composer) headerObserver.observe(composer);
    if (state.onScreen) { syncHeaderLogo(); sizeReader(); }
    syncSidebar();
  }

  function showReader() {
    // Default-deny every non-home route, including explicit URL/action requests.
    // A topic selected from the home list is rendered in-place, never a /t/ route.
    if (!navigation.readerRoute(location.pathname)) return false;
    readerMode = true;
    if (state.onScreen) return true;
    if (!outlet?.isConnected || !modeSwitch?.isConnected) {
      pendingOpen = true;
      return true;
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
      const route = navigation.feedRoute("/", location.search);
      Object.assign(state, { view: route.view, initialFeedPath: route.path, category: null, tag: null, query: "" });
      renderFilters();
      loadList().catch(() => {});
    }
    listPager?.reset();
    replyPager?.check();
    renderListFooter();
    renderChallengeBanner();
    return true;
  }

  function applyNativeNavigation() {
    if (state.onScreen && originalLocation === location.pathname + location.search) return;
    if (state.onScreen) hideReader(false, true);
    pendingOpen = readerMode && navigation.readerRoute(location.pathname);
    syncNativeLayout();
  }

  extension?.onMessage?.addListener((message, sender, respond) => {
    if (message.type !== "linux-do-reader:open") return;
    respond({ open: showReader() });
  });

  function requestedURL() {
    if (!navigation.readerRoute(location.pathname)) return false;
    const url = new URL(location.href);
    return url.searchParams.get("ld-reader") === "1" || url.hash === "#ld-reader";
  }

  function openFromURL() {
    if (!navigation.readerRoute(location.pathname)) return false;
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
    if (requestedAtStart || requestedURL()) openFromURL();
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
    if (navigation.readerRoute(location.pathname)) showReader();
    window.addEventListener("pagehide", () => hideReader(false, true));
    window.addEventListener("pageshow", syncNativeLayout);
    document.addEventListener("visibilitychange", () => state.detail?.live?.visibilityChanged());
    window.addEventListener("storage", event => {
      if (event.key !== "linux-do-reader-challenge" && event.key !== null) return;
      const active = forum.requestQueue?.activeChallenge?.();
      if (!active && (state.listChallenge || state.topicChallenge || state.detail?.moreChallenge ||
          state.detail?.liveStatus?.challenge || event.oldValue)) {
        state.challengeCleared = true;
      } else if (active) {
        state.challengeCleared = false;
      }
      if (state.onScreen && root) renderChallengeBanner();
    });
    window.addEventListener("hashchange", () => { if (requestedURL()) openFromURL(); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
  else initialize();
})();
