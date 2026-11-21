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
  focus() { if (this.disabled) return; let root = this; while (root.parentNode) root = root.parentNode; root.activeElement = this; }
  scrollIntoView() {}
  getBoundingClientRect() {
    let root = this; while (root.parentNode) root = root.parentNode;
    if (root.replyGeometry && this.classList.contains("reply-card")) return root.replyGeometry(this);
    return { top: 0, left: 0, bottom: this.id === "read-scroll" ? 600 : 40, right: 600, width: 600, height: this.id === "read-scroll" ? 600 : 40 };
  }
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
    // A selector list is a union in DOM order. Treating a comma as another
    // descendant used to hide production-wide disable/enable operations.
    const alternatives = selector.split(",").map(part => part.trim().split(/\s+/));
    const matches = [], stack = [...this.children].reverse();
    while (stack.length) {
      const node = stack.pop(); if (!(node instanceof Node)) continue;
      stack.push(...[...node.children].reverse());
      if (alternatives.some(parts => {
        if (!node.matches(parts.at(-1))) return false;
        let ancestor = node.parentNode, index = parts.length - 2;
        while (index >= 0 && ancestor) { if (ancestor.matches(parts[index])) index--; ancestor = ancestor.parentNode; }
        return index < 0;
      })) matches.push(node);
    }
    return matches;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

const post = (floor, extra = {}) => ({ id: 100 + floor, topic_id: 123, post_number: floor, username: `user${floor}`,
  cooked: `<p>body${floor}</p>`, created_at: "2026-11-18T01:00:00Z", ...extra });
