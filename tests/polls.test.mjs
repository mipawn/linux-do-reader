import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../polls.js", import.meta.url), "utf8");
const plain = value => JSON.parse(JSON.stringify(value));
const dataKey = value => value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());

// Standalone in-memory DOM. The only write transport is a recording stub; these
// tests never load reader.js or send any votes to the live forum.
class Node {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase(); this.className = ""; this.children = []; this.parentNode = null;
    this.dataset = {}; this.attributes = new Map(); this.disabled = false;
    this.style = { values: new Map(), setProperty(name, value) { this.values.set(name, value); } };
  }
  get textContent() { return this.children.map(node => node instanceof Node ? node.textContent : String(node)).join(""); }
  set textContent(value) { this.replaceChildren(String(value)); }
  get isConnected() { return this._connected || !!this.parentNode?.isConnected; }
  append(...nodes) { for (const node of nodes) { if (node instanceof Node) { node.remove(); node.parentNode = this; } this.children.push(node); } }
  replaceChildren(...nodes) { for (const node of this.children) if (node instanceof Node) node.parentNode = null; this.children = []; this.append(...nodes); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this); this.parentNode = null; }
  contains(node) { return this === node || this.children.some(child => child instanceof Node && child.contains(node)); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); if (name.startsWith("data-")) this.dataset[dataKey(name.slice(5))] = String(value); }
  getAttribute(name) { if (name === "class") return this.className; if (name.startsWith("data-")) return this.dataset[dataKey(name.slice(5))] ?? null; return this.attributes.get(name) ?? null; }
  matches(selector) {
    const tag = selector.match(/^([a-z]+)/i)?.[1]; if (tag && tag.toUpperCase() !== this.tagName) return false;
    for (const [, name] of selector.matchAll(/\.([\w-]+)/g)) if (!this.className.split(/\s+/).includes(name)) return false;
    for (const [, name, value] of selector.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g)) {
      const actual = this.getAttribute(name); if (actual === null || value !== undefined && actual !== value) return false;
    }
    return true;
  }
  closest(selector) { for (let node = this; node; node = node.parentNode) if (node.matches(selector)) return node; return null; }
  querySelectorAll(selector) {
    const found = [];
    for (const child of this.children) if (child instanceof Node) {
      if (child.matches(selector)) found.push(child);
      found.push(...child.querySelectorAll(selector));
    }
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

const poll = (extra = {}) => ({ name: "poll", type: "regular", status: "open", results: "always", voters: 3,
  options: [{ id: "a", html: "<b>甲</b>", votes: 2 }, { id: "b", html: "乙", votes: 1 }, { id: "c", html: "丙", votes: 0 }], ...extra });
const post = (extra = {}) => ({ id: 101, topic_id: 123, post_number: 1, user_id: 9, polls: [poll()], polls_votes: {}, ...extra });
function fixture({ value = post(), user = { id: 7 }, topic = {}, change } = {}) {
  const root = new Node("root"); root._connected = true;
  const detail = { data: { id: 123, slug: "topic", ...topic }, posts: new Map([[value.id, value]]), controller: new AbortController() };
  const context = { detail, user, onScreen: true };
  const calls = { changes: [], cooked: [], changed: [], errors: [] };
  const forum = {
    siteURL: "https://linux.do",
    topicPath: (topic, floor) => `/t/${topic.slug}/${topic.id}/${floor}`,
    cooked(html) { calls.cooked.push(html); const node = new Node("span"); node.textContent = html; return node; },
    async change(path, method, body, options) {
      calls.changes.push({ path, method, body: plain(body), signal: options?.signal });
      if (change) return change(path, method, body);
      return { poll: poll({ name: body.poll_name, voters: method === "DELETE" ? 2 : 4 }) };
    }
  };
  const sandbox = vm.createContext({ document: { createElement: tag => new Node(tag) }, URL, Date, LDForum: forum });
  vm.runInContext(source, sandbox);
  const api = sandbox.LDPolls.create({ forum, document: sandbox.document, getContext: () => context,
    onChange: value => calls.changed.push(value), onError: error => calls.errors.push(error) });
  const render = () => root.replaceChildren(...api.render(detail.posts.get(value.id)));
  render();
  return { api, calls, root, detail, context, value, render,
    section: () => root.querySelector("section"),
    action: name => root.querySelector(`[data-action="${name}"]`),
    option: id => root.querySelector(`[data-option-id="${id}"]`),
    click: node => api.handle(node?.closest?.("[data-action]")?.dataset.action, node) };
}
function deferred() { let resolve, reject; const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; }); return { promise, resolve, reject }; }
const writes = f => f.calls.changes.map(({ signal, ...call }) => call);

