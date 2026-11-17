import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = name => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const plain = value => JSON.parse(JSON.stringify(value));
function navigationFixture() {
  const context = vm.createContext({ URLSearchParams });
  vm.runInContext(source("navigation.js"), context);
  return context.LDNavigation;
}

test("list and topic routes automatically open the reader", () => {
  const { readerRoute } = navigationFixture();
  for (const path of ["/t/topic/123/2", "/t/123", "/", "/latest", "/new", "/unseen", "/unread", "/top/weekly", "/c/develop/4", "/c/resource/cloud-asset/94", "/c/develop/4/latest", "/tag/test/3"])
    assert.equal(readerRoute(path), true, path);
  for (const path of ["/login", "/u/mipawn/preferences", "/admin", "/new-topic", "/session", "/chat", "/categories", "/tags", "/latest/other", "/t/new", "/c/foo/new-topic"])
    assert.equal(readerRoute(path), false, path);
});

test("native category, tag and top period routes retain their feed", () => {
  const { feedRoute } = navigationFixture();
  assert.deepEqual(plain(feedRoute("/c/resource/cloud-asset/94", "?tags=foo")), { view: "latest", path: "/c/resource/cloud-asset/94.json?tags=foo", categoryId: 94, categorySlug: "cloud-asset" });
  assert.deepEqual(plain(feedRoute("/tag/chatgpt/3")), { view: "latest", path: "/tag/chatgpt/3.json", tagSlug: "chatgpt", tagId: 3 });
  assert.deepEqual(plain(feedRoute("/top/weekly")), { view: "top", path: "/top.json?period=weekly" });
  assert.equal(feedRoute("/").path, "/latest.json");
});

test("default discussion detail route preserves slug, topic and floor", () => {
  const { topicRoute } = navigationFixture();
  assert.deepEqual([...topicRoute("/t/topic/123/2")].slice(1), ["topic", "123", "2"]);
  assert.equal(topicRoute("/t/123")[2], "123");
  for (const path of ["/", "/login", "/t/new", "/t/foo/123/2/extra"]) assert.equal(topicRoute(path), null);
});

test("manifest and archive contain navigation and tree, no reading tracker or MAIN bridge", () => {
  const manifest = JSON.parse(source("manifest.json"));
  assert.equal(manifest.content_scripts.length, 1);
  assert.deepEqual(manifest.content_scripts[0].js, ["forum.js", "navigation.js", "discussions.js", "scrolling.js", "reader.js"]);
  const packageSource = source("scripts/package.py");
  for (const name of [...manifest.content_scripts[0].js, "LICENSE", "NOTICE", "README.md", "PRIVACY.md"]) {
    assert.ok(packageSource.includes(JSON.stringify(name)), `${name} must accompany release files`);
  }
  assert.doesNotMatch(packageSource, /"reading\.js"|"bridge\.js"/);
  assert.match(source("LICENSE"), /Apache License[\s\S]*Version 2\.0/);
  assert.match(source("NOTICE"), /Copyright 2026 Mipawn/);
});

test("reader has no tracking, timings, visits or local optimistic read writes", () => {
  assert.doesNotMatch(source("reader.js"), /LDReading|Tracker|tracker\.|sampleReading|reading-sync|linux-do-reader-sync|markRead/);
  assert.doesNotMatch(source("forum.js"), /recordReading|visitTopic|topics\/timings|track_visit=true|Discourse-Track-View/);
});

test("normal topic titles open the tree directly while keeping native modifier clicks", () => {
  const reader = source("reader.js");
  assert.match(reader, /const summary = anchor\("", forum\.topicPath\(topic, topic\.hit\?\.post_number\), "topic-select"\)/);
  assert.match(reader, /summary\.removeAttribute\("target"\)/);
  assert.match(reader, /summary\.dataset\.action = "topic"/);
  assert.match(reader, /event\.preventDefault\(\)/);
  assert.match(reader, /if \(row\) selectTopic\(row, true, row\.hit\?\.post_number\)/);
  assert.match(reader, /event\.ctrlKey \|\| event\.metaKey/);
  assert.doesNotMatch(reader, /topic-tree-button/);
  assert.match(reader, /const marker = topic\.unseen \? element\("span", "unseen-dot"\) : null/);
  assert.doesNotMatch(source("reader.css"), /unseen-dot\.faint|pinned-dot|reading-sync/);
  assert.ok(reader.includes('getSentinel: () => $("#list-sentinel")'));
  assert.ok(reader.includes('getSentinel: () => $("#reply-section .reply-footer")'));
});

function readerFixture(feed) {
  const calls = [];
  const forum = { feedPath: () => "/latest.json", feed: async (...args) => { calls.push(args); return feed(...args); } };
  const context = vm.createContext({ URL, URLSearchParams, Intl, AbortController, performance: { now: () => 0 },
    document: { readyState: "loading", addEventListener() {} }, LDForum: forum, LDNavigation: navigationFixture() });
  const script = source("reader.js").replace("  const requestedAtStart = requestedURL();", `
    root = { querySelector: () => ({ scrollTop: 0 }) };
    renderList = renderFilters = () => {};
    clearTopic = () => { state.selected = null; state.detail = null; };
    globalThis.testReader = { state, loadList };
    const requestedAtStart = false;
  `);
  vm.runInContext(script, context);
  return { ...context.testReader, calls };
}

test("initial list load does not automatically fetch any topic detail", async () => {
  const f = readerFixture(() => ({ rows: [{ id: 1, title: "one" }], tags: [], next: "/latest.json?page=1" }));
  assert.deepEqual(plain(await f.loadList()), { progress: true });
  assert.equal(f.state.rows.length, 1);
  assert.equal(f.state.selected, null);
  assert.equal(f.state.detail, null);
  assert.equal(f.calls.length, 1);
});

test("failed appended list page rejects, keeps rows and cursor, and exposes retry deadline", async () => {
  const failure = Object.assign(new Error("rate limited"), { retryAt: Date.now() + 10000, retryAfter: 10000 });
  let count = 0;
  const f = readerFixture(() => { if (++count > 1) throw failure; return { rows: [{ id: 1 }], tags: [], next: "/next.json" }; });
  await f.loadList();
  await assert.rejects(f.loadList(true), error => error === failure);
  assert.equal(f.state.rows.length, 1);
  assert.equal(f.state.next, "/next.json");
  assert.equal(f.state.listError, "rate limited");
  assert.equal(f.state.listRetryAt, failure.retryAt);
  assert.equal(f.state.listBusy, false);
  await f.loadList(true);
  assert.equal(f.calls.length, 2, "manual/automatic calls do not bypass retry deadline");
});

test("duplicate list pages report no progress but retain the cursor for safety pause/recovery", async () => {
  const f = readerFixture(() => ({ rows: [{ id: 1 }], tags: [], next: "/latest.json" }));
  await f.loadList();
  assert.deepEqual(plain(await f.loadList(true)), { progress: false });
  assert.equal(f.state.rows.length, 1);
  assert.equal(f.state.next, "/latest.json");
});
