(() => {
  "use strict";
  const origin = "https://linux.do";
  if (location.origin !== origin || window.__LDReaderNativeReady) return;
  window.__LDReaderNativeReady = true;

  const requestType = "linux-do-reader:native-request";
  const responseType = "linux-do-reader:native-response";
  const eventType = "linux-do-reader:native-event";
  const watches = new Map();
  let eventService, routerService, routeEpoch = 0;
  let replySession, saveGuard, openingToken;
  const pendingReplies = new Map();
  const savedPosts = new Map();
  const home = () => location.pathname === "/";
  const positive = value => Number.isSafeInteger(value) && value > 0;
  const cursor = value => Number.isSafeInteger(value) && value >= -1;
  const token = value => typeof value === "string" && value.length > 0 && value.length <= 160 && !/[\u0000-\u001f\u007f]/.test(value);
  const identifier = value => token(value) || positive(value);
  const watchKey = (clientId, watchId) => `${clientId}\u0000${watchId}`;

  class NativeError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }

  function requireModule(name) {
    const loader = window.require;
    if (typeof loader !== "function") return null;
    try { return loader(name); } catch { return null; }
  }

  function owner() {
    // Discourse's inject-objects initializer sets the fallback owner. The
    // fallback is required: @ember/owner.getOwner() cannot find a bare window.
    const module = requireModule("discourse/lib/get-owner");
    try {
      const value = module?.getOwnerWithFallback?.() || window.Discourse?.__container__ || window.Discourse;
      return typeof value?.lookup === "function" ? value : null;
    } catch { return null; }
  }

  function lookup(container, name) {
    try { return container?.lookup(name); } catch { return null; }
  }

  function get(model, key) {
    if (typeof model?.get === "function") return model.get(key);
    return key.split(".").reduce((value, part) => value?.[part], model);
  }

  function pick(value, fields) {
    const result = {};
    if (!value || typeof value !== "object") return result;
    for (const key of fields) {
      const item = get(value, key);
      if (typeof item === "string") result[key] = item.slice(0, 4096);
      else if (typeof item === "boolean" || item === null) result[key] = item;
      else if (typeof item === "number" && Number.isFinite(item)) result[key] = item;
    }
    return result;
  }

  const userFields = ["id", "username", "name", "display_username", "avatar_template", "admin", "moderator", "staff", "whisperer", "trust_level"];
  const publicUser = value => pick(value, userFields);
  const users = values => Array.isArray(values) ? values.slice(0, 1000).map(publicUser).filter(user => positive(user.id)) : [];

  function post(message) {
    try { window.postMessage(message, origin); } catch { /* A page can disappear during delivery. */ }
  }

  function stream(watch, kind, data, messageId) {
    if (!home()) { cleanup(); return; }
    if (watches.get(watchKey(watch.clientId, watch.watchId)) !== watch) return;
    post({ type: eventType, clientId: watch.clientId, watchId: watch.watchId, kind, data, messageId });
  }

  function release(watch) {
    watches.delete(watchKey(watch.clientId, watch.watchId));
    for (const { channel, callback } of watch.subscriptions) {
      // The callback argument is essential: a channel-only unsubscribe would
      // remove the site's own topic/composer/presence subscriptions as well.
      try { watch.bus.unsubscribe(channel, callback); } catch { /* Never alter the singleton to recover. */ }
    }
  }

  function restoreSaveGuard() {
    const guard = saveGuard;
    saveGuard = null;
    if (!guard) return;
    guard.active = false;
    // Do not overwrite a plugin's later save wrapper. If it still delegates to
    // ours, our now-inactive wrapper transparently calls the original method.
    try {
      if (guard.composer.save !== guard.wrapper) return;
      if (guard.descriptor) Object.defineProperty(guard.composer, "save", guard.descriptor);
      else delete guard.composer.save;
    } catch { /* A changed descriptor may forbid restoration; inactive is safe. */ }
  }

  function guardSave(composer, model, clientId) {
    if (saveGuard?.composer === composer && saveGuard.model === model && saveGuard.clientId === clientId) return;
    restoreSaveGuard();
    const original = composer.save;
    if (typeof original !== "function") throw new NativeError("COMPOSER_UNAVAILABLE", "原站提交接口不兼容，请使用原版页面回复。");
    const guard = { composer, model, clientId, topicId: get(model, "topic.id"), original, descriptor: Object.getOwnPropertyDescriptor(composer, "save"), epoch: routeEpoch, active: true };
    guard.wrapper = function (...args) {
      if (guard.active && this === composer && this.model !== model && saveGuard === guard) restoreSaveGuard();
      if (guard.active && home() && routeEpoch === guard.epoch && this === composer && this.model === model) {
        if (replySession?.clientId === clientId) {
          replySession.topicId = get(model, "topic.id");
          replySession.postId = get(model, "post.id");
        }
        // Discourse save(false, {jump:false}) recurses into this.save(true)
        // without forwarding options on the homepage. Keep native this/force,
        // permissions, slow-mode checks and confirmation flow completely intact.
        // Only the owned native session's jump option is supplied again.
        const next = [...args];
        next[1] = { ...(args[1] || {}), jump: false };
        return Reflect.apply(original, this, next);
      }
      return Reflect.apply(original, this, args);
    };
    try {
      const descriptor = guard.descriptor;
      Object.defineProperty(composer, "save", descriptor && !descriptor.configurable
        ? { ...descriptor, value: guard.wrapper }
        : { value: guard.wrapper, writable: true, configurable: true, enumerable: descriptor?.enumerable || false });
    } catch { guard.active = false; throw new NativeError("COMPOSER_UNSUPPORTED", "无法安全保留首页，请使用原版页面回复。"); }
    saveGuard = guard;
  }

  function cancelReply(clientId, topicId) {
    const token = pendingReplies.get(clientId);
    if (token && (topicId == null || token.topicId === topicId)) token.cancelled = true;
    if (saveGuard?.clientId === clientId && (topicId == null || saveGuard.topicId === topicId)) restoreSaveGuard();
    if (replySession?.clientId === clientId && (topicId == null || replySession.topicId === topicId)) replySession = null;
  }

  function dispose(clientId) {
    for (const value of [...watches.values()]) if (value.clientId === clientId) release(value);
    cancelReply(clientId);
    return { disposed: true };
  }

  function cleanup() {
    routeEpoch++;
    for (const token of pendingReplies.values()) token.cancelled = true;
    for (const watch of [...watches.values()]) release(watch);
    restoreSaveGuard();
    replySession = null;
    savedPosts.clear();
  }

  function onRouteChanged() { if (!home()) cleanup(); }

  function reportSaved(id, topicId, type) {
    if (!positive(id) || !positive(topicId) || !home()) return;
    if (type === "created") {
      const key = `${topicId}:${id}`;
      if (savedPosts.has(key)) return;
      savedPosts.set(key, true);
      if (savedPosts.size > 200) savedPosts.delete(savedPosts.keys().next().value);
    }
    const data = { id, topic_id: topicId, type, postId: id, topicId };
    for (const watch of watches.values()) if (watch.topicId === topicId) stream(watch, "saved", data, undefined);
  }

  function onPostCreated(createdPost) {
    reportSaved(get(createdPost, "id"), get(createdPost, "topic_id") || get(createdPost, "topic.id"), "created");
  }

  function onComposerWillOpen() {
    // UI hooks may arrive after our open() promise. The same native model is
    // still our session; only an actual model replacement relinquishes it.
    if (saveGuard && saveGuard.composer.model === saveGuard.model) return;
    restoreSaveGuard();
    replySession = null;
  }

  function onComposerEdited() {
    if (replySession?.epoch === routeEpoch && saveGuard?.active && saveGuard.composer.model === saveGuard.model) reportSaved(replySession.postId, replySession.topicId, "revised");
  }

  function attachEvents(container) {
    const service = lookup(container, "service:app-events");
    if (service && service !== eventService && typeof service.on === "function" && typeof service.off === "function") {
      detachEvents();
      eventService = service;
      service.on("page:changed", onRouteChanged);
      service.on("post:created", onPostCreated);
      service.on("composer:will-open", onComposerWillOpen);
      service.on("composer:edited-post", onComposerEdited);
      // composer:saved is intentionally not subscribed: it also fires for
      // action=enqueued, which is NOT a publicly created reply.
    }
    const router = lookup(container, "service:router");
    if (router && router !== routerService && typeof router.on === "function" && typeof router.off === "function") {
      routerService?.off("routeDidChange", onRouteChanged);
      routerService = router;
      router.on("routeDidChange", onRouteChanged);
    }
  }

  function detachEvents() {
    if (eventService) {
      eventService.off("page:changed", onRouteChanged);
      eventService.off("post:created", onPostCreated);
      eventService.off("composer:will-open", onComposerWillOpen);
      eventService.off("composer:edited-post", onComposerEdited);
      eventService = null;
    }
    routerService?.off("routeDidChange", onRouteChanged);
    routerService = null;
  }

  function preload(key) {
    const store = requireModule("discourse/lib/preload-store")?.default;
    try {
      const value = store?.get?.(key);
      if (value !== undefined && value !== null) return value;
      const data = JSON.parse(document.getElementById("data-preloaded")?.textContent || "{}");
      return typeof data[key] === "string" ? JSON.parse(data[key]) : data[key];
    } catch { return null; }
  }

  function readSettings(container) {
    return lookup(container, "service:site-settings") || preload("siteSettings") || {};
  }

  function context() {
    const container = owner();
    if (container) attachEvents(container);
    const currentUser = lookup(container, "service:current-user") || preload("currentUser");
    const site = lookup(container, "service:site") || preload("site") || {};
    const settings = readSettings(container);
    const categories = get(site, "categories") || [];
    const tags = get(site, "top_tags") || get(site, "tags") || [];
    return {
      user: currentUser && positive(get(currentUser, "id")) ? {
        ...publicUser(currentUser),
        visibleGroups: Array.isArray(get(currentUser, "visibleGroups") || get(currentUser, "groups"))
          ? (get(currentUser, "visibleGroups") || get(currentUser, "groups")).slice(0, 1000).map(group => pick(group, ["id", "name"])) : []
      } : null,
      categories: Array.isArray(categories) ? categories.slice(0, 1000).map(category => pick(category, ["id", "name", "slug", "color", "text_color", "parent_category_id", "position", "description_text"])) : [],
      tags: Array.isArray(tags) ? tags.slice(0, 1000).map(tag => typeof tag === "string" ? { name: tag.slice(0, 256) } : pick(tag, ["id", "name", "slug", "count", "topic_count"])) : [],
      presenceEnabled: typeof settings.presence_enabled === "boolean" ? settings.presence_enabled : null
    };
  }

  function sharedCursor(bus, channel, requested) {
    // message-bus-client serializes data[channel] = callback.last_id in callback
    // order, so the LAST callback wins. Preserve exactly that existing cursor.
    // A lower cursor can replay old deltas into native presence and provoke its
    // unbounded /presence/get retry; a higher one can skip native consumers.
    const existing = bus.callbacks.filter(callback => callback.channel === channel).at(-1);
    if (existing) {
      if (!cursor(existing.last_id)) throw new NativeError("MESSAGE_BUS_UNSUPPORTED", "原站实时连接版本不兼容，请使用原版页面。");
      return { lastId: existing.last_id, needsSnapshot: !cursor(requested) || existing.last_id === -1 || existing.last_id > requested };
    }
    return { lastId: cursor(requested) ? requested : -1, needsSnapshot: !cursor(requested) || requested === -1 };
  }

  function watch(clientId, payload) {
    if (!identifier(payload?.watchId) || !positive(payload?.topicId)) throw new NativeError("INVALID_WATCH", "阅读话题的实时订阅参数无效。");
    const key = watchKey(clientId, payload.watchId);
    const old = watches.get(key);
    if (old?.topicId === payload.topicId) return old.result;
    if (old) release(old);
    if (watches.size >= 16) throw new NativeError("TOO_MANY_WATCHES", "阅读器实时订阅过多，请关闭其它阅读区后重试。");
    const container = owner();
    const bus = lookup(container, "service:message-bus") || window.MessageBus;
    // Refuse an unknown client implementation instead of changing existing
    // subscriptions blindly. We neither create a client nor start its poller.
    if (!bus || typeof bus.subscribe !== "function" || typeof bus.unsubscribe !== "function" || !Array.isArray(bus.callbacks)) {
      throw new NativeError("MESSAGE_BUS_UNAVAILABLE", "原站实时连接尚未就绪，可手动更新或使用原版页面。");
    }
    attachEvents(container);
    const settings = readSettings(container);
    if (typeof settings.presence_enabled !== "boolean") throw new NativeError("NATIVE_NOT_READY", "原站尚未完成初始化，请稍后手动更新或使用原版页面。");
    const value = { clientId, watchId: payload.watchId, topicId: payload.topicId, bus, subscriptions: [] };
    const topicChannel = `/topic/${value.topicId}`;
    const topicCursor = sharedCursor(bus, topicChannel, payload.topicLastId);
    const topicCallback = (data, _globalId, messageId) => {
      const safe = pick(data, ["id", "post_number", "updated_at", "user_id", "last_editor_id", "type", "version", "username", "posts_count", "highest_post_number", "last_posted_at", "notification_level"]);
      stream(value, "topic", safe, cursor(messageId) ? messageId : undefined);
    };
    let presenceChannel, presenceCursor;
    const presenceEnabled = settings?.presence_enabled === true;
    if (presenceEnabled) {
      presenceChannel = `/presence/discourse-presence/reply/${value.topicId}`;
      presenceCursor = sharedCursor(bus, presenceChannel, payload.presenceLastId);
    }
    value.result = { watchId: value.watchId, topicId: value.topicId, needsTopicSnapshot: topicCursor.needsSnapshot, presenceEnabled };
    watches.set(key, value);
    try {
      value.subscriptions.push({ channel: topicChannel, callback: topicCallback });
      bus.subscribe(topicChannel, topicCallback, topicCursor.lastId);
      if (presenceEnabled) {
        const callback = (data, _globalId, messageId) => {
          const safe = {};
          if (Array.isArray(data?.entering_users)) safe.entering_users = users(data.entering_users);
          if (Array.isArray(data?.leaving_user_ids)) safe.leaving_user_ids = data.leaving_user_ids.filter(positive).slice(0, 1000);
          if (Number.isSafeInteger(data?.count_delta)) safe.count_delta = data.count_delta;
          stream(value, "presence", safe, cursor(messageId) ? messageId : undefined);
        };
        value.subscriptions.push({ channel: presenceChannel, callback });
        bus.subscribe(presenceChannel, callback, presenceCursor.lastId);
      }
    } catch (error) { release(value); throw error; }
    return value.result;
  }

  function unwatch(clientId, payload) {
    if (!identifier(payload?.watchId)) return { released: false };
    const value = watches.get(watchKey(clientId, payload.watchId));
    if (!value) {
      if (positive(payload.topicId)) cancelReply(clientId, payload.topicId);
      return { released: false };
    }
    release(value);
    cancelReply(clientId, value.topicId);
    return { released: true };
  }

  async function reply(clientId, payload, requestToken) {
    const input = payload?.topic;
    if (!positive(input?.id)) throw new NativeError("INVALID_TOPIC", "无法确定回复的话题，请重新打开帖子。");
    const container = owner();
    const currentUser = lookup(container, "service:current-user");
    if (!currentUser) {
      // Invoke the site's actual login control rather than guessing an Ember
      // login service API or navigating the reader to a different route.
      const control = document.querySelector("button.login-button");
      if (control && !control.disabled && typeof control.click === "function") { control.click(); return { opened: false, login: true }; }
      throw new NativeError("LOGIN_REQUIRED", "请先在 Linux.do 原版登录，再回复话题。");
    }
    if (input.details?.can_create_post !== true) {
      throw new NativeError("REPLY_FORBIDDEN", input.archived ? "该话题已归档，当前账号不能回复。" : input.closed ? "该话题已关闭，当前账号不能回复。" : "当前账号没有回复该话题的权限。");
    }
    const settings = readSettings(container);
    if (settings?.site_archived === true) throw new NativeError("SITE_ARCHIVED", "原站当前只读，不能回复。");
    const composer = lookup(container, "service:composer") || lookup(container, "controller:composer");
    const store = lookup(container, "service:store");
    const Composer = requireModule("discourse/models/composer")?.default;
    const Draft = requireModule("discourse/models/draft")?.default;
    const saveDescriptor = composer && Object.getOwnPropertyDescriptor(composer, "save");
    const protectedSave = saveDescriptor && !saveDescriptor.configurable && (!Object.hasOwn(saveDescriptor, "value") || !saveDescriptor.writable);
    if (!composer || typeof composer.open !== "function" || typeof composer.save !== "function" || protectedSave || (!saveDescriptor && !Object.isExtensible(composer)) || typeof store?.createRecord !== "function" || !Composer?.REPLY || !Composer?.OPEN) {
      throw new NativeError("COMPOSER_UNAVAILABLE", "原站编辑器尚未就绪，请使用原版页面回复。");
    }
    if (get(composer.model, "loading") === true || get(composer.model, "isSaving") === true || (Composer.SAVING && get(composer.model, "composeState") === Composer.SAVING)) {
      throw new NativeError("COMPOSER_BUSY", "原版编辑器正在处理提交，请稍候再回复。");
    }
    if (!token(input.draft_key) || !Number.isSafeInteger(input.draft_sequence) || input.draft_sequence < 0) {
      throw new NativeError("DRAFT_UNAVAILABLE", "原站草稿状态未就绪，请更新帖子后再回复。");
    }
    const target = payload.post;
    if (target != null && (!positive(target.id) || !positive(target.post_number) || (target.topic_id != null && target.topic_id !== input.id))) {
      throw new NativeError("INVALID_POST", "回复楼层与当前话题不符。");
    }
    if (target?.deleted_at || target?.user_deleted || target?.hidden) throw new NativeError("POST_UNAVAILABLE", "该楼层已删除或隐藏，请回复话题而非该楼层。");
    const epoch = routeEpoch;
    // Discourse's cached-record hydration consumes attrs in place, including
    // deleting unchanged draft_key/draft_sequence. Never read request identity
    // back from the object given to store.createRecord().
    const topicId = input.id, draftKey = input.draft_key, draftSequence = input.draft_sequence;
    requestToken.topicId = topicId;
    const ensureCurrent = () => {
      if (!home() || epoch !== routeEpoch) throw new NativeError("LEFT_HOMEPAGE", "已离开首页，取消阅读器回复会话。");
      if (requestToken.cancelled) throw new NativeError("REPLY_CANCELLED", "已关闭或切换阅读区，取消打开原版编辑器。");
    };
    ensureCurrent();
    const topic = store.createRecord("topic", { ...input, details: { ...input.details } });
    if (get(topic, "details.can_create_post") !== true) throw new NativeError("REPLY_FORBIDDEN", "原站不允许当前账号回复该话题。");
    if (input.post_stream && typeof get(topic, "postStream")?.updateFromJson === "function") get(topic, "postStream").updateFromJson(input.post_stream);
    const targetPost = target && target.post_number > 1 ? store.createRecord("post", { ...pick(target, ["id", "topic_id", "post_number", "username", "name", "display_username", "user_id", "avatar_template", "post_type", "reply_to_post_number"]), topic }) : null;
    const opts = { action: Composer.REPLY, topic, draftKey, draftSequence, skipJumpOnSave: true };
    if (targetPost) opts.post = targetPost;
    attachEvents(container);
    eventService?.trigger("page:compose-reply", topic);
    ensureCurrent();
    // Match the native reply action: a persisted draft must be restored before
    // open; a malformed or unrecognized draft is never cleared automatically.
    const model = composer.model;
    const sameReply = get(model, "topic.id") === topicId && get(model, "action") === Composer.REPLY && get(model, "draftKey") === draftKey;
    if (sameReply && typeof model?.setProperties === "function") {
      // Closing and collapsing are different native lifecycles: close() clears
      // model; collapse() keeps it in DRAFT at 40px. The site's reopen action
      // restores the saved height without reloading/replacing the unsaved body.
      if (get(model, "composeState") === Composer.DRAFT) {
        if (typeof composer.openIfDraft !== "function") throw new NativeError("COMPOSER_UNSUPPORTED", "原版草稿暂不能安全展开，请在原版页面继续回复。");
        composer.openIfDraft();
      } else if (![Composer.OPEN, Composer.FULLSCREEN].filter(Boolean).includes(get(model, "composeState"))) {
        throw new NativeError("COMPOSER_BUSY", "原版编辑器状态正在变化，请稍候再回复。");
      }
      ensureCurrent();
      if (composer.model !== model) throw new NativeError("COMPOSER_BUSY", "原版编辑器已切换，请重新选择回复。");
      model.setProperties({ post: targetPost });
      // New Discourse models store reply_to_* independently from post; changing
      // only post leaves the outgoing reply aimed at the previous floor.
      if (typeof model.setReplyTo === "function") model.setReplyTo(targetPost?.post_number, targetPost && { ...pick(targetPost, ["username", "name", "avatar_template"]), id: get(targetPost, "user_id") });
      if (typeof composer.set === "function") composer.set("skipJumpOnSave", true);
      else composer.skipJumpOnSave = true;
    } else {
      if (typeof Draft?.get !== "function") throw new NativeError("DRAFT_UNAVAILABLE", "原站草稿接口不可用，请使用原版页面回复，避免覆盖已有草稿。");
      requestToken.phase = "draft";
      const draft = await Draft.get(opts.draftKey);
      ensureCurrent();
      if (Number.isSafeInteger(draft?.draft_sequence) && draft.draft_sequence >= 0) opts.draftSequence = draft.draft_sequence;
      if (draft?.draft) {
        let data;
        try { data = typeof draft.draft === "string" ? JSON.parse(draft.draft) : draft.draft; } catch { throw new NativeError("INVALID_DRAFT", "原版草稿无法读取，请在原版处理；阅读器不会覆盖或删除它。"); }
        if (!data || typeof data !== "object" || typeof data.reply !== "string") throw new NativeError("INVALID_DRAFT", "原版草稿格式不兼容，请在原版处理；阅读器不会覆盖或删除它。");
        opts.reply = data.reply;
        if (typeof data.whisper === "boolean") opts.whisper = data.whisper;
        if (typeof Composer.isEditDraft === "function" && Composer.isEditDraft(data)) opts.draft = data;
        else if (data.action && data.action !== Composer.REPLY) throw new NativeError("DRAFT_CONFLICT", "已有其它操作的原版草稿，请先在原版处理。");
        else {
          // Native loadDraft restores all registered fields, including reply
          // target, typing time and plugin metadata. Body-only restoration
          // would overwrite those fields on the next native autosave.
          opts.draft = { ...data, action: Composer.REPLY };
        }
      }
      requestToken.phase = "composer";
      await composer.open(opts); // The original service owns discard/dirty-draft confirmations.
    }
    ensureCurrent();
    const opened = get(composer.model, "topic.id") === topicId && [Composer.OPEN, Composer.FULLSCREEN].filter(Boolean).includes(get(composer.model, "composeState"));
    if (opened) {
      guardSave(composer, composer.model, clientId);
      replySession = { clientId, topicId, postId: get(composer.model, "post.id"), epoch };
    }
    return { opened };
  }

  async function onMessage(event) {
    if (event.source !== window || event.origin !== origin) return;
    const data = event.data;
    if (!data || data.type !== requestType || !token(data.clientId)) return;
    if (data.action !== "unwatch" && data.action !== "dispose" && !identifier(data.requestId)) return;
    let result, replyPhase;
    try {
      // Cleanup actions remain valid after navigation; every other action is
      // strictly the exact homepage, including /topic, /t and /latest exclusions.
      if (data.action !== "unwatch" && data.action !== "dispose" && !home()) { cleanup(); throw new NativeError("NOT_HOMEPAGE", "阅读器仅限 Linux.do 首页，其它页面保留原版。"); }
      switch (data.action) {
        case "context": result = context(); break;
        case "watch": result = watch(data.clientId, data.payload); break;
        case "unwatch": result = unwatch(data.clientId, data.payload); break;
        case "dispose": result = dispose(data.clientId); break;
        case "reply": {
          if (openingToken && (!openingToken.cancelled || openingToken.phase === "composer")) throw new NativeError("COMPOSER_BUSY", "正在打开原版编辑器，请稍候再操作。");
          const token = { clientId: data.clientId, topicId: data.payload?.topic?.id, cancelled: false };
          openingToken = token;
          pendingReplies.set(data.clientId, token);
          try { result = await reply(data.clientId, data.payload, token); }
          finally {
            replyPhase = token.phase;
            if (pendingReplies.get(data.clientId) === token) pendingReplies.delete(data.clientId);
            if (openingToken === token) openingToken = null;
          }
          break;
        }
        default: throw new NativeError("UNKNOWN_ACTION", "不支持的阅读器原生操作。");
      }
      if (identifier(data.requestId)) post({ type: responseType, clientId: data.clientId, requestId: data.requestId, ok: true, result });
    } catch (error) {
      const statusValue = error?.status ?? error?.jqXHR?.status;
      const status = Number.isInteger(statusValue) && statusValue >= 400 && statusValue <= 599 ? statusValue : undefined;
      const failure = error instanceof NativeError ? { code: error.code, message: error.message } : { code: "NATIVE_UNAVAILABLE", message: status === 429 ? "原站限流，已停止打开编辑器，请稍后手动重试。" : "原站编辑器暂不可用，请手动重试或使用原版页面。" };
      if (status) {
        failure.status = status;
        if (data.action === "reply") failure.requestSource = replyPhase === "draft" ? "draft" : "composer";
      }
      if (status === 429 || [502, 503, 504].includes(status)) {
        // Read the already received native AJAX headers. No retry, timer or
        // separate request is introduced; the isolated queue owns the cooldown.
        try {
          const xhr = error?.jqXHR || error;
          const header = xhr?.getResponseHeader?.("Retry-After")?.trim();
          const now = Date.now();
          const serverDate = Date.parse(xhr?.getResponseHeader?.("Date"));
          const seconds = typeof header === "string" && /^\d+(?:\.\d+)?$/.test(header) ? Number(header) : NaN;
          const date = header ? Date.parse(header) : NaN;
          const ms = Number.isFinite(seconds) ? Math.ceil(seconds * 1000) : Number.isFinite(date) ? Math.max(0, date - (Number.isFinite(serverDate) ? serverDate : now)) : NaN;
          if (Number.isSafeInteger(ms) && ms >= 0 && Number.isSafeInteger(now + ms)) { failure.retryAfter = ms; failure.retryAt = now + ms; }
        } catch { /* Missing headers are left to the queue's documented fallback. */ }
      }
      if (identifier(data.requestId)) post({ type: responseType, clientId: data.clientId, requestId: data.requestId, ok: false, error: failure });
    }
  }

  window.addEventListener("message", onMessage);
  window.addEventListener("popstate", onRouteChanged);
  window.addEventListener("hashchange", onRouteChanged);
  window.addEventListener("pagehide", () => { cleanup(); detachEvents(); });
  // Navigation API catches same-document pushState before the Ember page event;
  // it is optional, and no history/router/global transport methods are patched.
  window.navigation?.addEventListener?.("navigate", event => {
    try { if (new URL(event.destination.url).pathname !== "/") cleanup(); } catch { cleanup(); }
  });
})();