test("renders only serialized polls with names/post ids and sanitized titles/options", () => {
  const f = fixture({ value: post({ cooked: '<div class="poll">not a serialized poll</div>', polls: [poll({ title: "<strong>问题</strong>" }), poll({ name: "second" })] }) });
  assert.equal(f.root.querySelectorAll("section").length, 2);
  assert.equal(f.section().dataset.pollName, "poll"); assert.equal(f.section().dataset.postId, 101);
  assert.ok(f.calls.cooked.includes("<strong>问题</strong>")); assert.ok(f.calls.cooked.includes("<b>甲</b>"));
  assert.equal(f.root.querySelectorAll(".poll-result").length, 0);
  assert.equal(f.calls.changes.length, 0);
  const absent = fixture({ value: post({ polls: undefined, cooked: '<div class="poll">static</div>' }) });
  assert.equal(absent.root.children.length, 0);
});

test("always results stay opt-in initially and use voters rather than sum of multiple ballots", async () => {
  const f = fixture({ value: post({ polls: [poll({ type: "multiple", voters: 4, options: [{ id: "a", html: "A", votes: 3 }, { id: "b", html: "B", votes: 3 }] })] }) });
  await f.click(f.action("poll-results"));
  assert.deepEqual(f.root.querySelectorAll(".poll-result-stats").map(node => node.textContent), ["3 票 · 75%", "3 票 · 75%"]);
  assert.equal(f.root.querySelector(".poll-result-bar").style.values.get("--poll-percent"), "75%");
  await f.click(f.action("poll-results")); assert.ok(f.action("poll-submit"));
  assert.equal(f.calls.changes.length, 0);
});

test("saved named ballots are selected and shown in results without touching other polls", async () => {
  const f = fixture({ value: post({ polls: [poll(), poll({ name: "other" })], polls_votes: { poll: ["b"], other: ["a"] } }) });
  assert.equal(f.section().querySelectorAll(".is-voted")[0].dataset.optionId, "b");
  await f.click(f.section().querySelector('[data-action="poll-results"]'));
  assert.equal(f.section().querySelector('[data-option-id="b"]').getAttribute("aria-checked"), "true");
  assert.deepEqual(f.value.polls_votes.other, ["a"]); assert.equal(f.calls.changes.length, 0);
});

test("single regular vote submits immediately, accepts native {poll}, and never reads result.vote", async () => {
  const f = fixture({ change: () => ({ poll: poll({ voters: 4 }), vote: ["b"] }) });
  await f.click(f.option("a").querySelector(".poll-option-label"));
  assert.deepEqual(writes(f), [{ path: "/polls/vote", method: "PUT", body: { post_id: 101, poll_name: "poll", options: ["a"] } }]);
  assert.deepEqual(plain(f.value.polls_votes), { poll: ["a"] });
  assert.equal(f.value.polls[0].voters, 4); assert.equal(f.calls.changed.length, 1);
  assert.ok(f.root.querySelector(".poll-result")); assert.equal(f.calls.errors.length, 0);
});

