import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../native.js", import.meta.url), "utf8");
const plain = value => JSON.parse(JSON.stringify(value));
const settle = () => new Promise(resolve => setImmediate(resolve));

class Record {
  constructor(data = {}) { Object.assign(this, data); }
  get(key) { return key.split(".").reduce((value, part) => value?.[part], this); }
  set(key, value) { this[key] = value; }
  setProperties(data) { Object.assign(this, data); }
  getProperties(...keys) { return Object.fromEntries(keys.map(key => [key, this.get(key)])); }
}

function evented() {
  const handlers = new Map();
  return {
    handlers,
    on(name, callback) { const list = handlers.get(name) || []; list.push(callback); handlers.set(name, list); },
    off(name, callback) { handlers.set(name, (handlers.get(name) || []).filter(item => item !== callback)); },
    trigger(name, ...args) { for (const callback of [...(handlers.get(name) || [])]) callback(...args); }
  };
}

function fixture(options = {}) {
  const outputs = [], subscriptions = [], cancellations = [], lookups = [], moduleRequests = [], draftGets = [], opened = [], records = [];
  const listeners = new Map();
  const navigation = evented();
  navigation.addEventListener = navigation.on;
  const appEvents = evented(), router = evented();
  const document = {
    querySelector(selector) { return selector === "button.login-button" ? options.loginControl : null; },
    getElementById(id) { return id === "data-preloaded" && options.preloaded ? { textContent: JSON.stringify(options.preloaded) } : null; }
  };
  const window = {
    location: { origin: options.origin || "https://linux.do", pathname: options.pathname || "/" },
    navigation,
    addEventListener(name, callback) { const list = listeners.get(name) || []; list.push(callback); listeners.set(name, list); },
    postMessage(value, origin) { outputs.push({ value: plain(value), origin }); }
  };
  const bus = {
    callbacks: [...(options.callbacks || [])],
    subscribe(channel, func, last_id) {
      subscriptions.push({ channel, func, last_id });
      this.callbacks.push({ channel, func, last_id });
      if (options.throwSubscribe === channel) throw new Error("subscribe unavailable");
    },
    unsubscribe(channel, func) {
      assert.equal(typeof func, "function", "never remove native subscriptions by channel alone");
      cancellations.push({ channel, func });
      this.callbacks = this.callbacks.filter(item => item.channel !== channel || item.func !== func);
    },
    emit(channel, data, globalId, messageId) {
      for (const item of [...this.callbacks]) if (item.channel === channel) { item.last_id = messageId; item.func(data, globalId, messageId); }
    }
  };
  for (const name of ["start", "stop", "pause", "resume"]) bus[name] = () => { throw new Error(`must not call global ${name}`); };
  if (options.unknownBus) bus.callbacks = undefined;
  const store = {
    createRecord(type, data) {
      const result = new Record(data);
      if (type === "topic") result.postStream = { updateFromJson(json) { this.data = json; } };
      records.push({ type, data, result });
      return result;
    }
  };
  const Composer = { REPLY: "reply", OPEN: "open", isEditDraft: value => value.action === "edit" };
  const composer = {
    model: options.model,
    set(key, value) { this[key] = value; },
    async open(opts) {
      opened.push(opts);
      appEvents.trigger("composer:will-open");
      if (options.cancelOpen) return;
      this.skipJumpOnSave = opts.skipJumpOnSave;
      this.model = new Record({ topic: opts.topic, post: opts.post, action: opts.draft?.action || opts.action, draftKey: opts.draftKey,
        reply: opts.reply || "", composeState: "open" });
    },
    save(...args) { if (options.nativeSave) return Reflect.apply(options.nativeSave, this, args); throw new Error("bridge must never save or post"); },
    close() { throw new Error("bridge must not silently close a dirty draft"); }
  };
  const Draft = {
    async get(key) {
      draftGets.push(key);
      return options.draftResponse ? await options.draftResponse(key) : { draft: null, draft_sequence: 5 };
    },
    clear() { throw new Error("bridge must never delete a draft"); },
    save() { throw new Error("bridge must never save a draft"); }
  };
  const services = {
    "service:current-user": Object.hasOwn(options, "user") ? options.user : new Record({ id: 7, username: "patrick", avatar_template: "/avatar/{size}.png", email: "private@example.test", csrf: "do-not-leak" }),
    "service:site": new Record({ categories: [{ id: 2, name: "开发", slug: "development", color: "0088CC", internal_secret: "not-public" }], top_tags: [{ id: 3, name: "js", count: 9, secret: "not-public" }] }),
    "service:site-settings": { presence_enabled: options.presenceEnabled !== false, site_archived: options.siteArchived || false },
    "service:message-bus": options.noBus ? null : bus,
    "service:app-events": appEvents,
    "service:router": router,
    "service:store": store,
    "service:composer": options.noComposer ? null : composer
  };
  const owner = { lookup(name) { lookups.push(name); return services[name]; } };
  const modules = {
    "discourse/lib/get-owner": { getOwnerWithFallback: () => options.noOwner ? undefined : owner },
    "discourse/lib/preload-store": { default: { get: key => options.preloadValues?.[key] } },
    "discourse/models/composer": { default: Composer },
    "discourse/models/draft": { default: options.noDraft ? {} : Draft }
  };
  window.require = name => { moduleRequests.push(name); if (!modules[name]) throw new Error("unknown module"); return modules[name]; };
  if (options.globalOwner) window.Discourse = { __container__: owner };
  if (options.globalBus) window.MessageBus = bus;
  const context = vm.createContext({ window, document, location: window.location, URL, console });
  vm.runInContext(source, context);
  let requestId = 0;
  const dispatch = async (name, value) => { await Promise.all((listeners.get(name) || []).map(callback => callback(value))); };
  async function request(action, payload, extra = {}) {
    const id = extra.requestId ?? ++requestId;
    const message = { type: "linux-do-reader:native-request", clientId: extra.clientId || "reader-client", requestId: id, action, payload };
    if (extra.fireAndForget) delete message.requestId;
    await dispatch("message", { source: extra.source || window, origin: extra.origin || "https://linux.do", data: message });
    return outputs.map(item => item.value).findLast(item => item.type === "linux-do-reader:native-response" && item.requestId === id && item.clientId === message.clientId);
  }
  const events = kind => outputs.map(item => item.value).filter(item => item.type === "linux-do-reader:native-event" && (!kind || item.kind === kind));
  return { window, document, context, bus, appEvents, router, navigation, services, composer, store, opened, records, draftGets,
    outputs, subscriptions, cancellations, lookups, moduleRequests, listeners, dispatch, request, events };
}

