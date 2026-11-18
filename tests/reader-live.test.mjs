import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = name => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const plain = value => JSON.parse(JSON.stringify(value));
const dataKey = value => value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());

class Node {
  constructor(tag = "div", className = "") {
    this.tagName = tag.toUpperCase(); this.className = className; this.children = []; this.parentNode = null;
    this.attributes = new Map(); this._text = ""; this.hidden = false; this.scrollTop = 0;
    this.clientHeight = 600; this.scrollHeight = 1800; this.clientTop = 0;
    this.dataset = new Proxy({}, { set(target, name, value) { target[name] = String(value); return true; } });
    this.style = { setProperty() {}, removeProperty() {}, getPropertyValue: () => "" };
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(" "); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(" "); },
      toggle: (name, force) => { const add = force ?? !this.classList.contains(name); this.classList[add ? "add" : "remove"](name); return add; }
    };
  }
  get textContent() { return this._text + this.children.map(child => child instanceof Node ? child.textContent : String(child)).join(""); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  get childNodes() { return this.children; }
  get parentElement() { return this.parentNode; }
  get isConnected() { return !!this._connected || !!this.parentNode?.isConnected; }
  get firstElementChild() { return this.children.find(child => child instanceof Node) || null; }
  append(...children) { for (const child of children) { if (child instanceof Node) { child.remove(); child.parentNode = this; } this.children.push(child); } }
  prepend(...children) { for (const child of children) if (child instanceof Node) { child.remove(); child.parentNode = this; } this.children.unshift(...children); }
  replaceChildren(...children) { for (const child of this.children) if (child instanceof Node) child.parentNode = null; this.children = []; this._text = ""; this.append(...children); }
  replaceWith(node) { const parent = this.parentNode; if (!parent) return; const index = parent.children.indexOf(this); this.remove(); node.remove(); parent.children.splice(index, 0, node); node.parentNode = parent; }
  remove() { if (this.parentNode) { const index = this.parentNode.children.indexOf(this); if (index >= 0) this.parentNode.children.splice(index, 1); } this.parentNode = null; }
  contains(node) { return this === node || this.children.some(child => child instanceof Node && child.contains(node)); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); if (name === "id") this.id = String(value); if (name === "class") this.className = String(value); if (name.startsWith("data-")) this.dataset[dataKey(name.slice(5))] = value; }
  getAttribute(name) { if (name === "id") return this.id ?? null; if (name === "class") return this.className; if (name.startsWith("data-")) return this.dataset[dataKey(name.slice(5))] ?? null; return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener() {}
  focus() {}
  scrollIntoView() {}
  getBoundingClientRect() { return { top: 0, left: 0, bottom: this.id === "read-scroll" ? 600 : 40, right: 600, width: 600, height: this.id === "read-scroll" ? 600 : 40 }; }
  matches(selector) {
    const name = selector.match(/^([a-z]+)/i)?.[1];
    if (name && this.tagName !== name.toUpperCase()) return false;
    const id = selector.match(/#([\w-]+)/)?.[1]; if (id && this.id !== id) return false;
    for (const [, name] of selector.matchAll(/\.([\w-]+)/g)) if (!this.classList.contains(name)) return false;
    for (const [, name, value] of selector.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g)) {
      const actual = this.getAttribute(name); if (actual === null || value !== undefined && actual !== value) return false;
    }
    return true;
  }
  closest(selector) { for (let node = this; node; node = node.parentNode) if (node.matches(selector)) return node; return null; }
  querySelectorAll(selector) {
    const parts = selector.trim().split(/\s+/), matches = [], stack = [...this.children].reverse();
    while (stack.length) {
      const node = stack.pop(); if (!(node instanceof Node)) continue;
      stack.push(...[...node.children].reverse());
      if (!node.matches(parts.at(-1))) continue;
      let ancestor = node.parentNode, index = parts.length - 2;
      while (index >= 0 && ancestor) { if (ancestor.matches(parts[index])) index--; ancestor = ancestor.parentNode; }
      if (index < 0) matches.push(node);
    }
    return matches;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

const post = (floor, extra = {}) => ({ id: 100 + floor, topic_id: 123, post_number: floor, username: `user${floor}`,
  cooked: `<p>body${floor}</p>`, created_at: "2026-11-18T01:00:00Z", ...extra });
function fixture({ posts = [post(1), post(2)], user = { id: 7 }, data: changes = {}, reply, nativeContext,
  url = "https://linux.do/", livePending = new Set(), page } = {}) {
  const root = new Node("root"); root._connected = true;
  const shell = new Node("div", "shell"), toolbar = new Node(), actions = new Node(), reading = new Node(), status = new Node(), scroll = new Node();
  actions.id = "reading-actions"; reading.id = "reading"; status.id = "live-status"; status.hidden = true; scroll.id = "read-scroll";
  toolbar.append(actions); scroll.append(reading); shell.append(toolbar, status, scroll); root.append(shell);
  const data = { id: 123, title: "Title", slug: "topic", posts_count: posts.length, message_bus_last_id: 10, chunk_size: 20,
    draft_key: "topic_123", draft_sequence: 4, tags: [], details: { can_create_post: true, notification_level: 1 }, ...changes };
  const detail = { data, posts: new Map(posts.map(value => [value.id, value])), stream: posts.map(value => value.id),
    attempted: new Set(posts.map(value => value.id)), collapsed: new Set(), sort: "oldest", controller: new AbortController(), retryAt: 0 };
  const calls = { reply: [], requests: [], pages: [], cooked: [], context: 0, notifications: [], sessions: [], stopped: 0, refreshed: 0, kicked: 0, paused: [], deferred: [] };
  let cooling = 0;
  const bridge = {
    async reply(...args) { calls.reply.push(plain(args)); return reply ? reply(...args) : { opened: true }; },
    async context() { calls.context++; return nativeContext ?? { user, categories: [], tags: [], presenceEnabled: true }; },
    close() {}
  };
  class LiveSession {
    constructor(options) { calls.sessions.push(options); this.options = options; this.tombstones = new Set(); }
    async start() { this.options.onStatus({ phase: "active", count: 0, users: [] }); }
    hasPending(id) { return livePending.has(id); }
    stop() { calls.stopped++; }
    refresh() { calls.refreshed++; }
    kick() { calls.kicked++; }
    pause(error) { calls.paused.push(error); this.options.onStatus({ phase: "paused", error: error.message, retryAt: error.retryAt, count: 0, users: [] }); }
  }
  const forum = {
    safeURL(value) { if (typeof value !== "string" || !value) return null; return new URL(value, "https://linux.do"); },
    dateLabel: value => value || "", topicPath: (topic, floor) => `/t/topic/${topic.id}${floor ? `/${floor}` : ""}`,
    tagInfo: tag => typeof tag === "string" ? { name: tag, slug: tag } : tag,
    cooked(value) { calls.cooked.push(value); const node = new Node("div", "cooked"); node.textContent = value; return node; },
    async request(path, options) { calls.requests.push({ path, options }); return { ...data, post_stream: { stream: [...detail.stream], posts } }; },
    async postsPage(topicId, ids, signal, options) { calls.pages.push({ topicId, ids: [...ids], signal, options }); return page ? page(ids, signal) : ids.map(id => post(id - 100)); },
    requestQueue: { cooldown: () => cooling, busyError: () => Object.assign(new Error("原站限流"), { status: 429, retryAt: Date.now() + cooling, retryAfter: cooling }),
      defer: delay => { cooling = Math.max(cooling, delay); calls.deferred.push(delay); } }
  };
  const location = new URL(url);
  const document = { readyState: "loading", hidden: false, activeElement: null, createElement: tag => new Node(tag), addEventListener() {}, getElementById: () => null };
  const window = { location, addEventListener() {}, removeEventListener() {} };
  const context = vm.createContext({ URL, URLSearchParams, Intl, AbortController, DOMException, setTimeout, clearTimeout, Node, Element: Node,
    document, window, location, performance: { now: () => 0 }, LDForum: forum, LDLive: { TopicSession: LiveSession },
    __root: root, __detail: detail, __bridge: bridge, __calls: calls, __user: user });
  vm.runInContext(source("navigation.js"), context);
  vm.runInContext(source("discussions.js"), context);
  vm.runInContext(source("scrolling.js"), context);
  const script = source("reader.js").replace("  const requestedAtStart = requestedURL();", `
    root = __root; host = __root; nativeClient = __bridge; topicRequest = __detail.controller;
    state.onScreen = true; state.selected = __detail.data; state.detail = __detail; state.user = __user;
    state.rows = [__detail.data]; state.nativeContext = { presenceEnabled: false };
    updateSteps = renderList = renderFilters = closeMenu = closeSidebar = sizeReader = resetReplyPager = scheduleRecovery = () => {};
    notify = message => __calls.notifications.push(message);
    globalThis.readerTest = { state, renderReading, renderReplies, replyTo, clicked, startTopicLive,
      pendingPostIds, loadReplies, loadContext, clearTopic, selectTopic, canReply };
    const requestedAtStart = false;
  `);
  vm.runInContext(script, context);
  const api = context.readerTest;
  return { api, calls, detail, root, scroll, status, actions, location, document,
    cooldown: delay => { cooling = delay; }, render: () => api.renderReading(),
    controls: () => root.querySelectorAll('[data-action="reply"]'), live: () => api.startTopicLive(api.state.detail) };
}

test("actual reader render wires topic and available floor replies without leaking cooked data into the bridge", async () => {
  const f = fixture(); f.render();
  assert.deepEqual(f.controls().map(control => control.dataset.value), ["0", "2"]);
  assert.equal(f.root.querySelectorAll(".post-actions").length, 1);
  await f.api.replyTo(2); await f.api.replyTo(0);
  assert.equal(f.calls.reply.length, 2);
  const [topic, target] = f.calls.reply[0];
  assert.equal(topic.id, 123); assert.equal(topic.draft_key, "topic_123"); assert.equal(topic.draft_sequence, 4);
  assert.equal(target.id, 102); assert.equal(target.post_number, 2);
  assert.equal(target.cooked, undefined); assert.equal(target.raw, undefined);
  assert.equal(f.calls.reply[1][1], null);
  assert.equal(f.calls.requests.length, 0, "opening a reply does not call an extension POST or topic GET");
});

test("deleted/hidden/unavailable/missing floors have no reply action while available children keep theirs", async () => {
  const f = fixture({ posts: [post(1), post(2, { deleted: true, cooked: "OLD SECRET", username: "OLD AUTHOR" }),
    post(3, { reply_to_post_number: 2 }), post(4, { hidden: true }), post(5, { unavailable: true }), post(7, { reply_to_post_number: 6 })] });
  f.render();
  assert.deepEqual(f.controls().map(control => control.dataset.value), ["0", "3", "7"]);
  assert.doesNotMatch(f.root.textContent, /OLD SECRET|OLD AUTHOR/);
  for (const floor of [2, 4, 5, 6, 99]) await f.api.replyTo(floor);
  assert.equal(f.calls.reply.length, 0);
  await f.api.replyTo(3); assert.equal(f.calls.reply[0][1].post_number, 3);
});

test("reply controls and handler honor authoritative can_create_post even on closed/archived topics", async () => {
  const denied = fixture({ data: { details: { can_create_post: false } } }); denied.render();
  assert.ok(denied.controls().every(control => control.disabled));
  await denied.api.replyTo(0); assert.equal(denied.calls.reply.length, 0);
  const allowed = fixture({ data: { closed: true, archived: true, details: { can_create_post: true } } }); allowed.render();
  assert.ok(allowed.controls().every(control => !control.disabled));
  await allowed.api.replyTo(0); assert.equal(allowed.calls.reply.length, 1);
});

test("guest reply delegates native login without a misleading editor failure toast", async () => {
  const f = fixture({ user: null, reply: () => ({ opened: false, login: true }) }); f.render();
  assert.match(f.controls()[0].textContent, /登录后回复/);
  await f.api.replyTo(0);
  assert.equal(f.calls.reply.length, 1); assert.deepEqual(f.calls.notifications, []);
});

test("only one explicit native composer open is pending and all reply buttons recover after it", async () => {
  let release; const f = fixture({ reply: () => new Promise(resolve => { release = resolve; }) }); f.render();
  const opening = f.api.replyTo(2);
  await f.api.replyTo(0);
  assert.equal(f.calls.reply.length, 1); assert.ok(f.controls().every(control => control.disabled));
  release({ opened: true }); await opening;
  assert.ok(f.controls().every(control => !control.disabled));
});

test("non-home or hidden reader handlers cannot open a native reply", async () => {
  for (const url of ["https://linux.do/topic/123", "https://linux.do/t/topic/123", "https://linux.do/latest"]) {
    const f = fixture({ url }); await f.api.replyTo(0); assert.equal(f.calls.reply.length, 0);
  }
  const f = fixture(); f.api.state.onScreen = false; await f.api.replyTo(0); assert.equal(f.calls.reply.length, 0);
});

test("known shared cooldown stops explicit Draft/composer work before sending any bridge action", async () => {
  const f = fixture(); f.live(); f.render(); f.cooldown(7000);
  await f.api.replyTo(0);
  assert.equal(f.calls.reply.length, 0); assert.equal(f.calls.paused.length, 1); assert.match(f.calls.notifications[0], /限流/);
});

test("a native explicit Draft 429 merges its deadline into the shared queue without replaying", async () => {
  const f = fixture({ reply: () => { throw Object.assign(new Error("native rate limit"), { status: 429, retryAfter: 7000 }); } }); f.live(); f.render();
  await f.api.replyTo(0);
  assert.deepEqual(f.calls.deferred, [7000]); assert.equal(f.calls.paused.length, 1); assert.equal(f.calls.reply.length, 1);
  await f.api.replyTo(0); assert.equal(f.calls.reply.length, 1);
});

test("native Draft server-wait failures honor the absolute deadline before the fallback duration", async () => {
  for (const status of [502, 503, 504]) {
    const f = fixture({ reply: () => { throw Object.assign(new Error("native temporarily unavailable"), { status, retryAt: Date.now() + 7000, retryAfter: 2000 }); } });
    f.live(); f.render();
    await f.api.replyTo(0);
    assert.equal(f.calls.deferred.length, 1);
    assert.ok(f.calls.deferred[0] > 6000 && f.calls.deferred[0] <= 7000);
    assert.equal(f.calls.paused.length, 1); assert.equal(f.calls.reply.length, 1);
    assert.equal(f.calls.requests.length, 0);
  }
});

test("native metadata is reused without network and rerender works before a live session exists", async () => {
  const f = fixture({ user: undefined, nativeContext: { user: { id: 7, username: "self" }, categories: [], tags: [], presenceEnabled: true } }); f.render();
  await f.api.loadContext();
  assert.equal(f.api.state.user.id, 7); assert.equal(f.calls.context, 1); assert.equal(f.calls.requests.length, 0);
  assert.ok(f.controls().every(control => !control.disabled));
});

test("selected topic installs one live session whose visibility guard and presence use fresh native watch authority", async () => {
  const f = fixture(); f.live();
  assert.equal(f.calls.sessions.length, 1); const options = f.calls.sessions[0];
  assert.equal(options.presenceEnabled, true, "old context false must not override a newer watch acknowledgement");
  assert.equal(options.isVisible(), true); f.document.hidden = true; assert.equal(options.isVisible(), false);
  f.document.hidden = false; f.location.pathname = "/t/topic/123"; assert.equal(options.isVisible(), false);
});

test("native presence status and manual update are wired to the actual reading pane controls", async () => {
  const f = fixture(); f.render(); f.live();
  f.calls.sessions[0].onStatus({ phase: "active", users: [{ id: 8, username: "other" }], count: 1 });
  assert.equal(f.status.hidden, false); assert.match(f.status.textContent, /other.*正在回复/);
  const refresh = f.root.querySelector('[data-action="refresh-posts"]');
  f.api.clicked({ target: refresh }); assert.equal(f.calls.refreshed, 1);
  f.calls.sessions[0].onStatus({ phase: "active", presenceUnavailable: true, users: [], count: 0 });
  assert.match(f.status.textContent, /原站未提供正在回复状态/);
  assert.equal(f.calls.requests.length, 0);
  f.calls.sessions[0].onStatus({ phase: "paused", error: "网络已暂停", users: [], count: 0 });
  assert.match(f.status.textContent, /网络已暂停/);
});

test("a live update preserves collapse/sort/scroll state and updates the existing tree/count", async () => {
  const f = fixture(); f.detail.sort = "top"; f.detail.collapsed.add(2); f.scroll.scrollTop = 421;
  f.render(); f.live();
  f.detail.posts.set(103, post(3)); f.detail.stream.push(103); f.detail.data.posts_count = 3;
  f.calls.sessions[0].onChange({ opChanged: false });
  assert.equal(f.detail.sort, "top"); assert.deepEqual([...f.detail.collapsed], [2]); assert.equal(f.scroll.scrollTop, 421);
  assert.equal(f.root.querySelector(".reply-sort").value, "top");
  assert.ok(f.root.querySelector('[data-post-number="3"]'));
  assert.match(f.root.querySelector("#topic-reply-count").getAttribute("aria-label"), /2$/);
});

test("the historical pager excludes ids owned by live reads, exposes loadingIds, and preserves tombstones", async () => {
  let release; const f = fixture({ livePending: new Set([103]), page: () => new Promise(resolve => { release = resolve; }) });
  f.detail.stream.push(103, 104); f.live(); f.render();
  assert.deepEqual(plain(f.api.pendingPostIds(f.detail)), [104]);
  const reading = f.api.loadReplies();
  assert.deepEqual([...f.detail.loadingIds], [104]); assert.equal(f.detail.moreBusy, true);
  f.detail.live.tombstones.add(104);
  release([post(4)]); await reading;
  assert.equal(f.detail.posts.has(104), false); assert.equal(f.detail.loadingIds.size, 0); assert.equal(f.detail.moreBusy, false);
  assert.equal(f.calls.kicked, 1); assert.deepEqual(f.calls.pages[0].ids, [104]);
});

test("switching/closing a topic stops its live session and aborts its reads before clearing controls", () => {
  const f = fixture(); f.render(); f.live();
  f.api.clearTopic();
  assert.equal(f.calls.stopped, 1); assert.equal(f.detail.controller.signal.aborted, true); assert.equal(f.api.state.detail, null);
  assert.equal(f.controls().length, 0); assert.equal(f.status.hidden, true);
});

test("a normal homepage title click fetches that topic, stays at root, and starts live only after data", async () => {
  const f = fixture(); f.api.state.selected = null; f.api.state.detail = null;
  await f.api.selectTopic({ id: 123, title: "Title" });
  assert.equal(f.calls.requests.length, 1); assert.equal(f.calls.requests[0].path, "/t/123.json");
  assert.equal(f.calls.sessions.length, 1); assert.equal(f.api.state.detail.data.id, 123);
  assert.equal(f.location.href, "https://linux.do/"); assert.ok(f.controls().length > 0);
});

test("reading pane CSS reserves separate toolbar/status/content rows and preserves hidden semantics", () => {
  const css = source("reader.css");
  assert.match(css, /\.reading-pane\s*\{\s*grid-template-rows:\s*auto auto minmax\(0, 1fr\)/);
  assert.match(css, /\.read-scroll\s*\{\s*grid-row:\s*3/);
  assert.match(css, /\[hidden\][\s\S]*display:\s*none\s*!important/);
});