test("number poll submits as single and computes native weighted average from existing result options", async () => {
  const numeric = poll({ type: "number", voters: 3, average: 99, options: [{ id: "one", html: "1", votes: 1 }, { id: "five", html: "5", votes: 2 }] });
  const f = fixture({ value: post({ polls: [numeric] }), change: () => ({ poll: numeric }) });
  await f.click(f.option("five"));
  assert.deepEqual(writes(f)[0].body.options, ["five"]);
  assert.equal(f.root.querySelector(".poll-average").textContent, "平均值：3.67");
});

test("multiple choices write only on explicit submit and enforce min/max", async () => {
  const f = fixture({ value: post({ polls: [poll({ type: "multiple", min: "2", max: "2" })] }) });
  assert.ok(f.action("poll-submit").disabled);
  await f.click(f.option("a")); assert.equal(f.calls.changes.length, 0);
  await f.click(f.action("poll-submit")); assert.equal(f.calls.changes.length, 0);
  assert.match(f.root.textContent, /请选择 2 项后提交/);
  await f.click(f.option("b")); assert.equal(f.action("poll-submit").disabled, false);
  await f.click(f.option("c")); assert.match(f.root.textContent, /最多只能选择 2 项/);
  assert.equal(f.option("c").getAttribute("aria-checked"), "false");
  await f.click(f.action("poll-submit"));
  assert.deepEqual(writes(f), [{ path: "/polls/vote", method: "PUT", body: { post_id: 101, poll_name: "poll", options: ["a", "b"] } }]);
});

test("multiple selected options survive rerenders, can be deselected, and update a saved vote", async () => {
  const f = fixture({ value: post({ polls: [poll({ type: "multiple" })], polls_votes: { poll: ["a"] } }) });
  await f.click(f.action("poll-results")); await f.click(f.option("a")); await f.click(f.option("c")); f.render();
  assert.equal(f.option("a").getAttribute("aria-checked"), "false");
  assert.equal(f.option("c").getAttribute("aria-checked"), "true");
  await f.click(f.action("poll-submit")); assert.deepEqual(plain(f.value.polls_votes.poll), ["c"]);
});

test("DELETE cancellation refreshes counters, clears only that ballot and returns to choices", async () => {
  const f = fixture({ value: post({ polls_votes: { poll: ["a"], other: ["z"] } }) });
  await f.click(f.action("poll-remove"));
  assert.deepEqual(writes(f), [{ path: "/polls/vote", method: "DELETE", body: { post_id: 101, poll_name: "poll" } }]);
  assert.deepEqual(plain(f.value.polls_votes), { other: ["z"] }); assert.equal(f.value.polls[0].voters, 2);
  assert.ok(f.action("poll-option")); assert.equal(f.action("poll-remove"), null);
  assert.ok(f.root.querySelectorAll(".poll-option").every(node => node.getAttribute("aria-checked") === "false"));
});

test("on_vote results require a ballot or author identity while open", async () => {
  for (const [user, ballot, permitted] of [[{ id: 7 }, {}, false], [{ id: 9 }, {}, true], [{ id: 7 }, { poll: ["a"] }, true]]) {
    const f = fixture({ user, value: post({ polls: [poll({ results: "on_vote" })], polls_votes: ballot }) });
    assert.equal(!!f.action("poll-results"), permitted);
    if (!ballot.poll && permitted) await f.click(f.action("poll-results"));
    assert.equal(f.root.querySelectorAll(".poll-result").length > 0, permitted);
    if (!permitted) { await f.api.handle("poll-results", f.section()); assert.equal(f.root.querySelectorAll(".poll-result").length, 0); }
    assert.equal(f.calls.changes.length, 0);
  }
});

test("on_close and staff_only never expose result rows before permission even with saved votes", async () => {
  for (const [results, user] of [["on_close", { id: 7 }], ["staff_only", { id: 7 }]]) {
    const f = fixture({ user, value: post({ polls: [poll({ results })], polls_votes: { poll: ["a"] } }) });
    assert.equal(f.action("poll-results"), null); assert.equal(f.root.querySelectorAll(".poll-result").length, 0);
    await f.api.handle("poll-results", f.section()); assert.equal(f.root.querySelectorAll(".poll-result").length, 0);
  }
  for (const user of [{ id: 7, staff: true }, { id: 7, admin: true }, { id: 7, moderator: true }]) {
    const f = fixture({ user, value: post({ polls: [poll({ results: "staff_only" })] }) });
    await f.click(f.action("poll-results")); assert.equal(f.root.querySelectorAll(".poll-result").length, 3);
  }
});