function fixture({ posts = [post(1), post(2)], user = { id: 7 }, data: changes = {}, reply, nativeContext,
  url = "https://linux.do/", livePending = new Set(), page, topicResponse, records = [], preloaded, changeResponse } = {}) {
  const root = new Node("root"); root._connected = true;
  const shell = new Node("div", "shell"), toolbar = new Node(), actions = new Node(), reading = new Node(), status = new Node(), scroll = new Node();
  actions.id = "reading-actions"; reading.id = "reading"; status.id = "live-status"; status.hidden = true; scroll.id = "read-scroll";
  toolbar.append(actions); scroll.append(reading); shell.append(toolbar, status, scroll); root.append(shell);
  const menu = new Node(); menu.id = "menu"; root.append(menu);
  const data = { id: 123, title: "Title", slug: "topic", posts_count: posts.length, message_bus_last_id: 10, chunk_size: 20,
    draft_key: "topic_123", draft_sequence: 4, tags: [], details: { can_create_post: true, notification_level: 1 }, ...changes };
  const detail = { data, posts: new Map(posts.map(value => [value.id, value])), stream: posts.map(value => value.id),
    attempted: new Set(posts.map(value => value.id)), collapsed: new Set(), sort: "oldest", controller: new AbortController(), retryAt: 0 };
  const calls = { reply: [], requests: [], pages: [], cooked: [], context: 0, notifications: [], sessions: [], stopped: 0, refreshed: 0, kicked: 0, paused: [], deferred: [], deferredInfo: [], changes: [] };
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
    refreshPresence() { calls.presenceRefreshed = (calls.presenceRefreshed || 0) + 1; }
    kick() { calls.kicked++; }
    pause(error) { calls.paused.push(error); this.options.onStatus({ phase: "paused", error: error.message, retryAt: error.retryAt, count: 0, users: [] }); }
  }
  const forum = {
    safeURL(value) { if (typeof value !== "string" || !value) return null; return new URL(value, "https://linux.do"); },
    dateLabel: value => value || "", topicPath: (topic, floor) => `/t/topic/${topic.id}${floor ? `/${floor}` : ""}`,
    tagInfo: tag => typeof tag === "string" ? { name: tag, slug: tag } : tag,
    cooked(value) { calls.cooked.push(value); const node = new Node("div", "cooked"); node.textContent = value; return node; },
    async request(path, options) { calls.requests.push({ path, options }); if (topicResponse) await topicResponse(path, options); return { ...data, post_stream: { stream: [...detail.stream], posts } }; },
    async postsPage(topicId, ids, signal, options) { calls.pages.push({ topicId, ids: [...ids], signal, options }); return page ? page(ids, signal) : ids.map(id => post(id - 100)); },
    async change(path, method, body, options) {
      calls.changes.push({ path, method, body: body === undefined ? null : plain(body), options });
      if (typeof changeResponse === "function") return changeResponse(path, method, body);
      return changeResponse || {};
    },
    requestQueue: { cooldown: () => cooling, busyError: () => Object.assign(new Error("原站限流"), { status: 429, retryAt: Date.now() + cooling, retryAfter: cooling }),
      diagnostics: () => records,
      defer: (delay, options = {}) => { cooling = Math.max(cooling, delay); calls.deferred.push(delay); calls.deferredInfo.push(plain(options)); } }
  };
  const location = new URL(url);
  const preloadedNode = preloaded ? Object.assign(new Node("script"), { textContent: JSON.stringify(preloaded) }) : null;
  const document = { readyState: "loading", hidden: false, activeElement: null, createElement: tag => new Node(tag), addEventListener() {},
    getElementById: id => id === "data-preloaded" ? preloadedNode : null };
  const window = { location, addEventListener() {}, removeEventListener() {} };
  const context = vm.createContext({ URL, URLSearchParams, Intl, AbortController, DOMException, setTimeout, clearTimeout, Node, Element: Node,
    document, window, location, innerWidth: 1440, innerHeight: 900, performance: { now: () => 0 }, LDForum: forum, LDLive: { TopicSession: LiveSession },
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
      pendingPostIds, loadReplies, changeReplySort, maybeLoadSortedPage, loadContext, clearTopic, selectTopic, canReply, populateMenu,
      openMenu, toggleReaction, submitBoost, deleteBoost, postByFloor, boostStats };
    const requestedAtStart = false;
  `);
  vm.runInContext(script, context);
  const api = context.readerTest;
  return { api, calls, detail, root, scroll, status, actions, location, document,
    cooldown: delay => { cooling = delay; }, render: () => api.renderReading(),
    controls: () => root.querySelectorAll('[data-action="reply"]'), live: () => api.startTopicLive(api.state.detail) };
}

test("actual reader render wires topic and available floor replies without leaking cooked data into the bridge", async () => {
  const f = fixture({ posts: [post(1), post(2, { user_id: 8, post_type: 1 })] }); f.render();
  assert.deepEqual(f.controls().map(control => control.dataset.value), ["0", "1", "2"]);
  assert.equal(f.root.querySelectorAll(".post-actions").length, 2);
  await f.api.replyTo(2); await f.api.replyTo(0);
  assert.equal(f.calls.reply.length, 2);
  const [topic, target] = f.calls.reply[0];
  assert.equal(topic.id, 123); assert.equal(topic.draft_key, "topic_123"); assert.equal(topic.draft_sequence, 4);
  assert.equal(target.id, 102); assert.equal(target.post_number, 2);
  assert.equal(target.user_id, 8); assert.equal(target.post_type, 1);
  assert.equal(target.cooked, undefined); assert.equal(target.raw, undefined);
  assert.equal(f.calls.reply[1][1], null);
  assert.equal(f.calls.requests.length, 0, "opening a reply does not call an extension POST or topic GET");
});

test("deleted/hidden/unavailable/missing floors have no reply action while available children keep theirs", async () => {
  const f = fixture({ posts: [post(1), post(2, { deleted: true, cooked: "OLD SECRET", username: "OLD AUTHOR" }),
    post(3, { reply_to_post_number: 2 }), post(4, { hidden: true }), post(5, { unavailable: true }), post(7, { reply_to_post_number: 6 })] });
  f.render();
  assert.deepEqual(f.controls().map(control => control.dataset.value), ["0", "1", "3", "7"]);
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

test("native rate-limit deadlines and draft/editor sources merge into the shared queue without replaying", async () => {
  for (const requestSource of ["draft", "composer", undefined]) {
    const f = fixture({ reply: () => { throw Object.assign(new Error("native rate limit"), { status: 429, retryAfter: 7000, requestSource }); } }); f.live(); f.render();
    await f.api.replyTo(0);
    assert.deepEqual(f.calls.deferred, [7000]); assert.equal(f.calls.paused.length, 1); assert.equal(f.calls.reply.length, 1);
    assert.deepEqual(f.calls.deferredInfo, [{ source: requestSource === "composer" ? "composer" : "draft", status: 429 }]);
    await f.api.replyTo(0); assert.equal(f.calls.reply.length, 1);
  }
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
  f.calls.sessions[0].onStatus({ phase: "active", users: [{ id: 8, username: "other" }], count: 1, presenceReady: true });
  assert.equal(f.status.hidden, false); assert.match(f.status.textContent, /other.*正在回复/);
  const refresh = f.root.querySelector('[data-action="refresh-posts"]');
  f.api.clicked({ target: refresh }); assert.equal(f.calls.refreshed, 1);
  f.calls.sessions[0].onStatus({ phase: "active", presenceUnavailable: true, users: [], count: 0 });
  assert.match(f.status.textContent, /原站未提供正在回复状态/);
  assert.equal(f.calls.requests.length, 0);
  f.calls.sessions[0].onStatus({ phase: "paused", error: "网络已暂停", users: [], count: 0 });
  assert.match(f.status.textContent, /网络已暂停/);
});

test("typing presence is visible without opening the composer and distinguishes unknown from nobody", () => {
  const f = fixture(); f.render(); f.live();
  const options = f.calls.sessions[0];
  assert.match(f.status.textContent, /正在回复状态尚未同步/);
  options.onStatus({ phase: "active", users: [], count: 0, presenceReady: true });
  assert.match(f.status.textContent, /暂无其他人正在回复/);
  options.onStatus({ phase: "active", users: [{ id: 8, username: "other", display_username: "佬友" }], count: 1, presenceReady: true });
  const presence = f.root.querySelector('[aria-label="正在回复状态"]');
  assert.match(presence.textContent, /佬友正在回复/);
  assert.equal(f.calls.reply.length, 0);
  assert.equal(f.calls.requests.length, 0);
});

test("presence failure stays in its own row and its retry never invokes a topic refresh", () => {
  const f = fixture(); f.render(); f.live();
  f.calls.sessions[0].onStatus({ phase: "active", presenceError: "正在回复状态暂未同步", users: [], count: 0, presenceReady: false });
  assert.match(f.status.textContent, /新回复自动更新/);
  assert.doesNotMatch(f.status.textContent, /实时更新已暂停|暂无其他人/);
  const retry = f.root.querySelector('[data-action="refresh-presence"]');
  assert.equal(retry.disabled, false);
  f.api.clicked({ target: retry });
  assert.equal(f.calls.presenceRefreshed, 1); assert.equal(f.calls.refreshed, 0); assert.equal(f.calls.requests.length, 0);
  f.calls.sessions[0].onStatus({ phase: "active", presenceBusy: true, busy: true, presenceError: "旧错误", count: 1, users: [{ id: 8, username: "stale" }] });
  assert.match(f.status.textContent, /正在同步正在回复状态/);
  assert.doesNotMatch(f.status.textContent, /stale/);
  assert.equal(f.root.querySelector('[data-action="refresh-presence"]').disabled, true);
});

test("unavailable presence has no retry, while a shared cooldown still disables recovery", () => {
  const f = fixture(); f.render(); f.live(); const update = f.calls.sessions[0].onStatus;
  update({ phase: "active", presenceUnavailable: true, presenceError: "无权限", count: 0 });
  assert.equal(f.root.querySelector('[data-action="refresh-presence"]'), null);
  update({ phase: "paused", error: "限流", retryAt: Date.now()+5000, presenceError: "暂未同步", count: 0 });
  assert.equal(f.root.querySelector('[data-action="refresh-presence"]').disabled, true);
});

test("rate-limit status preserves the operation source during the countdown", () => {
  const f = fixture(); f.render(); f.live();
  f.calls.sessions[0].onStatus({ phase: "paused", error: "读取正在回复状态：原站限流", retryAt: Date.now() + 7000, users: [], count: 0 });
  assert.match(f.status.textContent, /读取正在回复状态.*原站限流/);
  assert.equal(f.root.querySelector('[data-action="refresh-posts"]').disabled, true);
});

test("cooldown text counts down from its deadline instead of retaining a stale one-second warning", () => {
  const f = fixture(); f.render(); f.live();
  const update = f.calls.sessions[0].onStatus;
  update({ phase: "paused", error: "原站返回限流（话题详情，HTTP 429），已暂停请求，请 99 秒后重试。", retryAt: Date.now() + 2000 });
  assert.doesNotMatch(f.status.textContent, /99 秒/);
  assert.match(f.status.textContent, /话题详情.*[12] 秒后可重试/);
  update({ phase: "paused", error: "原站暂时不可用（HTTP 503），请 1 秒后重试。", retryAt: Date.now() - 1000 });
  assert.match(f.status.textContent, /HTTP 503.*等待已结束，可手动重试/);
  assert.doesNotMatch(f.status.textContent, /1 秒后重试|限流/);
  assert.equal(f.root.querySelector('[data-action="refresh-posts"]').disabled, false);
  assert.equal(f.calls.requests.length, 0);
});

test("topic cooldown keeps its true classification and disables retry until the deadline", async () => {
  const retryAt = Date.now() + 2000;
  const f = fixture({ topicResponse: () => { throw Object.assign(new Error("原站暂时不可用（HTTP 503），请 1 秒后重试。"), { status: 503, retryAt }); } });
  f.api.state.selected = null; f.api.state.detail = null;
  await f.api.selectTopic({ id: 123 });
  assert.equal(f.api.state.topicRetryAt, retryAt);
  assert.equal(f.root.querySelector('[data-action="retry-topic"]').disabled, true);
  assert.match(f.root.textContent, /HTTP 503.*[12] 秒后可重试/);
  assert.doesNotMatch(f.root.textContent, /限流/);
});

test("request records expose operation/time/result locally without causing another request", () => {
  const f = fixture({ records: [
    { requestSource: "正在回复状态", method: "GET", background: true, startedAt: 0, completedAt: 10, status: 429 },
    { requestSource: "回复分页", method: "GET", background: false, startedAt: 12, completedAt: null, status: null }
  ] });
  f.render(); f.live();
  assert.ok(f.root.querySelector('[data-action="menu"][data-value="requests"]'));
  f.api.populateMenu("requests");
  const menu = f.root.querySelector("#menu");
  assert.match(menu.textContent, /正在回复状态.*后台 GET.*结果码 429/);
  assert.match(menu.textContent, /回复分页.*前台 GET.*进行中/);
  assert.match(menu.textContent, /不能证明是哪次操作/);
  assert.equal(f.calls.requests.length, 0);
  assert.equal(f.calls.reply.length, 0);
});

test("tree tools retain per-branch toggles but remove expand-all and collapse-all", () => {
  const f = fixture({ posts: [post(1), post(2), post(3, { reply_to_post_number: 2 })] });
  f.render();
  assert.equal(f.root.querySelector('[data-action="expand-all"]'), null);
  assert.equal(f.root.querySelector('[data-action="collapse-all"]'), null);
  assert.ok(f.root.querySelector('[data-action="branch"]'));
  f.api.clicked({ target: f.root.querySelector('[data-action="branch"]') });
  assert.equal(f.detail.collapsed.has(2), true);
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

test("repeated clicks while the same topic loads share one GET and keep its controller alive", async () => {
  let release;
  const f = fixture({ topicResponse: () => new Promise(resolve => { release = resolve; }) });
  f.api.state.selected = null; f.api.state.detail = null;
  const first = f.api.selectTopic({ id: 123 });
  const signal = f.calls.requests[0].options.signal;
  await f.api.selectTopic({ id: 123 });
  assert.equal(f.calls.requests.length, 1); assert.equal(signal.aborted, false);
  assert.equal(f.api.state.topicBusy, true);
  release(); await first;
  assert.equal(f.api.state.topicBusy, false); assert.equal(f.calls.sessions.length, 1);
});

test("a failed topic load can be explicitly retried without a stuck busy guard", async () => {
  let count = 0;
  const f = fixture({ topicResponse: () => { if (++count === 1) throw new Error("offline"); } });
  f.api.state.selected = null; f.api.state.detail = null;
  await f.api.selectTopic({ id: 123 });
  assert.equal(f.api.state.topicBusy, false); assert.equal(f.api.state.topicError, "offline");
  await f.api.selectTopic({ id: 123 });
  assert.equal(f.calls.requests.length, 2); assert.ok(f.api.state.detail);
});

test("automatic reply pages carry the no-background-retry policy; explicit pages remain foreground", async () => {
  for (const background of [true, false]) {
    const f = fixture(); f.detail.stream.push(103);
    await f.api.loadReplies({ background });
    assert.equal(f.calls.pages[0].options.background, background);
  }
  const reader = source("reader.js");
  assert.match(reader, /load: \(\) => loadReplies\(\{ background: true \}\)/);
  assert.equal((reader.match(/autoLoadLimit: 1/g) || []).length, 2);
});

test("reading pane CSS reserves separate toolbar/status/content rows and preserves hidden semantics", () => {
  const css = source("reader.css");
  assert.match(css, /\.reading-pane\s*\{\s*grid-template-rows:\s*auto auto minmax\(0, 1fr\)/);
  assert.match(css, /\.read-scroll\s*\{\s*grid-row:\s*3/);
  assert.match(css, /\[hidden\][\s\S]*display:\s*none\s*!important/);
});

test("original-site extras render under the first post and available replies without extra requests", () => {
  const links = Array.from({ length: 7 }, (_, index) => ({
    url: `https://linux.do/t/topic/${100 + index}/${index + 2}`, internal: true, reflection: true,
    clicks: 90 - index * 10, title: `相关话题 ${index}`
  }));
  const f = fixture({ posts: [
    post(1, {
      reactions: [{ id: "heart", count: 59 }, { id: "+1", count: 2 }, { id: "clap", count: 1 }],
      reaction_users_count: 62,
      boosts: [
        { id: 1, cooked: "<p>前排</p>", user: { username: "neo", name: "Neo", avatar_template: "/u/{size}.png" } },
        { id: 2, cooked: "<p>支持</p>", user: { username: "ada", avatar_template: "/a/{size}.png" } }
      ],
      link_counts: [{ url: "https://github.com/x", internal: false, reflection: false, clicks: 900, title: "outbound" }, ...links]
    }),
    post(2, { reactions: [{ id: "heart", count: 3 }], reaction_users_count: 3, boosts: [], link_counts: [] })
  ] });
  f.render();
  assert.equal(f.root.querySelectorAll(".post-reactions").length, 2);
  const op = f.root.querySelector('.op-content[data-post-number="1"]');
  assert.equal(op.querySelectorAll(".reaction").length, 3);
  assert.equal(op.querySelector(".reaction-total").textContent, "62");
  assert.equal(op.querySelectorAll(".reaction-emoji")[0].src, "/images/emoji/twemoji/heart.png");
  assert.match(op.querySelector(".post-reactions").getAttribute("aria-label"), /:heart: 59.*共 62 个表情回应/);
  assert.equal(op.querySelectorAll(".boost").length, 2);
  assert.match(op.querySelector(".post-boosts").textContent, /前排/);
  assert.match(op.querySelector(".boost").getAttribute("title"), /@neo/);
  assert.equal(op.querySelectorAll(".post-link").length, 5);
  assert.equal(op.querySelectorAll(".post-link-count")[0].textContent, "90");
  assert.match(op.querySelector(".post-links-more").textContent, /其他 2 个/);
  // The reply keeps its floor/date meta but the duplicated like stat is gone.
  const reply = f.root.querySelector(".reply-card");
  assert.equal(reply.querySelectorAll(".post-reactions").length, 1);
  assert.equal(reply.querySelectorAll(".reply-meta .ic-heart").length, 0);
  assert.equal(f.calls.requests.length, 0);
});