const watchPayload = (extra = {}) => ({ watchId: "watch-1", topicId: 123, topicLastId: 20, presenceLastId: -1, ...extra });
const topic = (extra = {}) => ({ id: 123, title: "讨论", draft_key: "topic_123", draft_sequence: 5, details: { can_create_post: true }, post_stream: { stream: [10, 12], posts: [] }, ...extra });
const floor = (extra = {}) => ({ id: 12, topic_id: 123, post_number: 2, username: "author", user_id: 8, avatar_template: "/avatar.png", post_type: 1, ...extra });

// These tests intentionally stub the already running site services. No browser,
// Discourse endpoint, external post, second poller or workspace build is needed.

test("context only exposes preload/service metadata, not email, CSRF or a native presence initializer", async () => {
  const f = fixture();
  const response = await f.request("context");
  assert.equal(response.ok, true);
  assert.equal(response.result.user.username, "patrick");
  assert.equal(response.result.presenceEnabled, true);
  assert.deepEqual(response.result.tags, [{ id: 3, name: "js", count: 9 }]);
  assert.equal(response.result.categories[0].id, 2);
  assert.doesNotMatch(JSON.stringify(response), /private@example|do-not-leak|internal_secret|not-public/);
  assert.equal(f.lookups.includes("service:presence"), false);
  assert.equal(f.draftGets.length, 0);
  assert.equal(f.subscriptions.length, 0);
  assert.ok(f.outputs.every(item => item.origin === "https://linux.do"));
});

test("preload fallback does not consume or reload page preload data", async () => {
  const f = fixture({ noOwner: true, preloaded: {
    currentUser: JSON.stringify({ id: 5, username: "cached", email: "private", authenticity_token: "secret" }),
    site: JSON.stringify({ categories: [{ id: 6, name: "分享" }], top_tags: ["linux"] })
  } });
  const a = await f.request("context"), b = await f.request("context");
  assert.equal(a.result.user.username, "cached");
  assert.deepEqual(a.result, b.result);
  assert.deepEqual(a.result.tags, [{ name: "linux" }]);
  assert.doesNotMatch(JSON.stringify(a), /email|authenticity_token|secret/);
});

test("origin/source validation and one-time installation reject foreign page messages", async () => {
  const f = fixture();
  for (const extra of [{ origin: "https://example.com" }, { origin: "http://linux.do" }, { source: {} }]) assert.equal(await f.request("context", undefined, extra), undefined);
  assert.equal(f.outputs.length, 0);
  vm.runInContext(source, f.context);
  assert.equal(f.listeners.get("message").length, 1);
  const foreign = fixture({ origin: "https://example.com" });
  assert.equal(foreign.listeners.size, 0);
});

test("only the exact homepage permits context, watch and reply", async () => {
  for (const pathname of ["/t/123", "/topic/123", "/topic", "/latest", "/c/4", "/tag/linux", "/u/patrick", "/login", "//"]) {
    const f = fixture({ pathname });
    for (const action of ["context", "watch", "reply"]) {
      const response = await f.request(action, action === "watch" ? watchPayload() : { topic: topic(), post: floor() });
      assert.equal(response.ok, false, pathname);
      assert.equal(response.error.code, "NOT_HOMEPAGE", pathname);
    }
    assert.equal(f.subscriptions.length, 0);
    assert.equal(f.opened.length, 0);
    assert.equal(f.draftGets.length, 0);
  }
});

