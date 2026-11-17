import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = name => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const plain = value => JSON.parse(JSON.stringify(value));
const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture(sendOverride) {
  const context = vm.createContext({ performance: { now: () => clock }, URLSearchParams });
  let clock = 0;
  vm.runInContext(source("reading.js"), context);
  const batches = [], visits = [], seen = [], reports = [];
  const tracker = new context.LDReading.Tracker({
    now: () => clock,
    send: async batch => { batches.push(plain(batch)); if (sendOverride) await sendOverride(batch); },
    visit: async id => { visits.push(id); },
    acknowledge: (id, floors) => seen.push([id, [...floors]]),
    report: status => reports.push(plain(status))
  });
  return { context, tracker, batches, visits, seen, reports,
    tick: (floors, active = true, ms = 1000) => {
      tracker.sample(floors, active); // establish visibility at the interval start
      clock += ms; tracker.sample(floors, active);
    },
    advance: ms => { clock += ms; } };
}

test("automatic reader only opens forum browsing routes", () => {
  const { readerRoute } = fixture().context.LDReading;
  for (const path of ["/", "/latest", "/new", "/unseen", "/top/weekly", "/t/topic/123/2", "/t/123", "/c/develop/4", "/tag/test/3"]) assert.equal(readerRoute(path), true, path);
  for (const path of ["/login", "/u/mipawn/preferences", "/admin", "/new-topic", "/session", "/chat", "/categories", "/tags"]) assert.equal(readerRoute(path), false, path);
});

test("native category, tag and top period routes retain their feed", () => {
  const { feedRoute } = fixture().context.LDReading;
  assert.deepEqual(plain(feedRoute("/c/resource/cloud-asset/94", "?tags=foo")), { view: "latest", path: "/c/resource/cloud-asset/94.json?tags=foo", categoryId: 94, categorySlug: "cloud-asset" });
  assert.deepEqual(plain(feedRoute("/tag/chatgpt/3")), { view: "latest", path: "/tag/chatgpt/3.json", tagSlug: "chatgpt", tagId: 3 });
  assert.deepEqual(plain(feedRoute("/top/weekly")), { view: "top", path: "/top.json?period=weekly" });
  assert.equal(feedRoute("/").path, "/latest.json");
});

test("pagehide force sends a tail batch while the previous batch is in flight", async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const f = fixture(async () => { await blocked; });
  f.tracker.start(10); f.tick([1]); await settle(); f.tick([1]);
  const flushing = f.tracker.flush({ force: true }); await settle();
  assert.equal(f.batches.length, 2);
  assert.deepEqual(f.batches.map(b => b.timings), [{ 1: 1000 }, { 1: 1000 }]);
  release(); await flushing; await settle();
});

test("only real foreground time counts, one visit per reading session", async () => {
  const f = fixture(); f.tracker.start(123);
  f.tick([1, 2], false); f.tick([], true); f.tick([1], true, 15000);
  assert.equal(f.batches.length, 0); assert.equal(f.visits.length, 0);
  f.tick([1, 1, 2, NaN, -1]); await settle();
  assert.deepEqual(f.batches, [{ topic_id: 123, topic_time: 1000, timings: { 1: 1000, 2: 1000 } }]);
  assert.deepEqual(f.seen, [[123, [1, 2]]]);
  f.tick([1]); await f.tracker.flush();
  assert.deepEqual(f.visits, [123]);
});

test("a newly visible post never receives the preceding second retroactively", async () => {
  const f = fixture(); f.tracker.start(10);
  f.tick([1]); await settle();
  f.advance(1000); f.tracker.sample([100], true); await f.tracker.flush();
  assert.equal(f.batches.some(batch => batch.timings[100]), false);
  f.advance(1000); f.tracker.sample([100], true); await settle();
  assert.equal(f.batches.at(-1).timings[100], 1000);
});

test("topic switching flushes the OLD topic without mixing milliseconds", async () => {
  const f = fixture(); f.tracker.start(10); f.tick([1]); await settle();
  f.tick([1]); f.tracker.start(20); f.tick([3]); await settle(); await f.tracker.flush();
  assert.deepEqual(f.batches.map(b => [b.topic_id, b.timings]), [[10, { 1: 1000 }], [10, { 1: 1000 }], [20, { 3: 1000 }]]);
});

test("failed timings keep pending time, do not acknowledge, and back off", async () => {
  let fail = true;
  const f = fixture(async () => { if (fail) throw new Error("HTTP 429"); });
  f.tracker.start(10); f.tick([1]); await settle();
  assert.deepEqual(f.seen, []);
  f.tick([1]); await f.tracker.flush();
  assert.equal(f.batches.length, 1);
  fail = false; f.advance(30000); await f.tracker.flush();
  assert.deepEqual(f.batches[1], { topic_id: 10, topic_time: 2000, timings: { 1: 2000 } });
  assert.deepEqual(f.seen, [[10, [1]]]);
});