test("related links expand and collapse in place without another request", () => {
  const links = Array.from({ length: 7 }, (_, index) => ({
    url: `https://linux.do/t/topic/${100 + index}`, internal: true, reflection: true,
    clicks: 90 - index, title: `相关话题 ${index}`
  }));
  const f = fixture({ posts: [post(1, { link_counts: links })] });
  f.render();
  const op = () => f.root.querySelector('.op-content[data-post-number="1"]');
  assert.equal(op().querySelectorAll(".post-link").length, 5);
  assert.equal(f.detail.expandedLinks, undefined);
  f.api.clicked({ target: op().querySelector('[data-action="post-links"]') });
  assert.equal(op().querySelectorAll(".post-link").length, 7);
  assert.match(op().querySelector(".post-links-more").textContent, /收起相关链接/);
  assert.deepEqual(plain([...f.detail.expandedLinks]), [1]);
  f.api.clicked({ target: op().querySelector('[data-action="post-links"]') });
  assert.equal(op().querySelectorAll(".post-link").length, 5);
  assert.equal(f.detail.expandedLinks.size, 0);
  assert.equal(f.calls.requests.length, 0);
  assert.equal(f.calls.pages.length, 0);
});

test("reaction emoji reuse the preloaded emoji set and custom emoji upload urls", () => {
  const f = fixture({ posts: [post(1, {
    reactions: [{ id: "heart", count: 2 }, { id: "bili_057", count: 1 }, { id: "odd name!", count: 1 }],
    reaction_users_count: 4
  })], preloaded: {
    siteSettings: JSON.stringify({ emoji_set: "noto" }),
    customEmoji: JSON.stringify([{ name: "bili_057", url: "https://cdn3.ldstatic.com/bili.png" }])
  } });
  f.render();
  const sources = f.root.querySelectorAll(".reaction-emoji").map(image => image.src);
  assert.deepEqual(sources, ["/images/emoji/noto/heart.png", "https://cdn3.ldstatic.com/bili.png"]);
  assert.match(f.root.querySelector(".reaction-name").textContent, /:odd name!:/);
  assert.equal(f.root.querySelector(".reaction-total").textContent, "4");
  assert.equal(f.calls.requests.length, 0);
});