test("closed/deadline/archived force results for on_vote but disable voting, cancellation and hiding", async () => {
  for (const [extra, topic] of [[{ status: "closed" }, {}], [{ close: "2000-01-01T00:00:00Z" }, {}], [{}, { archived: true }]]) {
    const f = fixture({ topic, value: post({ polls: [poll({ results: "on_vote", ...extra })] }) });
    assert.equal(f.root.querySelectorAll(".poll-result").length, 3);
    assert.equal(f.action("poll-results"), null); assert.equal(f.action("poll-remove"), null);
    await f.api.handle("poll-option", f.section()); await f.api.handle("poll-remove", f.section());
    assert.equal(f.calls.changes.length, 0);
  }
  const staff = fixture({ topic: { archived: true }, value: post({ polls: [poll({ results: "staff_only" })], polls_votes: { poll: ["a"] } }) });
  assert.equal(staff.root.querySelectorAll(".poll-result").length, 0); assert.ok(staff.action("poll-option").disabled);
  const waiting = fixture({ topic: { archived: true }, value: post({ polls: [poll({ results: "on_close" })] }) });
  assert.equal(waiting.root.querySelectorAll(".poll-result").length, 0);
  const done = fixture({ value: post({ polls: [poll({ status: "closed", results: "on_close" })] }) });
  assert.equal(done.root.querySelectorAll(".poll-result").length, 3);
});

test("topic.closed and post.can_vote are not ordinary poll voting permissions", async () => {
  const f = fixture({ topic: { closed: true }, value: post({ can_vote: false }) });
  await f.click(f.option("a")); assert.equal(f.calls.changes.length, 1);
});

test("guest, group membership, hidden/deleted posts gate both UI and programmatic actions", async () => {
  for (const options of [{ user: null }, { user: { id: 7 }, value: post({ polls: [poll({ groups: "trust_level_3, admins" })] }) },
    { value: post({ hidden: true }) }, { value: post({ deleted: true }) }]) {
    const f = fixture(options); assert.ok(f.action("poll-option").disabled);
    await f.click(f.option("a")); await f.api.handle("poll-submit", f.section()); await f.api.handle("poll-remove", f.section());
    assert.equal(f.calls.changes.length, 0);
  }
  for (const user of [{ id: 7, visibleGroups: [{ name: "AdMiNs" }] }, { id: 7, groups: [{ name: "admins" }] }]) {
    const f = fixture({ user, value: post({ polls: [poll({ groups: "trust_level_3, admins" })] }) });
    await f.click(f.option("a")); assert.equal(f.calls.changes.length, 1);
  }
  const guest = fixture({ user: null }); await guest.click(guest.action("poll-results"));
  assert.equal(guest.root.querySelectorAll(".poll-result").length, 3);
});

test("ranked_choice is explicitly downgraded to a safe original-site link, never PUT", async () => {
  const f = fixture({ value: post({ polls: [poll({ type: "ranked_choice" })] }) });
  assert.match(f.root.textContent, /排序投票需使用原站界面/);
  assert.equal(f.action("poll-option"), null);
  const link = f.root.querySelector("a"); assert.equal(link.href, "https://linux.do/t/topic/123/1");
  assert.equal(link.rel, "noopener noreferrer");
  await f.api.handle("poll-option", f.section()); assert.equal(f.calls.changes.length, 0);
});