test("pending time survives a topic switch during an in-flight request", async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let first = true;
  const f = fixture(async () => { if (first) { first = false; await blocked; } });
  f.tracker.start(10); f.tick([1]); await settle();
  f.tick([1]); f.tracker.start(20); f.tick([2]); await settle();
  release(); await settle(); await settle();
  assert.equal(f.batches.filter(b => b.topic_id === 10).length, 2);
  assert.equal(f.batches.filter(b => b.topic_id === 20).length, 1);
});

test("offline backlog retains more than one minute and sends bounded batches", async () => {
  let fail = true;
  const f = fixture(async () => { if (fail) throw new Error("offline"); });
  f.tracker.start(10);
  for (let i = 0; i < 180; i++) { f.tick([1]); await f.tracker.flush(); }
  assert.equal(f.tracker.current.topicTime, 180000);
  assert.equal(f.tracker.current.timings[1], 180000);
  fail = false; f.advance(30000);
  await f.tracker.flush(); await f.tracker.flush(); await f.tracker.flush();
  const success = f.batches.slice(-3);
  assert.equal(success.reduce((sum, batch) => sum + batch.timings[1], 0), 180000);
  assert.ok(success.every(batch => batch.topic_time <= 60000 && batch.timings[1] <= 60000));
});

test("force flush retains retired in-flight sessions for failure retry", async () => {
  let reject;
  const blocked = new Promise((resolve, fail) => { reject = fail; });
  let first = true;
  const f = fixture(async () => { if (first) { first = false; await blocked; } });
  f.tracker.start(10); f.tick([1]); await settle(); f.tracker.start(20);
  await f.tracker.flush({ force: true });
  reject(new Error("offline")); await settle(); f.advance(30000);
  await f.tracker.flush();
  assert.equal(f.batches.filter(batch => batch.topic_id === 10).length, 2);
});

test("one post stops accumulating after the native six-minute cap", async () => {
  const f = fixture(); f.tracker.start(10);
  for (let i = 0; i < 400; i++) { f.tick([1]); await f.tracker.flush(); }
  assert.equal(f.batches.reduce((sum, b) => sum + (b.timings[1] || 0), 0), 360000);
  assert.equal(f.visits.length, 1);
});

test("visibility uses each post's own rectangle, not its descendant branch", () => {
  const f = fixture(); f.context.innerWidth = 1000; f.context.innerHeight = 800;
  const node = (floor, top, bottom, width = 100) => ({ dataset: { postNumber: floor }, getBoundingClientRect: () => ({ top, bottom, left: 0, right: width, width, height: bottom - top }) });
  const viewport = { getBoundingClientRect: () => ({ top: 100, bottom: 700, left: 0, right: 900 }) };
  const root = { querySelectorAll: () => [node(1, 120, 500), node(2, 710, 760), node(3, 0, 50), node(4, 300, 300, 0)] };
  assert.deepEqual([...f.context.LDReading.visiblePosts(root, viewport)], [1]);
});

function forumFixture() {
  const calls = [];
  let failOnce = false;
  const context = vm.createContext({ URL, URLSearchParams, Intl, fetch: async (url, options) => {
    calls.push({ url, options });
    const csrf = url === "/session/csrf.json";
    const status = failOnce && !csrf ? 403 : 200;
    if (!csrf) failOnce = false;
    return { ok: status === 200, status, json: async () => csrf ? { csrf: "test-token" } : {} };
  } });
  vm.runInContext(source("forum.js"), context);
  return { forum: context.LDForum, calls, fail: () => { failOnce = true; } };
}

test("visits use BOTH view-tracking headers and track_visit", async () => {
  const { forum, calls } = forumFixture();
  await forum.visitTopic(123);
  assert.equal(calls[0].url, "/t/123.json?track_visit=true");
  assert.equal(calls[0].options.headers["Discourse-Track-View"], "true");
  assert.equal(calls[0].options.headers["Discourse-Track-View-Topic-Id"], "123");
  assert.equal(calls[0].options.credentials, "same-origin");
});

test("timings send millisecond map, shared CSRF, and keepalive", async () => {
  const { forum, calls } = forumFixture();
  const batch = { topic_id: 123, topic_time: 1000, timings: { 1: 1000 } };
  await Promise.all([forum.prepareCSRF(), forum.prepareCSRF()]);
  await forum.recordReading(batch); await forum.recordReading(batch);
  assert.equal(calls.filter(c => c.url === "/session/csrf.json").length, 1);
  const request = calls.find(c => c.url === "/topics/timings");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.keepalive, true);
  assert.equal(request.options.headers["X-CSRF-Token"], "test-token");
  assert.deepEqual(JSON.parse(request.options.body), batch);
});

test("403 renews CSRF once and retries the same reading batch", async () => {
  const f = forumFixture(); await f.forum.prepareCSRF(); f.fail();
  await f.forum.recordReading({ topic_id: 1, topic_time: 1000, timings: { 1: 1000 } });
  assert.equal(f.calls.filter(c => c.url === "/session/csrf.json").length, 2);
  assert.equal(f.calls.filter(c => c.url === "/topics/timings").length, 2);
});