test("reaction controls render for available posts and stay hidden on own posts", () => {
  const f = fixture({ posts: [post(1), post(2, { yours: true })] });
  f.render();
  const op = f.root.querySelector('.op-content[data-post-number="1"]');
  assert.ok(op.querySelector('[data-action="react"]'));
  assert.equal(op.querySelector('[data-action="react-picker"]'), null);
  assert.equal(op.querySelector('[data-action="react"]').getAttribute("aria-keyshortcuts"), "ArrowDown");
  assert.equal(op.querySelector(".post-reactions"), null, "zero responses have no read-only summary");
  assert.ok(op.querySelector(".post-controls .post-actions"));
  assert.equal(op.querySelector(".reaction-total"), null);
  const own = f.root.querySelector('.reply-card[data-post-number="2"]');
  assert.equal(own.querySelector('[data-action="react"]'), null);
  assert.equal(own.querySelector('[data-action="react-picker"]'), null);
  assert.equal(f.calls.requests.length, 0);
});

test("reaction toggle uses the original toggle endpoint and merges the serialized post", async () => {
  const f = fixture({ posts: [post(1)], changeResponse: () => ({
    reactions: [{ id: "heart", type: "emoji", count: 1 }], reaction_users_count: 1,
    current_user_reaction: { id: "heart", type: "emoji", can_undo: true }, current_user_used_main_reaction: true,
    actions_summary: [{ id: 2, count: 1, can_act: true }], like_count: 1
  }) });
  f.render();
  await f.api.toggleReaction(1, "heart");
  assert.deepEqual(plain(f.calls.changes), [{ path: "/discourse-reactions/posts/101/custom-reactions/heart/toggle.json", method: "PUT", body: null }]);
  const updated = f.detail.posts.get(101);
  assert.equal(updated.reaction_users_count, 1);
  assert.deepEqual(plain(updated.current_user_reaction), { id: "heart", type: "emoji", can_undo: true });
  const toggle = f.root.querySelector('.op-content [data-action="react"]');
  assert.match(toggle.className, /active/);
  assert.equal(toggle.getAttribute("aria-pressed"), "true");
  assert.equal(f.root.querySelector('.op-content .reaction-total').textContent, "1");
  assert.equal(f.calls.requests.length, 0, "a write must not read the topic again");
});