test("topic snapshot cursor and exact presence channel use the existing singleton without a new poller", async () => {
  const f = fixture();
  const response = await f.request("watch", watchPayload({ presenceLastId: 31 }));
  assert.equal(response.ok, true);
  assert.equal(response.result.needsTopicSnapshot, false);
  assert.deepEqual(f.subscriptions.map(({ channel, last_id }) => ({ channel, last_id })), [
    { channel: "/topic/123", last_id: 20 }, { channel: "/presence/discourse-presence/reply/123", last_id: 31 }
  ]);
  assert.equal(f.lookups.includes("service:presence"), false);
  assert.equal(f.draftGets.length, 0);
  assert.doesNotMatch(source, /\b(?:fetch|setInterval|setTimeout|XMLHttpRequest)\s*\(/);
});

test("the actual last native callback cursor is preserved, even when other callbacks differ", async () => {
  const first = { channel: "/topic/123", last_id: 90, func() {} };
  const last = { channel: "/topic/123", last_id: 25, func() {} };
  const presence = { channel: "/presence/discourse-presence/reply/123", last_id: 40, func() {} };
  const f = fixture({ callbacks: [first, last, presence] });
  const response = await f.request("watch", watchPayload({ topicLastId: 20, presenceLastId: 1 }));
  assert.equal(response.result.needsTopicSnapshot, true);
  assert.equal(f.subscriptions[0].last_id, 25);
  assert.equal(f.subscriptions[1].last_id, 40);
  assert.equal(first.last_id, 90);
  assert.equal(last.last_id, 25);
  assert.equal(presence.last_id, 40);
  await f.request("unwatch", { watchId: "watch-1" });
  assert.deepEqual(f.bus.callbacks, [first, last, presence]);
  assert.equal(f.cancellations.length, 2);
});

test("older native cursors are not advanced and missing reader baselines request one snapshot", async () => {
  const native = { channel: "/topic/123", last_id: 10, func() {} };
  const f = fixture({ callbacks: [native] });
  const response = await f.request("watch", watchPayload({ topicLastId: 20 }));
  assert.equal(response.result.needsTopicSnapshot, false);
  assert.equal(f.subscriptions[0].last_id, 10);
  const fresh = fixture();
  const unanchored = await fresh.request("watch", { watchId: "watch-1", topicId: 123 });
  assert.equal(unanchored.result.needsTopicSnapshot, true);
  assert.equal(fresh.subscriptions[0].last_id, -1);
});

test("unknown MessageBus callback shape fails safely without changing any native subscription", async () => {
  const f = fixture({ unknownBus: true });
  const response = await f.request("watch", watchPayload());
  assert.equal(response.error.code, "MESSAGE_BUS_UNAVAILABLE");
  assert.equal(f.subscriptions.length, 0);
  const native = { channel: "/topic/123", func() {} };
  const unsupported = fixture({ callbacks: [native] });
  const failed = await unsupported.request("watch", watchPayload());
  assert.equal(failed.error.code, "MESSAGE_BUS_UNSUPPORTED");
  assert.deepEqual(unsupported.bus.callbacks, [native]);
});

test("topic and presence callbacks use the third message id and whitelist event payloads", async () => {
  const f = fixture();
  await f.request("watch", watchPayload());
  f.bus.emit("/topic/123", { id: 14, post_number: 3, type: "created", version: 1, username: "new", raw: "private", csrf: "secret" }, 9000, 21);
  f.bus.emit("/presence/discourse-presence/reply/123", { entering_users: [{ id: 5, username: "typing", avatar_template: "/avatar.png", email: "private" }], leaving_user_ids: [4, -1, "2"], count_delta: 1, token: "secret" }, 9001, 32);
  assert.equal(f.events("topic")[0].messageId, 21);
  assert.equal(f.events("presence")[0].messageId, 32);
  assert.deepEqual(f.events("presence")[0].data.leaving_user_ids, [4]);
  assert.equal(f.events("presence")[0].data.entering_users[0].username, "typing");
  assert.doesNotMatch(JSON.stringify(f.events()), /private|secret|9000|9001/);
});

test("watch is idempotent and one client cannot release another client's watch", async () => {
  const f = fixture({ presenceEnabled: false });
  await f.request("watch", watchPayload());
  await f.request("watch", watchPayload());
  assert.equal(f.subscriptions.length, 1);
  await f.request("unwatch", { watchId: "watch-1" }, { clientId: "someone-else" });
  assert.equal(f.bus.callbacks.length, 1);
  const response = await f.request("unwatch", { watchId: "watch-1" }, { fireAndForget: true });
  assert.equal(response, undefined);
  assert.equal(f.bus.callbacks.length, 0);
});

test("unwatch releases only this bridge's callbacks after leaving the homepage", async () => {
  const native = { channel: "/topic/123", last_id: 22, func() {} };
  const f = fixture({ callbacks: [native] });
  await f.request("watch", watchPayload());
  f.window.location.pathname = "/topic/123";
  const response = await f.request("unwatch", { watchId: "watch-1" });
  assert.equal(response.ok, true);
  assert.equal(response.result.released, true);
  assert.deepEqual(f.bus.callbacks, [native]);
});

test("pagehide, Ember SPA changes, Navigation API and stale stream delivery clean up our callbacks", async () => {
  for (const mode of ["pagehide", "router", "page", "navigation", "stream"]) {
    const native = { channel: "/notifications", last_id: 4, func() {} };
    const f = fixture({ callbacks: [native] });
    await f.request("watch", watchPayload());
    if (mode !== "pagehide") f.window.location.pathname = "/t/123";
    if (mode === "pagehide") await f.dispatch("pagehide", {});
    if (mode === "router") f.router.trigger("routeDidChange");
    if (mode === "page") f.appEvents.trigger("page:changed");
    if (mode === "navigation") f.navigation.trigger("navigate", { destination: { url: "https://linux.do/topic/123" } });
    if (mode === "stream") f.bus.emit("/topic/123", { type: "created", id: 15 }, 99, 21);
    assert.deepEqual(f.bus.callbacks, [native], mode);
    assert.equal(f.events().length, 0, mode);
  }
});

test("partially failed subscriptions roll back only bridge callbacks", async () => {
  const native = { channel: "/topic/123", last_id: 30, func() {} };
  const f = fixture({ callbacks: [native], throwSubscribe: "/presence/discourse-presence/reply/123" });
  const response = await f.request("watch", watchPayload());
  assert.equal(response.ok, false);
  assert.deepEqual(f.bus.callbacks, [native]);
});

test("reply builds native Topic/Post and opens REPLY with server draft identity and skipJumpOnSave", async () => {
  const f = fixture();
  const response = await f.request("reply", { topic: topic(), post: floor() });
  assert.equal(response.ok, true);
  assert.equal(response.result.opened, true);
  assert.equal(f.draftGets.length, 1);
  assert.equal(f.draftGets[0], "topic_123");
  const opts = f.opened[0];
  assert.equal(opts.action, "reply");
  assert.equal(opts.draftKey, "topic_123");
  assert.equal(opts.draftSequence, 5);
  assert.equal(opts.skipJumpOnSave, true);
  assert.ok(opts.topic instanceof Record);
  assert.ok(opts.post instanceof Record);
  assert.equal(opts.post.post_number, 2);
  assert.equal(opts.post.topic, opts.topic);
  assert.equal(opts.topic.postStream.data.stream[1], 12);
  assert.equal(f.window.location.pathname, "/");
});

test("reply to the first floor is native topic-level reply, not reply_to_post_number 1", async () => {
  const f = fixture();
  await f.request("reply", { topic: topic(), post: floor({ id: 10, post_number: 1 }) });
  assert.equal(f.opened[0].post, undefined);
  assert.equal(f.records.filter(record => record.type === "post").length, 0);
});

test("login uses the actual native control and never guesses a composer or save API", async () => {
  let clicked = 0;
  const f = fixture({ user: null, loginControl: { click() { clicked++; } } });
  const response = await f.request("reply", { topic: topic(), post: floor() });
  assert.equal(response.result.login, true);
  assert.equal(response.result.opened, false);
  assert.equal(clicked, 1);
  assert.equal(f.opened.length, 0);
  assert.equal(f.draftGets.length, 0);
  const missing = fixture({ user: null });
  assert.equal((await missing.request("reply", { topic: topic() })).error.code, "LOGIN_REQUIRED");
});

test("permissions fail closed, while server-authorized replies to closed or archived topics remain allowed", async () => {
  for (const extra of [{ closed: true }, { archived: true }, {}]) {
    const f = fixture();
    const response = await f.request("reply", { topic: topic({ ...extra, details: {} }), post: floor() });
    assert.equal(response.error.code, "REPLY_FORBIDDEN");
    assert.equal(f.opened.length, 0);
    assert.equal(f.draftGets.length, 0);
  }
  const authorized = fixture();
  assert.equal((await authorized.request("reply", { topic: topic({ closed: true, archived: true }), post: floor() })).result.opened, true);
  const readOnly = fixture({ siteArchived: true });
  assert.equal((await readOnly.request("reply", { topic: topic() })).error.code, "SITE_ARCHIVED");
});

test("invalid topic, floor, draft identity and hidden or deleted posts cannot open composer", async () => {
  for (const payload of [
    { topic: topic({ id: -1 }) }, { topic: topic({ draft_key: "" }) }, { topic: topic({ draft_sequence: null }) },
    { topic: topic(), post: floor({ topic_id: 124 }) }, { topic: topic(), post: floor({ post_number: -1 }) },
    { topic: topic(), post: floor({ deleted_at: "2026-11-01" }) }, { topic: topic(), post: floor({ hidden: true }) }
  ]) {
    const f = fixture();
    assert.equal((await f.request("reply", payload)).ok, false);
    assert.equal(f.opened.length, 0);
    assert.equal(f.draftGets.length, 0);
  }
});

test("persisted native reply drafts are restored privately and the native service owns dirty-draft confirmation", async () => {
  const f = fixture({ draftResponse: async () => ({ draft: JSON.stringify({ action: "reply", reply: "private original draft", whisper: true }), draft_sequence: 8 }) });
  const response = await f.request("reply", { topic: topic(), post: floor() });
  assert.equal(response.result.opened, true);
  assert.equal(f.opened[0].reply, "private original draft");
  assert.equal(f.opened[0].draftSequence, 8);
  assert.equal(f.opened[0].whisper, true);
  assert.doesNotMatch(JSON.stringify(response), /private original draft/);
  const old = new Record({ topic: new Record({ id: 124 }), action: "reply", reply: "unsaved original", anyDirty: true, composeState: "open" });
  const canceled = fixture({ model: old, cancelOpen: true });
  const kept = await canceled.request("reply", { topic: topic(), post: floor() });
  assert.equal(kept.result.opened, false);
  assert.equal(canceled.composer.model, old);
  assert.equal(old.reply, "unsaved original");
});

test("an already-open reply changes only the native floor target and retains the unsaved body", async () => {
  const original = new Record({ topic: new Record(topic()), action: "reply", draftKey: "topic_123", reply: "keep my body", composeState: "draft" });
  const f = fixture({ model: original });
  const response = await f.request("reply", { topic: topic(), post: floor() });
  assert.equal(response.result.opened, true);
  assert.equal(f.composer.model, original);
  assert.equal(original.reply, "keep my body");
  assert.equal(original.post.post_number, 2);
  assert.equal(f.composer.skipJumpOnSave, true);
  assert.equal(f.opened.length, 0);
  assert.equal(f.draftGets.length, 0);
});

test("malformed drafts and missing draft API never delete, overwrite or save native drafts", async () => {
  for (const options of [{ noDraft: true }, { draftResponse: async () => ({ draft: "not JSON" }) }, { draftResponse: async () => ({ draft: JSON.stringify({ action: "other", reply: "keep" }) }) }]) {
    const f = fixture(options);
    assert.equal((await f.request("reply", { topic: topic(), post: floor() })).ok, false);
    assert.equal(f.opened.length, 0);
  }
});

test("429 during explicit native draft load stops immediately without any retry", async () => {
  const f = fixture({ draftResponse: async () => { throw { status: 429, responseText: "private response" }; } });
  const response = await f.request("reply", { topic: topic(), post: floor() });
  await settle();
  assert.equal(response.error.status, 429);
  assert.equal(f.draftGets.length, 1);
  assert.equal(f.opened.length, 0);
  assert.doesNotMatch(JSON.stringify(response), /private response/);
});

test("leaving home while loading a draft cancels opening, and concurrent clicks cannot open two composers", async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const f = fixture({ draftResponse: async () => { await blocked; return { draft: null, draft_sequence: 5 }; } });
  const first = f.request("reply", { topic: topic(), post: floor() });
  await settle();
  const second = await f.request("reply", { topic: topic(), post: floor({ id: 13, post_number: 3 }) });
  assert.equal(second.error.code, "COMPOSER_BUSY");
  f.window.location.pathname = "/topic/123";
  f.router.trigger("routeDidChange");
  release();
  assert.equal((await first).error.code, "LEFT_HOMEPAGE");
  assert.equal(f.draftGets.length, 1);
  assert.equal(f.opened.length, 0);
});