test("zero-voter polls have no result button and no fabricated percentages", () => {
  const f = fixture({ value: post({ polls: [poll({ voters: 0, options: [{ id: "a", html: "A", votes: 0 }] })] }) });
  assert.equal(f.action("poll-results"), null);
  const closed = fixture({ value: post({ polls: [poll({ voters: 0, status: "closed", options: [{ id: "a", html: "A", votes: 0 }] })] }) });
  assert.equal(closed.root.querySelector(".poll-result-stats").textContent, "0 票 · 0%");
});

test("in-flight writes remain busy across rerenders and reject duplicate actions", async () => {
  const pending = deferred(), f = fixture({ change: () => pending.promise });
  const operation = f.click(f.option("a")); f.render();
  assert.equal(f.section().getAttribute("aria-busy"), "true"); assert.ok(f.action("poll-option").disabled);
  await f.click(f.option("b")); await f.api.handle("poll-remove", f.section());
  assert.equal(f.calls.changes.length, 1); assert.deepEqual(f.value.polls_votes, {});
  pending.resolve({ poll: poll({ voters: 4 }) }); await operation;
  assert.equal(f.section().getAttribute("aria-busy"), "false"); assert.deepEqual(plain(f.value.polls_votes.poll), ["a"]);
});

test("real server errors are shown unchanged, preserve ballots/counters, and are never retried", async () => {
  const error = Object.assign(new Error("原站限流，请 19 秒后重试。"), { status: 429 });
  const f = fixture({ change: () => { throw error; } });
  await f.click(f.option("a"));
  assert.equal(f.calls.changes.length, 1); assert.equal(f.calls.errors[0], error);
  assert.equal(f.root.querySelector('[role="alert"]').textContent, error.message);
  assert.deepEqual(f.value.polls_votes, {}); assert.equal(f.value.polls[0].voters, 3);
  assert.equal(f.option("a").getAttribute("aria-checked"), "false"); assert.equal(f.section().getAttribute("aria-busy"), "false");
  const multi = fixture({ value: post({ polls: [poll({ type: "multiple" })] }), change: () => { throw new Error("登录已失效。"); } });
  await multi.click(multi.option("b")); await multi.click(multi.action("poll-submit"));
  assert.equal(multi.option("b").getAttribute("aria-checked"), "true"); assert.equal(multi.calls.changes.length, 1);
  const cancel = fixture({ value: post({ polls_votes: { poll: ["a"] } }), change: () => { throw error; } });
  await cancel.click(cancel.action("poll-remove")); assert.deepEqual(cancel.value.polls_votes.poll, ["a"]); assert.equal(cancel.value.polls[0].voters, 3);
});

test("malformed write receipts are not fabricated into successful local ballots", async () => {
  for (const response of [{}, { poll: poll({ name: "wrong" }) }, { poll: { name: "poll" } }]) {
    const f = fixture({ change: () => response }); await f.click(f.option("a"));
    assert.equal(f.calls.changes.length, 1); assert.equal(f.calls.changed.length, 0);
    assert.deepEqual(f.value.polls_votes, {}); assert.match(f.root.textContent, /未自动重试/);
  }
});

test("topic switch, reader hide, abort and destroy discard late success and failure without callbacks", async () => {
  for (const transition of [f => { f.context.detail = { data: { id: 456 }, posts: new Map() }; },
    f => { f.context.onScreen = false; }, f => f.detail.controller.abort(), f => f.api.destroy()]) {
    for (const fail of [false, true]) {
      const pending = deferred(), f = fixture({ change: () => pending.promise });
      const operation = f.click(f.option("a")); transition(f);
      if (fail) pending.reject(new Error("旧话题失败")); else pending.resolve({ poll: poll({ voters: 4 }) });
      await operation;
      assert.deepEqual(f.value.polls_votes, {}); assert.equal(f.value.polls[0].voters, 3);
      assert.equal(f.calls.changed.length, 0); assert.equal(f.calls.errors.length, 0);
    }
  }
});