test("fixture selector lists preserve DOM order and deduplicate controls", () => {
  const root = new Node("root"), first = new Node("button"), second = new Node("button");
  first.dataset.action = "react"; second.dataset.action = "react-picker";
  root.append(first, second);
  assert.deepEqual(root.querySelectorAll('[data-action="react-picker"], [data-action="react"], button'), [first, second]);
});

const reactionResponse = (count = 1) => ({
  reactions: [{ id: "heart", type: "emoji", count }], reaction_users_count: count,
  current_user_reaction: { id: "heart", type: "emoji", can_undo: true },
  current_user_used_main_reaction: true, actions_summary: [{ id: 2, count, can_act: true }], like_count: count
});
const floorCard = (f, floor) => f.root.querySelector(`[data-post-number="${floor}"]`);
const reactionControls = card => card.querySelectorAll('.reaction-action[data-action="react"]');
const actionUnavailable = control => !!control.disabled || control.getAttribute("aria-disabled") === "true";

test("pending reactions disable only their own floor and allow another floor's explicit action", async () => {
  const finish = new Map();
  const f = fixture({ posts: [post(1), post(2), post(3)], changeResponse: path => new Promise(resolve => finish.set(path, resolve)) });
  f.render();
  const second = f.api.toggleReaction(2, "heart");
  let third;
  try {
    assert.ok(reactionControls(floorCard(f, 2)).every(actionUnavailable));
    assert.ok(reactionControls(floorCard(f, 1)).every(control => !actionUnavailable(control)), "the OP must stay usable while a reply writes");
    assert.ok(reactionControls(floorCard(f, 3)).every(control => !actionUnavailable(control)));
    await f.api.toggleReaction(2, "heart");
    assert.equal(f.calls.changes.length, 1, "a duplicate activation on the same pending floor must not toggle twice");
    third = f.api.toggleReaction(3, "heart");
    assert.equal(f.calls.changes.length, 2, "another floor's explicit action is not silently discarded");
    assert.ok(reactionControls(floorCard(f, 3)).every(actionUnavailable));
    assert.ok(reactionControls(floorCard(f, 1)).every(control => !actionUnavailable(control)));
  } finally {
    for (const resolve of finish.values()) resolve(reactionResponse());
    await Promise.all([second, third]);
  }
  for (const floor of [1, 2, 3]) assert.ok(reactionControls(floorCard(f, floor)).every(control => !actionUnavailable(control)));
});

test("reply reaction completion and failure never leave the OP controls disabled", async () => {
  for (const fails of [false, true]) {
    const f = fixture({ changeResponse: () => {
      if (fails) throw new Error("reaction failed");
      return reactionResponse();
    } });
    f.render();
    await f.api.toggleReaction(2, "heart");
    for (const floor of [1, 2]) {
      const controls = reactionControls(floorCard(f, floor));
      assert.equal(controls.length, 1);
      assert.ok(controls.every(control => !actionUnavailable(control)), `floor ${floor} must recover after ${fails ? "failure" : "success"}`);
    }
    if (fails) assert.match(f.calls.notifications.at(-1), /reaction failed/);
  }
});

test("reaction updates preserve the OP, reply cards, cooked bodies, sort control and active-floor focus", async () => {
  for (const floor of [1, 2]) {
    const f = fixture({ posts: [post(1), post(2), post(3)], changeResponse: () => reactionResponse(8) });
    f.render();
    const cards = [1, 2, 3].map(value => floorCard(f, value));
    const bodies = cards.map(card => card.querySelector(".post-content"));
    assert.ok(bodies.every(Boolean), "the preservation check must observe real cooked body nodes");
    const otherFloor = floor === 1 ? 2 : 1;
    const otherControls = floorCard(f, otherFloor).querySelector(".post-controls");
    const sort = f.root.querySelector("#reply-sort");
    floorCard(f, floor).querySelector('[data-action="react"]').focus();
    await f.api.toggleReaction(floor, "heart");
    for (let index = 0; index < cards.length; index++) {
      assert.equal(floorCard(f, index + 1), cards[index], "a reaction must not recreate a post card");
      assert.equal(cards[index].querySelector(".post-content"), bodies[index], "cooked bodies must not be rerendered");
    }
    assert.equal(floorCard(f, otherFloor).querySelector(".post-controls"), otherControls);
    assert.equal(f.root.querySelector("#reply-sort"), sort, "the whole reply tree must not be rebuilt");
    const toggle = floorCard(f, floor).querySelector('[data-action="react"]');
    assert.equal(f.root.activeElement, toggle, "focus must return to the replacement action on the same post");
    assert.ok(toggle.isConnected);
    assert.equal(toggle.getAttribute("aria-pressed"), "true");
    assert.equal(floorCard(f, floor).querySelector(".reaction-total").textContent, "8", "the server response supersedes the optimistic count");
    assert.equal(f.calls.requests.length, 0);
    assert.equal(f.calls.pages.length, 0);
  }
});