test("only published post:created produces saved events; enqueued and cross-topic composer events do not", async () => {
  const f = fixture();
  await f.request("watch", watchPayload());
  await f.request("reply", { topic: topic(), post: floor() });
  f.appEvents.trigger("composer:saved");
  f.appEvents.trigger("composer:created-post", { postId: 99 });
  assert.equal(f.events("saved").length, 0);
  f.appEvents.trigger("post:created", new Record({ id: 99, topic_id: 123, raw: "private body", cooked: "private rendered body" }));
  f.appEvents.trigger("post:created", new Record({ id: 99, topic_id: 123 }));
  f.appEvents.trigger("post:created", new Record({ id: 100, topic_id: 124 }));
  assert.equal(f.events("saved").length, 1);
  assert.deepEqual(f.events("saved")[0].data, { id: 99, topic_id: 123, type: "created", postId: 99, topicId: 123 });
  assert.doesNotMatch(JSON.stringify(f.events()), /private body|private rendered/);
});

test("edited saves keep the captured session identity and repeated edits are not lost", async () => {
  const f = fixture();
  await f.request("watch", watchPayload());
  await f.request("reply", { topic: topic(), post: floor() });
  f.appEvents.trigger("composer:edited-post");
  f.appEvents.trigger("composer:edited-post");
  assert.equal(f.events("saved").length, 2);
  assert.equal(f.events("saved")[0].data.type, "revised");
  f.composer.model = new Record({ topic: new Record({ id: 124 }), post: new Record({ id: 99 }) });
  f.appEvents.trigger("composer:will-open");
  f.appEvents.trigger("composer:edited-post");
  assert.equal(f.events("saved").length, 2);
});