test("MAIN bridge only accepts numeric positive identifiers and updates native service", () => {
  let listener;
  const seen = [];
  const context = vm.createContext({
    document: { addEventListener: (name, fn) => { assert.equal(name, "linux-do-reader:read"); listener = fn; } },
    window: { Discourse: { lookup: name => { assert.equal(name, "service:topic-tracking-state"); return { updateSeen: (...args) => seen.push(args) }; } } }
  });
  vm.runInContext(source("bridge.js"), context);
  listener({ detail: JSON.stringify({ topicId: 123, lastRead: 2 }) });
  listener({ detail: JSON.stringify({ topicId: "123", lastRead: 2 }) });
  listener({ detail: "bad json" }); listener({ detail: JSON.stringify({ topicId: 123, lastRead: -1 }) });
  assert.deepEqual(seen, [[123, 2]]);
});

test("manifest and package include isolated tracker and MAIN bridge", () => {
  const manifest = JSON.parse(source("manifest.json"));
  assert.deepEqual(manifest.content_scripts[0].js, ["forum.js", "reading.js", "scrolling.js", "reader.js"]);
  assert.ok(source("scripts/package.py").includes('"scrolling.js"'));
  assert.equal(manifest.content_scripts[1].world, "MAIN");
  assert.deepEqual(manifest.content_scripts[1].js, ["bridge.js"]);
  assert.ok(source("scripts/package.py").includes('"reading.js"'));
  assert.ok(source("scripts/package.py").includes('"bridge.js"'));
  for (const name of ["LICENSE", "NOTICE", "README.md", "PRIVACY.md"]) {
    assert.ok(source("scripts/package.py").includes(JSON.stringify(name)), `${name} must accompany release files`);
  }
  assert.match(source("LICENSE"), /Apache License[\s\S]*Version 2\.0/);
  assert.match(source("NOTICE"), /Copyright 2026 Mipawn/);
});

test("confirmed reading clears new-topic state without inventing unread replies", () => {
  const { markRead } = fixture().context.LDReading;
  const topic = { unseen: true, last_read_post_number: null, unread_posts: 0, highest_post_number: 100 };
  assert.equal(markRead(topic, 1), true);
  assert.deepEqual(topic, { unseen: false, last_read_post_number: 1, unread_posts: 0, highest_post_number: 100 });
  assert.equal(markRead(topic, 1), false, "repeated acknowledgement must not repaint the entire list");
  const tracked = { unseen: false, last_read_post_number: 5, unread_posts: 3 };
  assert.equal(markRead(tracked, 6), true);
  assert.equal(tracked.unread_posts, 2);
  assert.equal(markRead(tracked, 4), false);
  assert.equal(tracked.last_read_post_number, 6);
  assert.equal(tracked.unread_posts, 2);
  assert.equal(markRead(tracked, -1), false);
});

test("reading UI removes the dot instead of fading it and uses in-reader buttons", () => {
  const reader = source("reader.js");
  assert.match(reader, /const summary = button\("", "topic"/);
  assert.match(reader, /const marker = topic\.unseen \? element\("span", "unseen-dot"\) : null/);
  assert.ok(reader.includes('"置顶，不表示未读"'));
  assert.doesNotMatch(source("reader.css"), /unseen-dot\.faint|pinned-dot/);
  assert.match(source("reader.css"), /\.branch-dot \{[^}]*background: var\(--border-strong\)/);
  assert.match(source("reader.css"), /\.reading-sync\.error \{ flex: 0 1 auto;/);
  assert.ok(reader.includes("${state.listGeneration}:${state.view}"));
  assert.doesNotMatch(reader, /Keep native Cmd\/Ctrl-click/);
  assert.ok(reader.includes('viewport: $("#list-scroll")'));
  assert.ok(reader.includes('viewport: $("#read-scroll")'));
});

test("sync status reports failure and later acceptance without optimistic read state", async () => {
  let failing = true;
  const f = fixture(async () => { if (failing) throw new Error("offline"); });
  f.tracker.start(123); f.tick([1]); await settle();
  assert.deepEqual(f.reports.map(status => status.phase), ["sending", "failed"]);
  assert.equal(f.seen.length, 0);
  failing = false; f.advance(30000); await f.tracker.flush();
  assert.deepEqual(f.reports.map(status => status.phase), ["sending", "failed", "sending", "synced"]);
  assert.deepEqual(f.reports.at(-1), { topicId: 123, phase: "synced", floors: [1] });
  assert.deepEqual(f.seen, [[123, [1]]]);
});

test("a broken sync-status observer never retries an accepted batch", async () => {
  const f = fixture();
  f.tracker.report = () => { throw new Error("UI unavailable"); };
  f.tracker.start(123); f.tick([1]); await settle(); await f.tracker.flush();
  assert.equal(f.batches.length, 1);
  assert.deepEqual(f.seen, [[123, [1]]]);
  assert.equal(f.tracker.current.topicTime, 0);
});