test("a reaction gives immediate optimistic feedback and rolls back a failed write without retry", async () => {
  let fail;
  const f = fixture({ posts: [post(1), post(2, {
    reactions: [{ id: "heart", type: "emoji", count: 4 }], reaction_users_count: 4,
    current_user_reaction: null, current_user_used_main_reaction: false,
    actions_summary: [{ id: 2, count: 4, can_act: true }], like_count: 4
  })], changeResponse: () => new Promise((resolve, reject) => { fail = reject; }) });
  f.render();
  const before = plain(f.detail.posts.get(102));
  const writing = f.api.toggleReaction(2, "heart");
  try {
    const card = floorCard(f, 2);
    assert.equal(card.querySelector('[data-action="react"]').getAttribute("aria-pressed"), "true", "the click is visible before the response");
    assert.equal(card.querySelector(".reaction-total").textContent, "5");
    assert.equal(f.detail.posts.get(102).current_user_reaction.id, "heart");
  } finally {
    fail(new Error("offline reaction"));
    await writing;
  }
  const card = floorCard(f, 2);
  assert.equal(card.querySelector('[data-action="react"]').getAttribute("aria-pressed"), "false");
  assert.equal(card.querySelector(".reaction-total").textContent, "4");
  assert.deepEqual(plain(f.detail.posts.get(102)), before);
  assert.equal(f.calls.changes.length, 1, "toggle writes must never be automatically replayed");
  assert.match(f.calls.notifications.at(-1), /offline reaction/);
  assert.ok(reactionControls(card).every(control => !actionUnavailable(control)));
});

test("like-only posts preserve their existing count during the optimistic update", async () => {
  let finish;
  const f = fixture({ posts: [post(1), post(2, { like_count: 4 })], changeResponse: () => new Promise(resolve => { finish = resolve; }) });
  f.render();
  assert.equal(floorCard(f, 2).querySelector(".reaction-total").textContent, "4");
  const writing = f.api.toggleReaction(2, "heart");
  try {
    assert.equal(floorCard(f, 2).querySelector(".reaction-total").textContent, "5", "a missing reactions array must not reset four existing likes to one");
    assert.equal(floorCard(f, 2).querySelector('[data-action="react"]').getAttribute("aria-pressed"), "true");
  } finally {
    finish(reactionResponse(5));
    await writing;
  }
  assert.equal(floorCard(f, 2).querySelector(".reaction-total").textContent, "5");
});

test("an older floor's reaction response never steals focus from a newer floor's action", async () => {
  const finish = new Map();
  const f = fixture({ posts: [post(1), post(2), post(3)], changeResponse: path => new Promise(resolve => finish.set(path, resolve)) });
  f.render();
  floorCard(f, 2).querySelector('[data-action="react"]').focus();
  const second = f.api.toggleReaction(2, "heart");
  floorCard(f, 3).querySelector('[data-action="react"]').focus();
  const third = f.api.toggleReaction(3, "heart");
  const active = floorCard(f, 3).querySelector('[data-action="reply"]');
  active.focus();
  try {
    finish.get("/discourse-reactions/posts/102/custom-reactions/heart/toggle.json")(reactionResponse());
    await second;
    assert.equal(f.root.activeElement, active, "the earlier response must leave the user's current enabled action alone");
    assert.ok(active.isConnected);
  } finally {
    for (const resolve of finish.values()) resolve(reactionResponse());
    await Promise.all([second, third]);
  }
});

test("main reaction and reply share a bottom action row with a read-only summary and large hit targets", () => {
  const f = fixture({ posts: [post(1, reactionResponse(3)), post(2, reactionResponse(2))] });
  f.render();
  for (const floor of [1, 2]) {
    const card = floorCard(f, floor);
    const row = card.querySelector(".post-controls"), actions = row?.querySelector(".post-actions");
    assert.ok(row && actions, "each available post has one bottom controls row");
    assert.equal(card.querySelectorAll(".post-controls").length, 1);
    const summary = row.querySelector(".post-reactions");
    assert.ok(summary);
    assert.equal(summary.querySelectorAll("button").length, 0, "counts and sampled emoji are not ambiguous tiny buttons");
    assert.deepEqual(actions.querySelectorAll("button").map(control => control.dataset.action), ["react", "reply"]);
    assert.equal(actions.parentElement, row);
    assert.ok(card.children.indexOf(row) > card.children.indexOf(card.querySelector(".post-content")));
    const toggle = actions.querySelector('[data-action="react"]');
    assert.equal(toggle.tagName, "BUTTON");
    assert.ok(toggle.getAttribute("aria-label"));
    assert.equal(toggle.getAttribute("aria-pressed"), "true");
  }
  const css = source("reader.css");
  const actionRule = css.match(/\.reaction-action\s*\{([^}]+)\}/)?.[1];
  assert.ok(actionRule);
  assert.ok(Number(actionRule.match(/min-width:\s*(\d+)px/)?.[1]) >= 40, "the main and picker actions need at least 40px width");
  assert.ok(Number(actionRule.match(/(?:min-)?height:\s*(\d+)px/)?.[1]) >= 40, "the action row needs at least 40px height");
  const rowRule = css.match(/\.post-controls\s*\{([^}]+)\}/)?.[1];
  assert.match(rowRule || "", /display:\s*flex/);
});

test("rendered reaction and boost controls are wired to their write endpoints", async () => {
  const f = fixture({ posts: [post(1, { can_boost: true, boosts: [] })] });
  f.render();
  f.api.clicked({ target: f.root.querySelector('.op-content [data-action="react"]') });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(plain(f.calls.changes.map(change => [change.path, change.method])),
    [["/discourse-reactions/posts/101/custom-reactions/heart/toggle.json", "PUT"]]);
  f.api.clicked({ target: f.root.querySelector('[data-action="boost-compose"]') });
  assert.ok(f.root.querySelector("#boost-editor"), "the boost composer opens from its trigger");
  assert.equal(f.calls.changes.length, 1, "opening the composer must not write anything");
});