test("unknown site settings remain unknown until ready, without caching presence as disabled", async () => {
  const f = fixture();
  f.services["service:site-settings"] = null;
  assert.equal((await f.request("context")).result.presenceEnabled, null);
  assert.equal((await f.request("watch", watchPayload())).error.code, "NATIVE_NOT_READY");
  assert.equal(f.subscriptions.length, 0);
  f.services["service:site-settings"] = { presence_enabled: true };
  assert.equal((await f.request("watch", watchPayload())).result.presenceEnabled, true);
  assert.equal(f.subscriptions.length, 2);
  for (const enabled of [true, false]) {
    const cached = fixture({ preloadValues: { siteSettings: { presence_enabled: enabled } } });
    cached.services["service:site-settings"] = null;
    assert.equal((await cached.request("context")).result.presenceEnabled, enabled);
    assert.equal((await cached.request("watch", watchPayload())).result.presenceEnabled, enabled);
    assert.equal(cached.subscriptions.length, enabled ? 2 : 1);
  }
});

test("owned save guard retains native checks and force while preserving jump:false across save(true) recursion", async () => {
  const calls = [], result = {};
  const f = fixture({ nativeSave(force, opts, tail) {
    calls.push({ self: this, force, opts, tail });
    if (this.permissionDenied) return "permission denied";
    if (this.slowModeBlocked) return "slow mode";
    if (!force) return this.save(true); // Official homepage recursion drops opts.
    return result;
  } });
  const original = f.composer.save;
  await f.request("reply", { topic: topic(), post: floor() });
  assert.equal(calls.length, 0, "opening never submits anything");
  assert.notEqual(f.composer.save, original);
  const opts = { jump: true, keep: {} }, tail = {};
  assert.equal(f.composer.save(false, opts, tail), result);
  assert.deepEqual(calls.map(call => call.force), [false, true]);
  assert.ok(calls.every(call => call.self === f.composer && call.opts.jump === false));
  assert.equal(calls[0].opts.keep, opts.keep);
  assert.equal(calls[0].tail, tail);
  assert.equal(opts.jump, true, "do not mutate the caller's options");
  f.composer.permissionDenied = true;
  assert.equal(f.composer.save(false, opts), "permission denied");
  assert.equal(calls.at(-1).force, false, "never force past native permission checks");
  f.composer.permissionDenied = false;
  f.composer.slowModeBlocked = true;
  assert.equal(f.composer.save(false, opts), "slow mode");
  assert.equal(calls.at(-1).force, false);
});

