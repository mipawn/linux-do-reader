import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = name => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const plain = value => JSON.parse(JSON.stringify(value));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const dataKey = value => value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());

// Independent DOM fixture: exercises the actual reader, without a browser or
// network. No live forum request can escape the recording change/request stubs.
class Node {
  constructor(tag = "div", className = "") {
    this.tagName = tag.toUpperCase(); this.className = className; this.children = []; this.parentNode = null;
    this.attributes = new Map(); this.listeners = new Map(); this._text = ""; this.hidden = false;
    this.scrollTop = 0; this.clientHeight = 600; this.scrollHeight = 1800; this.clientTop = 0;
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
  set textContent(value) { this.replaceChildren(String(value)); }
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
  addEventListener(type, listener) { this.listeners.set(type, [...(this.listeners.get(type) || []), listener]); }
  dispatchEvent(event) { for (const listener of this.listeners.get(event.type) || []) listener(event); return true; }
  focus() { if (this.disabled) return; let root = this; while (root.parentNode) root = root.parentNode; root.activeElement = this; }
  scrollIntoView() {}
  getBoundingClientRect() { return { top: 0, left: 0, bottom: 40, right: 600, width: 600, height: 40 }; }
  matches(selector) {
    const name = selector.match(/^([a-z]+)/i)?.[1]; if (name && this.tagName !== name.toUpperCase()) return false;
    const id = selector.match(/#([\w-]+)/)?.[1]; if (id && this.id !== id) return false;
    for (const [, name] of selector.matchAll(/\.([\w-]+)/g)) if (!this.classList.contains(name)) return false;
    for (const [, name, value] of selector.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g)) {
      const actual = this.getAttribute(name); if (actual === null || value !== undefined && actual !== value) return false;
    }
    return true;
  }
  closest(selector) { for (let node = this; node; node = node.parentNode) if (selector.split(",").some(part => node.matches(part.trim()))) return node; return null; }
  querySelectorAll(selector) {
    const alternatives = selector.split(",").map(part => part.trim().split(/\s+/));
    const matches = [], stack = [...this.children].reverse();
    while (stack.length) {
      const node = stack.pop(); if (!(node instanceof Node)) continue; stack.push(...[...node.children].reverse());
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
  user_id: 10 + floor, cooked: `<p>body${floor}</p>`, created_at: "2026-11-18T01:00:00Z", ...extra });
const boost = (id, userId = 9, extra = {}) => ({ id, cooked: "<p>前排</p>", user: { id: userId, username: `u${userId}` }, ...extra });
const enabled = "heart|+1|laughing|open_mouth|clap|confetti_ball|hugs|distorted_face|tieba_087|bili_057";
function fixture({ posts = [post(1), post(2)], user = { id: 7 }, settings = {}, data = {}, change, confirm = true, savedSort } = {}) {
  const root = new Node("root"); root._connected = true;
  const shell = new Node("div", "shell"), toolbar = new Node(), actions = new Node(), reading = new Node(), status = new Node(), scroll = new Node();
  actions.id = "reading-actions"; reading.id = "reading"; status.id = "live-status"; status.hidden = true; scroll.id = "read-scroll";
  toolbar.append(actions); scroll.append(reading); shell.append(toolbar, status, scroll); root.append(shell);
  const menu = new Node(); menu.id = "menu"; menu.hidden = true; root.append(menu);
  const topic = { id: 123, title: "Title", slug: "topic", posts_count: posts.length, chunk_size: 20,
    tags: [], details: { can_create_post: true, notification_level: 1 }, ...data };
  const detail = { data: topic, posts: new Map(posts.map(value => [value.id, value])), stream: posts.map(value => value.id),
    attempted: new Set(posts.map(value => value.id)), collapsed: new Set(), sort: "oldest", controller: new AbortController(), retryAt: 0 };
  const calls = { changes: [], requests: [], notifications: [], pauses: [], confirms: [] };
  const forum = {
    safeURL(value) { return typeof value === "string" && value ? new URL(value, "https://linux.do") : null; },
    dateLabel: value => value || "", topicPath: (topic, floor) => `/t/topic/${topic.id}${floor ? `/${floor}` : ""}`,
    tagInfo: tag => typeof tag === "string" ? { name: tag, slug: tag } : tag,
    cooked(value) { const node = new Node("div", "cooked"); node.textContent = value; return node; },
    async request(...args) { calls.requests.push(args); return {}; },
    async change(path, method, body) { calls.changes.push({ path, method, body: body === undefined ? null : plain(body) }); return change ? change(path, method, body) : {}; },
    requestQueue: { cooldown: () => 0, busyError: () => new Error("原站限流") }
  };
  const preloaded = new Node("script"); preloaded.textContent = JSON.stringify({
    siteSettings: JSON.stringify({ emoji_set: "twemoji", enable_emoji: true, discourse_reactions_reaction_for_like: "heart",
      discourse_reactions_enabled_reactions: enabled, discourse_reactions_allow_any_emoji: false, ...settings }),
    customEmoji: JSON.stringify([{ name: "bili_057", group: "b站", url: "https://cdn3.ldstatic.com/b.png" }])
  });
  const location = new URL("https://linux.do/");
  const document = { readyState: "loading", hidden: false, createElement: tag => new Node(tag), addEventListener() {},
    getElementById: id => id === "data-preloaded" ? preloaded : null };
  const window = { location, addEventListener() {}, removeEventListener() {}, confirm(message) { calls.confirms.push(message); return confirm; } };
  const context = vm.createContext({ URL, URLSearchParams, Intl, AbortController, DOMException, setTimeout, clearTimeout, Event, Node, Element: Node,
    document, window, location, localStorage: { getItem: key => key === "ldr-native-tree:sort" ? savedSort ?? null : null },
    innerWidth: 1440, innerHeight: 900, performance: { now: () => 0 }, LDForum: forum,
    __root: root, __detail: detail, __user: user, __calls: calls });
  for (const name of ["navigation.js", "discussions.js", "scrolling.js", "polls.js"]) vm.runInContext(source(name), context);
  const script = source("reader.js").replace("  const requestedAtStart = requestedURL();", `
    root = __root; host = __root; topicRequest = __detail.controller;
    state.onScreen = true; state.selected = __detail.data; state.detail = __detail; state.user = __user;
    state.rows = [__detail.data]; state.nativeContext = { presenceEnabled: false };
    updateSteps = renderList = renderFilters = closeSidebar = sizeReader = resetReplyPager = scheduleRecovery = () => {};
    notify = message => __calls.notifications.push(message);
    globalThis.readerTest = { state, renderReading, clicked, keydown, openMenu, closeMenu, populateMenu, canBoost,
      reactionAllowed, toggleReaction, submitBoost, deleteBoost, boostRaw, boostStats, insertBoostEmoji,
      updateBoostComposer, interactionPointer, clearInteractionTimers, initialReplySort, changeReplySort, topicReplyCount };
    const requestedAtStart = false;
  `);
  vm.runInContext(script, context);
  const api = context.readerTest;
  detail.live = { pause: error => calls.pauses.push(error.message) };
  return { api, calls, detail, root, menu, render: () => api.renderReading(),
    card: floor => root.querySelector(`[data-post-number="${floor}"]`),
    click: target => api.clicked({ target, preventDefault() {} }),
    key: (target, key, extra = {}) => {
      const event = { target, key, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...extra };
      api.keydown(event); return event;
    },
    pointer: (type, target, extra = {}) => api.interactionPointer({ type, target, pointerType: "mouse", relatedTarget: null, ...extra }) };
}

// Rule evidence: actual Linux.do require() classes, provided by lead, show an
// empty-post boost-action-button and a boosts-list tail button using can_boost.
// They do NOT impose a whole-post one-boost restriction. The 50-per-post setting
// remains server-owned; a serialized false must never be overridden by counts.
test("topic and reply entries remain available alongside other people's boosts", () => {
  const f = fixture({ posts: [post(1, { can_boost: true, boosts: [boost(1), boost(2)] }),
    post(2, { can_boost: true, boosts: [boost(3)] }), post(3, { can_boost: true, boosts: [] })] }); f.render();
  for (const floor of [1, 2, 3]) assert.equal(f.card(floor).querySelectorAll('[data-action="boost-compose"]').length, 1);
  assert.ok(f.card(1).querySelector('.post-boosts .boost-add [data-action="boost-compose"]'));
  assert.ok(f.card(2).querySelector('.post-boosts .boost-add [data-action="boost-compose"]'));
  assert.ok(f.card(3).querySelector('.post-boost-actions [data-action="boost-compose"]'));
  assert.equal(f.calls.changes.length, 0); assert.equal(f.calls.requests.length, 0);
});

test("authoritative false, missing permission and unavailable floors never gain a boost entry", async () => {
  const f = fixture({ posts: [post(1, { can_boost: false, boosts: Array.from({ length: 50 }, (_, i) => boost(i)) }),
    post(2, { boosts: [] }), post(3, { can_boost: true, deleted: true }), post(4, { can_boost: true, hidden: true })] }); f.render();
  assert.equal(f.root.querySelectorAll('[data-action="boost-compose"]').length, 0);
  for (const floor of [1, 2, 3, 4]) await f.api.submitBoost(floor);
  assert.equal(f.calls.changes.length, 0);
});

test("submit appends my boost without replacing others, and only explicit submit writes", async () => {
  const f = fixture({ posts: [post(1, { can_boost: true, boosts: [boost(1)] })], change: () => boost(77, 7, { can_delete: true }) }); f.render();
  f.click(f.card(1).querySelector('[data-action="boost-compose"]'));
  assert.ok(f.menu.querySelector("#boost-editor")); assert.equal(f.calls.changes.length, 0);
  f.menu.querySelector("#boost-editor").append("沙发"); await f.api.submitBoost(1);
  assert.deepEqual(f.calls.changes, [{ path: "/discourse-boosts/posts/101/boosts.json", method: "POST", body: { raw: "沙发" } }]);
  assert.deepEqual(plain(f.detail.posts.get(101).boosts.map(item => item.id)), [1, 77]);
  assert.equal(f.detail.posts.get(101).can_boost, false);
  assert.equal(f.card(1).querySelector('[data-action="boost-compose"]'), null);
});

test("deleting my boost restores my entry even when other people's boosts remain", async () => {
  const f = fixture({ posts: [post(1, { can_boost: false, boosts: [boost(1), boost(2, 7, { can_delete: true })] })] }); f.render();
  await f.api.deleteBoost(2);
  assert.equal(f.detail.posts.get(101).can_boost, true);
  assert.deepEqual(f.detail.posts.get(101).boosts.map(item => item.id), [1]);
  assert.ok(f.card(1).querySelector('.post-boosts [data-action="boost-compose"]'));
  assert.equal(f.calls.confirms.length, 0);
  assert.deepEqual(f.calls.changes, [{ path: "/discourse-boosts/boosts/2.json", method: "DELETE", body: null }]);
});

test("deleting someone else's boost requires explicit permission and confirmation and does not grant can_boost", async () => {
  for (const [permission, confirm] of [[false, true], [true, false], [true, true]]) {
    const f = fixture({ posts: [post(1, { can_boost: false, boosts: [boost(1, 9, { can_delete: permission })] })], confirm }); f.render();
    await f.api.deleteBoost(1);
    assert.equal(f.calls.changes.length, permission && confirm ? 1 : 0);
    assert.equal(f.detail.posts.get(101).can_boost, false);
    assert.equal(f.card(1).querySelector('[data-action="boost-compose"]'), null);
  }
});

test("reaction picker uses the native configured ten reactions, not arbitrary reactions used by others", () => {
  const f = fixture({ posts: [post(1, { reactions: [{ id: "alien", count: 2 }], current_user_reaction: { id: "+1", can_undo: true } })],
    data: { valid_reactions: ["alien"] } }); f.render();
  f.key(f.card(1).querySelector('.reaction-action[data-action="react"]'), "ArrowDown");
  assert.deepEqual(f.menu.querySelectorAll(".reaction-choice").map(choice => choice.dataset.value), enabled.split("|"));
  assert.equal(f.menu.querySelector(".reaction-choice.checked").dataset.value, "+1");
  assert.equal(f.menu.querySelector('[data-value="bili_057"] img').src, "https://cdn3.ldstatic.com/b.png");
  assert.equal(f.calls.changes.length, 0);
});

test("author identity, archived topic and authoritative like/undo permissions gate both UI and writes", async () => {
  const own = fixture({ posts: [post(1, { user_id: 7 })] }); own.render();
  assert.equal(own.root.querySelector('[data-action="react"]'), null); await own.api.toggleReaction(1, "heart"); assert.equal(own.calls.changes.length, 0);
  for (const options of [{ data: { archived: true } }, { posts: [post(1, { actions_summary: [{ id: 2, can_act: false, can_undo: false }] })] },
    { posts: [post(1, { current_user_reaction: { id: "+1", can_undo: false } })] }]) {
    const f = fixture(options); f.render();
    assert.ok(f.card(1).querySelector('[data-action="react"]').disabled);
    assert.equal(f.card(1).querySelector('[data-action="react-picker"]'), null);
    assert.equal(f.key(f.card(1).querySelector('.reaction-action[data-action="react"]'), "ArrowDown").defaultPrevented, undefined);
    assert.equal(f.api.state.openMenu, null);
    f.api.openMenu("reactions", f.card(1).querySelector('[data-action="react"]'), { post: f.detail.posts.get(101) });
    assert.ok(f.menu.querySelectorAll(".reaction-choice").every(choice => choice.disabled));
    await f.api.toggleReaction(1, "heart"); assert.equal(f.calls.changes.length, 0);
  }
});

test("current custom reaction is cancelled by the main button, and switching preserves one user total", async () => {
  const f = fixture({ posts: [post(1, { reactions: [{ id: "+1", count: 2 }, { id: "heart", count: 3 }], reaction_users_count: 5,
    current_user_reaction: { id: "+1", can_undo: true } })] }); f.render();
  f.click(f.card(1).querySelector('.post-actions [data-action="react"]')); await delay(0);
  assert.equal(f.calls.changes[0].path, "/discourse-reactions/posts/101/custom-reactions/%2B1/toggle.json");
  assert.equal(f.detail.posts.get(101).current_user_reaction, null); assert.equal(f.detail.posts.get(101).reaction_users_count, 4);
  await f.api.toggleReaction(1, "heart"); await f.api.toggleReaction(1, "clap");
  assert.equal(f.detail.posts.get(101).reaction_users_count, 5);
  assert.equal(f.detail.posts.get(101).current_user_reaction.id, "clap");
});

test("hover opens a picker without stealing focus or writing, and timers cannot outlive detail", async t => {
  const f = fixture(); f.render(); t.after(() => f.api.clearInteractionTimers());
  const main = f.card(1).querySelector('.post-actions [data-action="react"]');
  const other = f.card(2).querySelector('.post-actions [data-action="react"]'); other.focus();
  f.pointer("pointerover", main); await delay(130);
  assert.equal(f.api.state.openMenu.name, "reactions"); assert.equal(f.root.activeElement, other); assert.equal(f.calls.changes.length, 0);
  f.api.closeMenu(); f.pointer("pointerover", main); f.api.clearInteractionTimers(); await delay(130);
  assert.equal(f.api.state.openMenu, null);
  f.pointer("pointerover", main); f.api.state.detail = null; await delay(130);
  assert.equal(f.api.state.openMenu, null);
});

test("hover leaving for ordinary body closes after delay, while entering the popup keeps it open", async t => {
  const f = fixture(); f.render(); t.after(() => f.api.clearInteractionTimers());
  const main = f.card(1).querySelector('.post-actions [data-action="react"]');
  const body = f.card(1).querySelector(".cooked");
  f.pointer("pointerover", main); await delay(130);
  f.pointer("pointerout", main, { relatedTarget: body });
  f.pointer("pointerover", body, { relatedTarget: main }); await delay(530);
  assert.equal(f.api.state.openMenu, null);
  f.pointer("pointerover", main); await delay(130);
  f.pointer("pointerout", main, { relatedTarget: f.menu });
  f.pointer("pointerover", f.menu, { relatedTarget: main }); await delay(530);
  assert.equal(f.api.state.openMenu.name, "reactions"); assert.equal(f.calls.changes.length, 0);
});

test("both empty-post and existing-boost buttons support desktop delayed hover without writing", async t => {
  const f = fixture({ posts: [post(1, { can_boost: true, boosts: [] }), post(2, { can_boost: true, boosts: [boost(1)] })] }); f.render();
  t.after(() => f.api.clearInteractionTimers());
  for (const floor of [1, 2]) {
    const trigger = f.card(floor).querySelector('[data-action="boost-compose"]');
    f.pointer("pointerover", trigger); await delay(230);
    assert.equal(f.api.state.openMenu.name, "boost"); assert.ok(f.menu.querySelector("#boost-editor"));
    assert.equal(f.calls.changes.length, 0); f.api.closeMenu();
  }
});

test("touch short tap reacts; long press opens the picker and suppresses only its trailing click", async t => {
  const f = fixture(); f.render(); t.after(() => f.api.clearInteractionTimers());
  let main = f.card(1).querySelector('.post-actions [data-action="react"]');
  f.pointer("pointerdown", main, { pointerType: "touch", clientX: 10, clientY: 10 });
  f.pointer("pointerup", main, { pointerType: "touch" }); f.click(main); await delay(0);
  assert.equal(f.calls.changes.length, 1);
  main = f.card(1).querySelector('.post-actions [data-action="react"]');
  f.pointer("pointerdown", main, { pointerType: "touch", clientX: 10, clientY: 10 }); await delay(430);
  f.pointer("pointerup", main, { pointerType: "touch" }); f.click(main);
  assert.equal(f.api.state.openMenu.name, "reactions"); assert.equal(f.calls.changes.length, 1);
  f.click(f.menu.querySelector('[data-value="clap"]')); await delay(0);
  assert.equal(f.calls.changes.length, 2);
});

test("moving or cancelling a touch prevents a scroll gesture from opening the picker", async t => {
  const f = fixture(); f.render(); t.after(() => f.api.clearInteractionTimers());
  const main = f.card(1).querySelector('.post-actions [data-action="react"]');
  for (const type of ["pointermove", "pointercancel"]) {
    f.pointer("pointerdown", main, { pointerType: "touch", clientX: 10, clientY: 10 });
    f.pointer(type, main, { pointerType: "touch", clientX: 50, clientY: 50 }); await delay(430);
    assert.equal(f.api.state.openMenu, null); assert.equal(f.calls.changes.length, 0);
  }
});

test("emoji insertion matches native spacing and 16-visible/5-emoji caps; IME Enter never publishes", () => {
  const f = fixture({ posts: [post(1, { can_boost: true })] }); f.render();
  f.click(f.card(1).querySelector('[data-action="boost-compose"]')); const editor = f.menu.querySelector("#boost-editor");
  editor.append("前排"); f.api.insertBoostEmoji(editor, "bili_057");
  assert.equal(f.api.boostRaw(editor), "前排 :bili_057:");
  assert.deepEqual(plain(f.api.boostStats(f.api.boostRaw(editor))), { visible: 4, emoji: 1 });
  editor.textContent = "一".repeat(15); f.api.insertBoostEmoji(editor, "bili_057"); assert.equal(f.api.boostRaw(editor), "一".repeat(15));
  editor.textContent = ":bili_057:".repeat(5); f.api.insertBoostEmoji(editor, "bili_057"); assert.equal(editor.querySelectorAll("img").length, 0);
  editor.dispatchEvent({ type: "keydown", key: "Enter", isComposing: true, preventDefault() { throw new Error("must not intercept IME confirmation"); } });
  assert.equal(f.calls.changes.length, 0);
});

test("failed boost preserves others and can_boost, pauses once, and revalidates the draft instead of enabling every button", async () => {
  const f = fixture({ posts: [post(1, { can_boost: true, boosts: [boost(1)] })],
    change: () => { throw Object.assign(new Error("原站限流"), { status: 429 }); } }); f.render();
  f.click(f.card(1).querySelector('[data-action="boost-compose"]')); const editor = f.menu.querySelector("#boost-editor");
  editor.append("一".repeat(17)); await f.api.submitBoost(1); assert.equal(f.calls.changes.length, 0);
  editor.textContent = ":bili_057:".repeat(5); await f.api.submitBoost(1);
  assert.equal(f.calls.changes.length, 1); assert.equal(f.calls.pauses.length, 1);
  assert.deepEqual(f.detail.posts.get(101).boosts.map(item => item.id), [1]); assert.equal(f.detail.posts.get(101).can_boost, true);
  assert.equal(f.menu.querySelector('[data-action="boost-submit"]').disabled, false);
  assert.equal(f.menu.querySelector('[data-action="boost-emoji"]').disabled, true);
});

test("clicking before a scheduled hover opens does not close or resurrect its menu later", async t => {
  const f = fixture({ posts: [post(1, { can_boost: true })] }); f.render(); t.after(() => f.api.clearInteractionTimers());
  const trigger = f.card(1).querySelector('[data-action="boost-compose"]');
  f.pointer("pointerover", trigger); f.click(trigger); await delay(230);
  assert.equal(f.api.state.openMenu.name, "boost");
  f.pointer("pointerover", trigger); f.click(trigger); await delay(230);
  assert.equal(f.api.state.openMenu, null); assert.equal(f.calls.changes.length, 0);
});

test("boost composer clicks toggle its menu without writes", () => {
  const f = fixture({ posts: [post(1, { can_boost: true })] }); f.render();
  const trigger = f.card(1).querySelector('[data-action="boost-compose"]');
  f.click(trigger); assert.equal(f.api.state.openMenu.name, "boost");
  f.click(trigger); assert.equal(f.api.state.openMenu, null);
  assert.equal(f.calls.changes.length, 0);
});

test("only the main reaction button remains, with an accessible keyboard picker", () => {
  const f = fixture(); f.render();
  const toggle = f.card(1).querySelector('.reaction-action[data-action="react"]');
  assert.equal(f.root.querySelector('[data-action="react-picker"]'), null);
  assert.equal(f.card(1).querySelectorAll(".reaction-action").length, 1);
  assert.equal(toggle.getAttribute("aria-keyshortcuts"), "ArrowDown");
  toggle.focus();
  const event = f.key(toggle.firstElementChild, "ArrowDown");
  assert.equal(event.defaultPrevented, true); assert.equal(event.stopped, true);
  assert.equal(f.api.state.openMenu.name, "reactions");
  assert.equal(f.api.state.openMenu.trigger, toggle);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.ok(f.menu.contains(f.root.activeElement));
  f.key(toggle, "ArrowDown");
  assert.equal(f.api.state.openMenu.name, "reactions", "holding down never toggles the menu closed");
  f.key(f.root.activeElement, "Escape");
  assert.equal(f.api.state.openMenu, null);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(f.root.activeElement, toggle);
  assert.equal(f.calls.changes.length, 0); assert.equal(f.calls.requests.length, 0);
});

test("keyboard picker ignores modifiers, IME, unrelated targets and closed or busy readers", () => {
  const f = fixture(); f.render();
  const toggle = f.card(1).querySelector('.reaction-action[data-action="react"]');
  for (const extra of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { isComposing: true }]) {
    assert.equal(f.key(toggle, "ArrowDown", extra).defaultPrevented, undefined);
    assert.equal(f.api.state.openMenu, null);
  }
  assert.equal(f.key(f.card(1), "ArrowDown").defaultPrevented, undefined);
  f.detail.reactionBusyFloors = new Set([1]);
  assert.equal(f.key(toggle, "ArrowDown").defaultPrevented, undefined);
  f.detail.reactionBusyFloors.clear(); f.api.state.onScreen = false;
  assert.equal(f.key(toggle, "ArrowDown").defaultPrevented, undefined);
  assert.equal(f.api.state.openMenu, null); assert.equal(f.calls.changes.length, 0);
});

test("disabled emoji selection does not advertise or open a keyboard picker", () => {
  const f = fixture({ settings: { enable_emoji: false } }); f.render();
  const toggle = f.card(1).querySelector('.reaction-action[data-action="react"]');
  assert.equal(toggle.getAttribute("aria-haspopup"), null);
  assert.equal(toggle.getAttribute("aria-keyshortcuts"), null);
  assert.equal(f.key(toggle, "ArrowDown").defaultPrevented, undefined);
  assert.equal(f.api.state.openMenu, null); assert.equal(f.calls.changes.length, 0);
});


test("initial reply order defaults to oldest regardless of native or site preference while honoring explicit sort", () => {
  const native = fixture({ savedSort: "new", settings: { nested_replies_default_sort: "top" } });
  assert.equal(native.api.initialReplySort(), "oldest");
  assert.equal(native.api.initialReplySort("/t/topic/123?sort=old"), "oldest");
  assert.equal(native.api.initialReplySort("/t/topic/123?sort=new"), "newest");
  assert.equal(native.api.initialReplySort("/t/topic/123?sort=top"), "top");
  assert.equal(native.api.initialReplySort("/t/topic/123?sort=__proto__"), "oldest");
  assert.equal(fixture({ settings: { nested_replies_default_sort: "top" } }).api.initialReplySort(), "oldest");
  assert.equal(fixture({ savedSort: "constructor" }).api.initialReplySort(), "oldest");
  assert.equal(native.calls.requests.length, 0); assert.equal(native.calls.changes.length, 0);
});

test("explicit reader order applies only to the current topic and does not affect later topics", () => {
  const f = fixture({ savedSort: "new", settings: { nested_replies_default_sort: "newest" } }); f.render();
  f.api.changeReplySort("top");
  assert.equal(f.detail.sort, "top");
  assert.equal(f.api.initialReplySort(), "oldest");
  f.api.changeReplySort("newest");
  assert.equal(f.detail.sort, "newest");
  assert.equal(f.api.initialReplySort(), "oldest");
  assert.equal(f.api.initialReplySort("/t/topic/123?sort=new"), "newest");
});

test("topic counts remain visible with labels, zero views and a missing original post", () => {
  const f = fixture({ posts: [post(2)], data: { posts_count: 3, reply_count: 0, views: 0 } }); f.render();
  assert.equal(f.root.querySelector("#topic-view-count").textContent, "0浏览量");
  assert.equal(f.root.querySelector("#topic-reply-count").textContent, "2回复");
  assert.equal(f.root.querySelectorAll("#topic-metrics").length, 1);
  assert.equal(f.api.topicReplyCount({ posts_count: undefined, reply_count: 7 }), 7);
  assert.equal(f.api.topicReplyCount({ posts_count: NaN }, { posts_count: 5 }), 4);
  assert.equal(f.api.topicReplyCount({}), null);
  const unknown = fixture({ data: { posts_count: undefined, reply_count: undefined } }); unknown.render();
  assert.equal(unknown.root.querySelector("#topic-reply-count"), null);
  assert.equal(unknown.root.querySelector(".reply-count").textContent, "—");
  assert.match(unknown.root.querySelector(".reply-footer").textContent, /总数暂不可用/);
});

const samplePoll = (name = "poll1", extra = {}) => ({ name, title: "统计", type: "regular", status: "open", results: "always", voters: 65,
  options: [{ id: "a", html: "已掉", votes: 10 }, { id: "b", html: "未掉", votes: 55 }], ...extra });

test("actual reader renders polls on available first and reply floors and routes explicit vote clicks", async () => {
  const f = fixture({ posts: [post(1, { polls: [samplePoll()] }), post(2, { polls: [samplePoll("reply")] }),
    post(3, { hidden: true, polls: [samplePoll("hidden")] }), post(4, { user_deleted: true, polls: [samplePoll("deleted")] })],
    change: (path, method, body) => ({ poll: samplePoll(body.poll_name, { voters: 66 }) }) }); f.render();
  assert.equal(f.root.querySelectorAll(".ld-poll").length, 2);
  const widget = f.card(1).querySelector(".ld-poll");
  assert.equal(widget.querySelector(".poll-voters").textContent, "65 人参与");
  f.click(widget.querySelector('[data-action="poll-option"]')); await delay(0);
  assert.deepEqual(f.calls.changes, [{ path: "/polls/vote", method: "PUT", body: { post_id: 101, poll_name: "poll1", options: ["a"] } }]);
  assert.equal(f.detail.posts.get(101).polls[0].voters, 66);
  assert.equal(f.root.querySelectorAll(".ld-poll").length, 2);
});

test("reader results toggles are read-only and hidden polls cannot leak result rows", () => {
  const f = fixture({ posts: [post(1, { polls: [samplePoll()] }), post(2, { polls: [samplePoll("hidden-results", { results: "staff_only" })] })] }); f.render();
  f.click(f.card(1).querySelector('[data-action="poll-results"]'));
  assert.equal(f.card(1).querySelectorAll(".poll-result").length, 2);
  assert.equal(f.card(2).querySelectorAll(".poll-result").length, 0);
  assert.equal(f.calls.changes.length, 0); assert.equal(f.calls.requests.length, 0);
});