test("reaction writes are gated by login, ownership and undo permission", async () => {
  const guest = fixture({ posts: [post(1)], user: null });
  guest.render();
  await guest.api.toggleReaction(1, "heart");
  assert.equal(guest.calls.changes.length, 0);
  assert.match(guest.calls.notifications.at(-1), /登录/);

  const own = fixture({ posts: [post(1, { yours: true })] });
  own.render();
  await own.api.toggleReaction(1, "heart");
  assert.equal(own.calls.changes.length, 0);

  const locked = fixture({ posts: [post(1, {
    reactions: [{ id: "heart", count: 3 }], reaction_users_count: 3,
    current_user_reaction: { id: "heart", can_undo: false }
  })] });
  locked.render();
  assert.equal(locked.root.querySelector('.op-content [data-action="react"]').disabled, true);
  await locked.api.toggleReaction(1, "heart");
  assert.equal(locked.calls.changes.length, 0);
  assert.match(locked.calls.notifications.at(-1), /不能取消/);
});

test("the reaction picker lists valid reactions and marks the current one", async () => {
  const f = fixture({
    posts: [post(1, {
      reactions: [{ id: "+1", count: 4 }], reaction_users_count: 4,
      current_user_reaction: { id: "+1", can_undo: true }
    })],
    data: { valid_reactions: ["heart", "+1", "bili_057"] },
    preloaded: {
      siteSettings: JSON.stringify({ emoji_set: "twemoji", discourse_reactions_reaction_for_like: "heart" }),
      customEmoji: JSON.stringify([{ name: "bili_057", url: "https://cdn3.ldstatic.com/b.png", group: "b站" }])
    }
  });
  f.render();
  const trigger = f.root.querySelector('.reaction-action[data-action="react"]');
  f.api.openMenu("reactions", trigger, { post: f.detail.posts.get(101), width: 276 });
  const choices = f.root.querySelectorAll(".reaction-choice");
  assert.equal(choices.length, 3);
  assert.equal(f.root.querySelector(".reaction-choice.checked").dataset.value, "+1");
  assert.equal(choices[2].querySelector("img").src, "https://cdn3.ldstatic.com/b.png");
  f.api.clicked({ target: choices[0] });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(f.calls.changes[0].path, "/discourse-reactions/posts/101/custom-reactions/heart/toggle.json");
});

test("boost composer posts the original endpoint contract and adds the boost locally", async () => {
  const f = fixture({
    posts: [
      post(1, { can_boost: true, boosts: [], username: "neo" }),
      post(2, { can_boost: true, boosts: [{ id: 9, cooked: "<p>沙发</p>", can_delete: false, user: { id: 3, username: "x", avatar_template: "/a.png" } }] })
    ],
    changeResponse: () => ({ id: 77, cooked: "<p>前排</p>", can_delete: true, user: { id: 7, username: "me", avatar_template: "/m.png" } })
  });
  f.render();
  const op = f.root.querySelector('.op-content[data-post-number="1"]');
  assert.ok(op.querySelector('[data-action="boost-compose"]'));
  assert.ok(f.root.querySelector('.reply-card[data-post-number="2"] [data-action="boost-compose"]'));
  f.api.openMenu("boost", op.querySelector('[data-action="boost-compose"]'), { post: f.detail.posts.get(101), width: 332 });
  const editor = f.root.querySelector("#boost-editor");
  assert.ok(editor);
  editor.append("前排");
  await f.api.submitBoost(1);
  assert.deepEqual(plain(f.calls.changes), [{ path: "/discourse-boosts/posts/101/boosts.json", method: "POST", body: { raw: "前排" } }]);
  const updated = f.detail.posts.get(101);
  assert.equal(updated.can_boost, false);
  assert.equal(updated.boosts[0].id, 77);
  assert.ok(f.calls.notifications.some(message => message.includes("已发布")));
  assert.ok(f.root.querySelector(".post-boosts .boost"));
  assert.ok(f.root.querySelector(".boost-delete"));
  assert.equal(f.calls.requests.length, 0);
});

test("boost submit rejects oversized drafts and surfaces rate limits without retries", async () => {
  const f = fixture({
    posts: [post(1, { can_boost: true, boosts: [] })],
    changeResponse: () => { throw Object.assign(new Error("原站限流（表情评论）"), { status: 429, retryAfter: 5000, retryAt: Date.now() + 5000 }); }
  });
  f.render(); f.live();
  f.api.openMenu("boost", f.root.querySelector('[data-action="boost-compose"]'), { post: f.detail.posts.get(101), width: 332 });
  const editor = f.root.querySelector("#boost-editor");
  editor.append("一二三四五六七八九十一二三四五六七");
  await f.api.submitBoost(1);
  assert.equal(f.calls.changes.length, 0);
  assert.match(f.calls.notifications.at(-1), /最多 16 个字/);
  editor.textContent = "";
  editor.append("沙发");
  await f.api.submitBoost(1);
  assert.equal(f.calls.changes.length, 1);
  assert.match(f.calls.notifications.at(-1), /限流/);
  assert.equal(f.calls.paused.length, 1);
  assert.equal(f.detail.posts.get(101).boosts.length, 0, "a failed boost must not be added locally");
});

test("deleting an own boost uses the delete endpoint and restores the composer", async () => {
  const f = fixture({ posts: [post(1, {
    can_boost: false,
    boosts: [{ id: 55, cooked: "<p>沙发</p>", can_delete: true, user: { id: 7, username: "me", avatar_template: "/m.png" } }]
  })] });
  f.render();
  const remove = f.root.querySelector('[data-action="delete-boost"]');
  assert.ok(remove);
  f.api.clicked({ target: remove });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(plain(f.calls.changes), [{ path: "/discourse-boosts/boosts/55.json", method: "DELETE", body: null }]);
  assert.equal(f.detail.posts.get(101).boosts.length, 0);
  assert.equal(f.detail.posts.get(101).can_boost, true);
  assert.ok(f.root.querySelector('[data-action="boost-compose"]'));
  assert.equal(f.calls.requests.length, 0);
});