test("save guard passes other contexts, models and paths the original argument identities", async () => {
  const calls = [], sentinel = {};
  const f = fixture({ nativeSave(...args) { calls.push({ self: this, args }); return sentinel; } });
  await f.request("reply", { topic: topic(), post: floor() });
  const guard = f.composer.save, ownedModel = f.composer.model, opts = { jump: true }, tail = {};
  const otherContext = { model: ownedModel };
  assert.equal(guard.call(otherContext, false, opts, tail), sentinel);
  assert.equal(calls.at(-1).self, otherContext);
  assert.equal(calls.at(-1).args[1], opts);
  f.composer.model = new Record({ topic: new Record({ id: 124 }) });
  guard.call(f.composer, false, opts, tail);
  assert.equal(calls.at(-1).args[1], opts);
  f.composer.model = ownedModel;
  f.window.location.pathname = "/topic/123"; // Even before route cleanup fires.
  guard.call(f.composer, false, opts, tail);
  assert.equal(calls.at(-1).args[1], opts);
  assert.equal(calls.at(-1).args[2], tail);
});

test("save guard is restored by every owned cleanup without closing or clearing native drafts", async () => {
  for (const mode of ["unwatch", "dispose", "will-open", "pagehide", "route"]) {
    const f = fixture();
    const descriptor = Object.getOwnPropertyDescriptor(f.composer, "save");
    await f.request("watch", watchPayload());
    await f.request("reply", { topic: topic(), post: floor() });
    const model = f.composer.model;
    model.reply = "private unsaved draft";
    if (mode === "unwatch") await f.request("unwatch", { watchId: "watch-1" });
    if (mode === "dispose") await f.request("dispose", {});
    if (mode === "will-open") { f.composer.model = new Record({ topic: new Record({ id: 124 }) }); f.appEvents.trigger("composer:will-open"); }
    if (mode === "pagehide") await f.dispatch("pagehide", {});
    if (mode === "route") { f.window.location.pathname = "/t/123"; f.router.trigger("routeDidChange"); }
    assert.deepEqual(Object.getOwnPropertyDescriptor(f.composer, "save"), descriptor, mode);
    if (mode !== "will-open") assert.equal(f.composer.model, model, mode);
    assert.equal(model.reply, "private unsaved draft", mode);
  }
});

test("existing plugin save behavior stays in the chain and a later wrapper is never overwritten", async () => {
  const calls = [];
  const f = fixture({ nativeSave(force, opts) { calls.push({ force, opts }); return opts; } });
  const native = f.composer.save;
  let pluginCalls = 0;
  const plugin = function (...args) { pluginCalls++; return Reflect.apply(native, this, args); };
  f.composer.save = plugin;
  await f.request("reply", { topic: topic(), post: floor() });
  const owned = f.composer.save;
  assert.equal(owned.call(f.composer, true, { jump: true }).jump, false);
  assert.equal(pluginCalls, 1);
  const later = function (...args) { return Reflect.apply(owned, this, args); };
  Object.defineProperty(f.composer, "save", { value: later, configurable: false, writable: false });
  await f.request("dispose", {});
  assert.equal(f.composer.save, later);
  const opts = { jump: true };
  assert.equal(f.composer.save(false, opts), opts, "delegated inactive guard is transparent");
  assert.equal(calls.at(-1).opts, opts);
  assert.equal(pluginCalls, 2);
});