test("same-topic live replacements receive only this poll receipt and preserve unrelated new data", async () => {
  const pending = deferred(), f = fixture({ change: () => pending.promise });
  const operation = f.click(f.option("a"));
  const latest = post({ cooked: "updated body", polls: [poll({ title: "new title" }), poll({ name: "other", voters: 88 })], polls_votes: { other: ["z"] } });
  f.detail.posts.set(101, latest);
  pending.resolve({ poll: poll({ voters: 4 }) }); await operation;
  assert.equal(latest.cooked, "updated body"); assert.equal(latest.polls[1].voters, 88);
  assert.deepEqual(plain(latest.polls_votes), { other: ["z"], poll: ["a"] });
  assert.deepEqual(f.value.polls_votes, {}); assert.equal(f.calls.changed[0], latest);
});

test("old disconnected controls, foreign sections and off-screen actions cannot write", async () => {
  const f = fixture(), previous = f.option("a"); f.render();
  assert.equal(await f.api.handle("poll-option", previous), false);
  const foreign = new Node("section"); foreign.dataset.pollName = "poll"; foreign.dataset.postId = 101; f.root.append(foreign);
  assert.equal(await f.api.handle("poll-remove", foreign), false);
  f.context.onScreen = false; assert.equal(await f.click(f.option("a")), false);
  assert.equal(f.calls.changes.length, 0);
});

test("live personal-ballot changes reset stale selection while other named ballots stay isolated", async () => {
  const f = fixture({ value: post({ polls: [poll({ type: "multiple" })] }) });
  await f.click(f.option("a")); f.value.polls_votes = { poll: ["b"] }; f.render();
  assert.equal(f.section().querySelector(".is-voted").dataset.optionId, "b");
  await f.click(f.action("poll-results"));
  assert.equal(f.option("a").getAttribute("aria-checked"), "false"); assert.equal(f.option("b").getAttribute("aria-checked"), "true");
});

test("permission and option changes are rechecked at handle time, not only at render", async () => {
  const closed = fixture(), oldChoice = closed.option("a");
  closed.value.polls[0].status = "closed";
  await closed.click(oldChoice); assert.equal(closed.calls.changes.length, 0);
  const groups = fixture(), groupChoice = groups.option("a");
  groups.value.polls[0].groups = "admins";
  await groups.click(groupChoice); assert.equal(groups.calls.changes.length, 0);
  const multi = fixture({ value: post({ polls: [poll({ type: "multiple" })] }) });
  await multi.click(multi.option("a"));
  multi.value.polls[0].options = multi.value.polls[0].options.filter(option => option.id !== "a");
  await multi.click(multi.action("poll-submit"));
  assert.equal(multi.calls.changes.length, 0); assert.match(multi.root.textContent, /请选择/);
});

test("simultaneous named polls have independent busy lanes and cancellation stays race safe", async () => {
  const first = deferred(), second = deferred();
  const f = fixture({ value: post({ polls: [poll(), poll({ name: "other" })], polls_votes: { other: ["a"] } }),
    change: (path, method, body) => body.poll_name === "poll" ? first.promise : second.promise });
  const vote = f.click(f.section().querySelector('[data-option-id="b"]'));
  const cancel = f.click(f.root.querySelectorAll("section")[1].querySelector('[data-action="poll-remove"]'));
  assert.equal(f.calls.changes.length, 2);
  second.resolve({ poll: poll({ name: "other", voters: 2 }) }); await cancel;
  assert.deepEqual(plain(f.value.polls_votes), {});
  first.resolve({ poll: poll({ voters: 4 }) }); await vote;
  assert.deepEqual(plain(f.value.polls_votes), { poll: ["b"] });
  const late = deferred(), switched = fixture({ value: post({ polls_votes: { poll: ["a"] } }), change: () => late.promise });
  const removal = switched.click(switched.action("poll-remove")); switched.context.detail = {};
  late.resolve({ poll: poll({ voters: 2 }) }); await removal;
  assert.deepEqual(switched.value.polls_votes.poll, ["a"]); assert.equal(switched.value.polls[0].voters, 3);
});