test("boost draft stats count shortcodes and emoji as single characters", () => {
  const f = fixture();
  assert.deepEqual(plain(f.api.boostStats("前排")), { visible: 2, emoji: 0 });
  assert.deepEqual(plain(f.api.boostStats(":bili_057:")), { visible: 1, emoji: 1 });
  assert.deepEqual(plain(f.api.boostStats("😆😆")), { visible: 2, emoji: 2 });
  assert.equal(f.api.boostStats("一二三四五六七八九十一二三四五六七八").visible, 18);
});

const orderedPost = floor => post(floor, { created_at: `2026-11-18T01:${String(floor).padStart(2, "0")}:00Z` });
function movingReplyGeometry(f) {
  f.root.replyGeometry = node => {
    const index = f.root.querySelectorAll(".reply-card").indexOf(node);
    const top = 200 + index * 120 - f.scroll.scrollTop;
    return { top, bottom: top + 100, height: 100, left: 0, right: 600, width: 600 };
  };
}

test("explicit sort keeps the numeric viewport instead of following the reordered old floor", () => {
  const f = fixture({ posts: [orderedPost(1), orderedPost(2), orderedPost(3), orderedPost(4)] });
  movingReplyGeometry(f); f.render(); f.scroll.scrollTop = 100;
  f.api.changeReplySort("newest");
  assert.equal(f.scroll.scrollTop, 100);
  assert.deepEqual(f.root.querySelectorAll(".reply-card").map(node => node.dataset.replyFloor), ["4", "3", "2"]);
  assert.equal(f.root.activeElement.id, "reply-sort");
  assert.equal(f.calls.pages.length, 0, "fully loaded topics need no new request");
  f.api.changeReplySort("oldest");
  assert.equal(f.scroll.scrollTop, 100);
  assert.deepEqual(f.root.querySelectorAll(".reply-card").map(node => node.dataset.replyFloor), ["2", "3", "4"]);
});

test("latest sort fetches the tail page immediately and keeps position through asynchronous content insertion", async () => {
  let release;
  const f = fixture({ posts: [orderedPost(1), orderedPost(2), orderedPost(3)], data: { chunk_size: 2, posts_count: 9 },
    page: () => new Promise(resolve => { release = resolve; }) });
  f.detail.stream.push(104, 105, 106, 107, 108, 109);
  movingReplyGeometry(f); f.render(); f.scroll.scrollTop = 90;
  const stream = [...f.detail.stream];
  f.api.changeReplySort("newest");
  assert.equal(f.calls.pages.length, 1);
  assert.deepEqual(f.calls.pages[0].ids, [109, 108]);
  assert.equal(f.calls.pages[0].options.background, false);
  assert.equal(f.scroll.scrollTop, 90);
  f.api.changeReplySort("newest"); assert.equal(f.calls.pages.length, 1);
  release([orderedPost(8), orderedPost(9)]); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(f.scroll.scrollTop, 90);
  assert.equal(f.detail.sortLoading, false);
  assert.deepEqual(f.detail.stream, stream);
  assert.deepEqual(plain(f.api.pendingPostIds(f.detail)), [107, 106, 105, 104]);
  assert.equal(f.root.querySelectorAll(".reply-card")[0].dataset.replyFloor, "9");
  f.api.changeReplySort("oldest");
  assert.deepEqual(plain(f.api.pendingPostIds(f.detail)), [104, 105, 106, 107]);
});

test("latest sort waits for the existing page without duplicates then reads the newest missing page", async () => {
  const releases = [];
  const f = fixture({ data: { chunk_size: 2 }, page: () => new Promise(resolve => releases.push(resolve)) });
  f.detail.stream.push(103, 104, 105, 106, 107, 108); f.render();
  const first = f.api.loadReplies();
  f.api.changeReplySort("newest");
  assert.deepEqual(f.calls.pages.map(call => call.ids), [[103, 104]]);
  assert.equal(f.detail.sortLoadPending, true);
  releases[0]([post(3), post(4)]); await first;
  assert.deepEqual(f.calls.pages.map(call => call.ids), [[103, 104], [108, 107]]);
  assert.equal(f.detail.sortLoadPending, false);
  releases[1]([post(7), post(8)]); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(f.calls.pages.length, 2);
});

test("sort intent queued behind live work is canceled by another order or topic close", () => {
  const f = fixture(); f.detail.stream.push(103, 104); f.live(); f.render();
  f.detail.live.busy = true;
  f.api.changeReplySort("newest");
  assert.equal(f.calls.pages.length, 0); assert.equal(f.detail.sortLoadPending, true);
  f.api.changeReplySort("oldest"); f.detail.live.busy = false;
  f.api.maybeLoadSortedPage(); assert.equal(f.calls.pages.length, 0);
  f.detail.live.busy = true; f.api.changeReplySort("newest"); f.api.clearTopic();
  f.api.maybeLoadSortedPage(); assert.equal(f.calls.pages.length, 0);
});

test("latest page failures remain explicit and are not retried by render or subsequent idle status", async () => {
  const f = fixture({ page: () => { throw new Error("offline latest page"); } });
  f.detail.stream.push(103, 104); f.render(); f.api.changeReplySort("newest");
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(f.calls.pages.length, 1); assert.match(f.detail.moreError, /offline/);
  f.api.renderReplies(); f.api.maybeLoadSortedPage();
  assert.equal(f.calls.pages.length, 1);
  assert.equal(f.detail.attempted.has(104), false);
});

test("latest pagination skips unavailable and live-owned ids without reversing the canonical stream", () => {
  const f = fixture({ livePending: new Set([105]) });
  f.detail.stream.push(103, 104, 105, 106); f.detail.attempted.add(104); f.detail.sort = "newest"; f.live();
  assert.deepEqual(plain(f.api.pendingPostIds(f.detail)), [106, 103]);
  assert.deepEqual(f.detail.stream, [101, 102, 103, 104, 105, 106]);
});