test("dispose is fire-and-forget/off-home and scoped to one client's subscriptions and owned composer", async () => {
  const f = fixture();
  const original = f.composer.save;
  await f.request("watch", watchPayload(), { clientId: "a" });
  await f.request("watch", watchPayload({ topicId: 124 }), { clientId: "b" });
  await f.request("reply", { topic: topic(), post: floor() }, { clientId: "a" });
  const guarded = f.composer.save, model = f.composer.model;
  await f.request("dispose", {}, { clientId: "b" });
  assert.equal(f.composer.save, guarded);
  assert.equal(f.bus.callbacks.length, 2);
  assert.ok(f.bus.callbacks.every(item => item.channel.includes("123")));
  f.window.location.pathname = "/t/123";
  assert.equal(await f.request("dispose", {}, { clientId: "a", fireAndForget: true }), undefined);
  assert.equal(f.composer.save, original);
  assert.equal(f.composer.model, model);
  assert.equal(f.bus.callbacks.length, 0);
});

test("disposing on the homepage cancels a late Draft.get even if watch failed before registering", async () => {
  for (const noBus of [false, true]) {
    let release;
    const blocked = new Promise(resolve => { release = resolve; });
    const f = fixture({ noBus, draftResponse: async () => { await blocked; return { draft: null, draft_sequence: 5 }; } });
    await f.request("watch", watchPayload());
    const response = f.request("reply", { topic: topic(), post: floor() });
    await settle();
    await f.request("dispose", {}, { fireAndForget: true });
    release();
    assert.equal((await response).error.code, "REPLY_CANCELLED");
    assert.equal(f.window.location.pathname, "/");
    assert.equal(f.opened.length, 0);
    assert.equal(f.draftGets.length, 1);
  }
});

test("unwatch only cancels that client's pending reply to the same topic", async () => {
  for (const matching of [true, false]) {
    let release;
    const blocked = new Promise(resolve => { release = resolve; });
    const f = fixture({ draftResponse: async () => { await blocked; return { draft: null, draft_sequence: 5 }; } });
    await f.request("watch", watchPayload());
    await f.request("watch", watchPayload({ watchId: "watch-2", topicId: 124 }));
    const reply = f.request("reply", { topic: topic(), post: floor() });
    await settle();
    await f.request("dispose", {}, { clientId: "other-client" });
    await f.request("unwatch", { watchId: matching ? "watch-1" : "watch-2" });
    release();
    const response = await reply;
    assert.equal(response.ok, !matching);
    if (matching) assert.equal(response.error.code, "REPLY_CANCELLED");
    assert.equal(f.opened.length, matching ? 0 : 1);
  }
});

test("a disposed old reply cannot clear a newer client's in-flight operation or open later", async () => {
  let releaseOld;
  const oldDraft = new Promise(resolve => { releaseOld = resolve; });
  const f = fixture({ draftResponse: async key => key === "topic_123" ? await oldDraft : { draft: null, draft_sequence: 5 } });
  const oldReply = f.request("reply", { topic: topic(), post: floor() }, { clientId: "old" });
  await settle();
  await f.request("dispose", {}, { clientId: "old" });
  const fresh = await f.request("reply", { topic: topic({ id: 124, draft_key: "topic_124" }), post: floor({ topic_id: 124 }) }, { clientId: "fresh" });
  assert.equal(fresh.result.opened, true);
  releaseOld({ draft: null, draft_sequence: 5 });
  assert.equal((await oldReply).error.code, "REPLY_CANCELLED");
  assert.equal(f.opened.length, 1);
  assert.equal(f.composer.model.topic.id, 124);
  const guard = f.composer.save;
  await f.request("dispose", {}, { clientId: "old" });
  assert.equal(f.composer.save, guard);
});

test("cancellation is checked after native composer.open without deleting its native model", async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const f = fixture(), originalOpen = f.composer.open, originalSave = f.composer.save;
  f.composer.open = async function (opts) { await blocked; return Reflect.apply(originalOpen, this, [opts]); };
  const reply = f.request("reply", { topic: topic(), post: floor() });
  await settle();
  await f.request("dispose", {});
  release();
  assert.equal((await reply).error.code, "REPLY_CANCELLED");
  assert.equal(f.composer.save, originalSave);
  assert.ok(f.composer.model, "do not close or clear a native editor that has already opened");
});

test("genuine native jqXHR server-wait headers report cooldown milliseconds without retry or private response data", async () => {
  const serverDate = new Date("2026-11-18T12:00:00Z");
  for (const status of [429, 502, 503, 504]) for (const headers of [
    { "Retry-After": "1.5", Date: serverDate.toUTCString(), expected: 1500 },
    { "Retry-After": new Date(serverDate.getTime() + 25000).toUTCString(), Date: serverDate.toUTCString(), expected: 25000 }
  ]) {
    const f = fixture({ draftResponse: async () => { throw { jqXHR: { status, responseText: "private", getResponseHeader: key => headers[key] } }; } });
    const now = Date.now();
    const response = await f.request("reply", { topic: topic(), post: floor() });
    assert.equal(response.error.status, status);
    assert.equal(response.error.retryAfter, headers.expected);
    assert.ok(response.error.retryAt >= now + headers.expected);
    assert.ok(response.error.retryAt <= Date.now() + headers.expected);
    assert.doesNotMatch(JSON.stringify(response), /private|responseText/);
    assert.equal(f.draftGets.length, 1);
    assert.equal(f.opened.length, 0);
  }
});

test("control characters cannot create ambiguous client/watch keys", async () => {
  const f = fixture();
  assert.equal(await f.request("context", {}, { clientId: "a\u0000b" }), undefined);
  assert.equal(f.outputs.length, 0);
  assert.equal((await f.request("watch", watchPayload({ watchId: "b\u0000c" }))).error.code, "INVALID_WATCH");
  assert.equal(f.subscriptions.length, 0);
});

test("a protected native save method fails before draft loading or opening", async () => {
  const f = fixture();
  Object.defineProperty(f.composer, "save", { value: f.composer.save, configurable: false, writable: false });
  assert.equal((await f.request("reply", { topic: topic(), post: floor() })).ok, false);
  assert.equal(f.draftGets.length, 0);
  assert.equal(f.opened.length, 0);
});

test("published edit identity is captured from the actual native Post at explicit save time", async () => {
  let f;
  f = fixture({ nativeSave() { f.appEvents.trigger("composer:edited-post"); } });
  await f.request("watch", watchPayload());
  await f.request("reply", { topic: topic(), post: floor() });
  f.composer.model.post = new Record({ id: 77, topic_id: 123, post_number: 4 });
  f.composer.save(false, { jump: true });
  assert.equal(f.events("saved")[0].data.id, 77);
  assert.equal(f.events("saved")[0].data.topic_id, 123);
  assert.equal(f.events("saved")[0].data.type, "revised");
});

test("an already saving native composer is never hydrated, retargeted or reopened", async () => {
  const model = new Record({ topic: new Record(topic()), action: "reply", draftKey: "topic_123", post: new Record(floor()), reply: "native submission", isSaving: true });
  const f = fixture({ model });
  const originalPost = model.post;
  const response = await f.request("reply", { topic: topic(), post: floor({ id: 15, post_number: 3 }) });
  assert.equal(response.error.code, "COMPOSER_BUSY");
  assert.equal(f.composer.model, model);
  assert.equal(model.post, originalPost);
  assert.equal(model.reply, "native submission");
  assert.equal(f.records.length, 0);
  assert.equal(f.draftGets.length, 0);
  assert.equal(f.opened.length, 0);
});

test("a late owned will-open hook does not remove jump protection, while another model cannot misreport edits", async () => {
  const f = fixture({ nativeSave(force, opts) { return opts; } });
  await f.request("watch", watchPayload());
  await f.request("reply", { topic: topic(), post: floor() });
  const guarded = f.composer.save;
  f.appEvents.trigger("composer:will-open");
  assert.equal(f.composer.save, guarded);
  assert.equal(f.composer.save(true, { jump: true }).jump, false);
  f.composer.model = new Record({ topic: new Record({ id: 124 }), post: new Record({ id: 99 }) });
  f.appEvents.trigger("composer:edited-post");
  assert.equal(f.events("saved").length, 0);
  const options = { jump: true };
  assert.equal(f.composer.save(false, options), options);
  assert.notEqual(f.composer.save, guarded);
});

test("explicit topic cleanup cancels a late Draft after watch failure without touching another client or topic", async () => {
  for (const [clientId, topicId, cancelled] of [["reader-client", 123, true], ["other-client", 123, false], ["reader-client", 124, false], ["reader-client", undefined, false]]) {
    let release;
    const blocked = new Promise(resolve => { release = resolve; });
    const f = fixture({ noBus: true, draftResponse: async () => { await blocked; return { draft: null, draft_sequence: 5 }; } });
    assert.equal((await f.request("watch", watchPayload())).ok, false);
    const opening = f.request("reply", { topic: topic(), post: floor() });
    await settle();
    await f.request("unwatch", { watchId: "watch-1", topicId }, { clientId });
    release();
    const response = await opening;
    assert.equal(response.ok, !cancelled);
    if (cancelled) assert.equal(response.error.code, "REPLY_CANCELLED");
    assert.equal(f.opened.length, cancelled ? 0 : 1);
    assert.equal(f.window.location.pathname, "/");
  }
});

test("a new client reusing the same native reply model acquires its own guard that old disposal cannot remove", async () => {
  const f = fixture({ nativeSave(_force, options) { return options; } });
  const original = f.composer.save;
  await f.request("reply", { topic: topic(), post: floor() }, { clientId: "old" });
  const oldGuard = f.composer.save, model = f.composer.model;
  model.reply = "keep this native draft";
  await f.request("reply", { topic: topic(), post: floor({ id: 13, post_number: 3 }) }, { clientId: "fresh" });
  const freshGuard = f.composer.save;
  assert.notEqual(freshGuard, oldGuard);
  assert.equal(f.composer.model, model);
  assert.equal(model.reply, "keep this native draft");
  await f.request("dispose", {}, { clientId: "old" });
  assert.equal(f.composer.save, freshGuard);
  assert.equal(f.composer.save(true, { jump: true }).jump, false);
  await f.request("dispose", {}, { clientId: "fresh" });
  assert.equal(f.composer.save, original);
});
