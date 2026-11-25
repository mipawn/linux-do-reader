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

test("only the exact homepage pathname can authorize the reader", () => {
  const { readerRoute } = navigationFixture();
  assert.equal(readerRoute("/"), true);
  for (const path of [
    "/t/", "/t/topic/123/2", "/t/123", "/topic", "/topic/", "/topic/123", "/topics/123",
    "/latest", "/latest/", "/new", "/unseen", "/unread", "/hot", "/posted", "/read", "/bookmarks",
    "/top", "/top/weekly", "/top/all/", "/c/4", "/c/develop/4", "/c/resource/cloud-asset/94", "/c/develop/4/latest",
    "/tag/test", "/tag/test/3", "/categories", "/tags", "/u/mipawn", "/u/mipawn/preferences",
    "/login", "/admin", "/new-topic", "/session", "/chat", "/latest/other", "/t/new", "/c/foo/new-topic",
    "//", "/%2F", "/?ld-reader=1", "/#ld-reader", "https://linux.do/", "", null, undefined
  ]) assert.equal(readerRoute(path), false, String(path));
});

test("extension launcher flags never reach a feed request while native filters remain", () => {
  const { feedRoute } = navigationFixture();
  assert.equal(feedRoute("/", "?ld-reader=1&order=created&ld-reader=0").path, "/latest.json?order=created");
});

test("automatic list pages pass background policy instead of enabling transient retries", async () => {
  const f = readerFixture(() => ({ rows: [{ id: 1 }], tags: [], next: "/latest.json?page=1" }));
  await f.loadList(); await f.loadList(true, false, { background: true });
  assert.equal(f.calls[0][2].background, false); assert.equal(f.calls[1][2].background, true);
  assert.match(source("reader.js"), /load: \(\) => loadList\(true, false, \{ background: true \}\)/);
});

test("launcher normalization before first mount avoids Navigation API duplicate list requests", () => {
  const f = readerLifecycleFixture("https://linux.do/?ld-reader=1&order=created#ld-reader");
  f.api.initialize();
  assert.equal(f.calls.list, 1); assert.deepEqual(f.calls.listPaths, ["/latest.json?order=created"]);
  assert.equal(f.href, "https://linux.do/?order=created");
  assert.equal(f.calls.history.length, 1); assert.equal(f.calls.requests, 0);
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

function backgroundFixture({ response = { open: true }, sendError = null } = {}) {
  const messages = [], created = [];
  let click;
  const chrome = {
    action: { onClicked: { addListener(listener) { click = listener; } } },
    tabs: {
      async sendMessage(...args) {
        messages.push(plain(args));
        if (sendError) throw sendError;
        return response;
      },
      async create(details) { created.push(plain(details)); }
    }
  };
  vm.runInContext(source("background.js"), vm.createContext({ URL, chrome }));
  return { click, messages, created };
}

const readerStartURL = "https://linux.do/";

test("extension action opens the current reader only on the HTTPS homepage", async () => {
  for (const url of ["https://linux.do/", "https://linux.do", "https://linux.do/?ld-reader=1", "https://linux.do/?foo=bar#ld-reader"]) {
    const f = backgroundFixture();
    await f.click({ id: 7, url });
    assert.deepEqual(f.messages, [[7, { type: "linux-do-reader:open" }]], url);
    assert.deepEqual(f.created, [], url);
  }
});

test("extension action never messages a non-home forum page and opens a new homepage", async () => {
  for (const path of [
    "/t/", "/t/topic/123/2", "/topic", "/topic/123", "/latest", "/latest?ld-reader=1", "/t/123#ld-reader",
    "/new", "/unread", "/top/weekly", "/c/develop/4", "/tag/test/3", "/categories", "/tags", "/u/mipawn", "/login",
    "//", "/%2F"
  ]) {
    const f = backgroundFixture();
    await f.click({ id: 7, url: `https://linux.do${path}` });
    assert.deepEqual(f.messages, [], path);
    assert.deepEqual(f.created, [{ url: readerStartURL }], path);
  }
});

test("extension action does not trust foreign origins, HTTP or missing URLs", async () => {
  for (const url of [
    "https://example.com/", "https://linux.do.evil.example/", "https://www.linux.do/", "https://linux.do:8443/",
    "http://linux.do/", "chrome://newtab/", "not a url", "", undefined
  ]) {
    const f = backgroundFixture();
    await f.click({ id: 7, url });
    assert.deepEqual(f.messages, [], String(url));
    assert.deepEqual(f.created, [{ url: readerStartURL }], String(url));
  }
});

test("extension action falls back to a new homepage when the home reader cannot open", async () => {
  for (const options of [{ response: null }, { response: { open: false } }, { sendError: new Error("No receiver") }]) {
    const f = backgroundFixture(options);
    await f.click({ id: 7, url: "https://linux.do/" });
    assert.equal(f.messages.length, 1);
    assert.deepEqual(f.created, [{ url: readerStartURL }]);
  }
});

test("extension action opens a new homepage when the tab has no ID", async () => {
  for (const id of [null, undefined]) {
    const f = backgroundFixture();
    await f.click({ id, url: "https://linux.do/" });
    assert.deepEqual(f.messages, []);
    assert.deepEqual(f.created, [{ url: readerStartURL }]);
  }
});

test("manifest and archive contain the strictly scoped native reply/live bridge, not a reading tracker", () => {
  const manifest = JSON.parse(source("manifest.json"));
  assert.equal(manifest.content_scripts.length, 2);
  assert.deepEqual(manifest.content_scripts[0].js, ["forum.js", "navigation.js", "discussions.js", "scrolling.js", "live.js", "image-preview.js", "polls.js", "reader.js"]);
  assert.equal(manifest.content_scripts[0].world, undefined);
  assert.deepEqual(manifest.content_scripts[1].js, ["native.js"]);
  assert.equal(manifest.content_scripts[1].world, "MAIN");
  for (const script of manifest.content_scripts) {
    assert.deepEqual(script.matches, ["https://linux.do/*"]);
    assert.equal(script.run_at, "document_start");
  }
  const packageSource = source("scripts/package.py");
  for (const name of [...manifest.content_scripts.flatMap(script => script.js), "LICENSE", "NOTICE", "README.md", "PRIVACY.md"]) {
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
  assert.match(reader, /if \(row\) selectTopic\(\{ \.\.\.row, readerPath: control\.href \}, true, row\.hit\?\.post_number\)/);
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
    renderList = renderListFooter = renderFilters = () => {};
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

function lifecycleNode(connected = false) {
  const attributes = new Map(), classes = new Set(), properties = new Map();
  const node = {
    parentNode: null, children: [], dataset: {}, hidden: false,
    classList: { add: (...names) => names.forEach(name => classes.add(name)), remove: (...names) => names.forEach(name => classes.delete(name)), contains: name => classes.has(name) },
    style: { setProperty: (name, value) => properties.set(name, value), getPropertyValue: name => properties.get(name) || "" },
    setAttribute: (name, value) => attributes.set(name, String(value)), getAttribute: name => attributes.get(name) ?? null,
    removeAttribute: name => attributes.delete(name), addEventListener() {}, focus() {}, click() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 200, bottom: 0 }),
    append(...children) {
      for (const child of children) {
        if (child && typeof child === "object") { child.remove(); child.parentNode = this; }
        this.children.push(child);
      }
    },
    prepend(child) { child.remove(); child.parentNode = this; this.children.unshift(child); },
    remove() {
      if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
      this.parentNode = null;
      connected = false;
    },
    contains(child) { return this === child || this.children.some(item => item && typeof item === "object" && item.contains(child)); },
    querySelector(selector) {
      const mode = selector.match(/^\[data-mode="([^"]+)"\]$/)?.[1];
      if (!mode) return null;
      for (const child of this.children) {
        if (!child || typeof child !== "object") continue;
        if (child.dataset.mode === mode) return child;
        const match = child.querySelector(selector);
        if (match) return match;
      }
      return null;
    }
  };
  Object.defineProperties(node, {
    isConnected: { get() { return this.parentNode ? this.parentNode.isConnected : connected; } },
    parentElement: { get() { return this.parentNode; } }
  });
  return node;
}

function readerLifecycleFixture(url) {
  const calls = { mount: 0, list: 0, context: 0, requests: 0, history: [], listPaths: [], intervals: 0, aborts: [] };
  const header = lifecycleNode(true), outlet = lifecycleNode(true), host = lifecycleNode(), shell = lifecycleNode(), menu = lifecycleNode();
  const logoSource = lifecycleNode(true);
  const originalMedia = "(prefers-color-scheme: dark)";
  logoSource.setAttribute("media", originalMedia);
  header.querySelector = selector => selector === ".contents" ? header : selector.includes("picture source") ? logoSource : null;
  header.contains = node => node === logoSource || header.children.includes(node);
  host.dataset.theme = "dark";
  host.hidden = true;
  const root = { querySelector: selector => ({ ".shell": shell, "#menu": menu, "#read-scroll": { scrollTop: 0 } })[selector] || lifecycleNode() };
  const document = {
    readyState: "loading", body: lifecycleNode(true), documentElement: { dataset: {} }, addEventListener() {},
    createElement: () => lifecycleNode(), querySelector: selector => selector === ".d-header" ? header : null,
    getElementById: id => id === "main-outlet" ? outlet : null
  };
  let onMessage;
  const entryChanges = new Set();
  const context = vm.createContext({
    URL, URLSearchParams, Intl, AbortController, performance: { now: () => 0 }, location: new URL(url), document,
    history: { state: null, replaceState(state, title, target) { calls.history.push(String(target)); context.location = new URL(target, context.location.href); for (const listener of entryChanges) listener(); } },
    window: { innerHeight: 900, scrollX: 0, scrollY: 0, scrollTo() {}, addEventListener() {}, navigation: { addEventListener(type, listener) { if (type === "currententrychange") entryChanges.add(listener); } } },
    ResizeObserver: class { observe() {} disconnect() {} }, MutationObserver: class { observe() {} disconnect() {} },
    setInterval() { calls.intervals++; return 1; }, setTimeout: () => 1, clearTimeout() {},
    chrome: { runtime: { onMessage: { addListener(listener) { onMessage = listener; } } } },
    LDForum: { request: async () => { calls.requests++; return {}; } }, LDNavigation: navigationFixture(),
    lifecycleFixture: { calls, header, outlet, host, root }
  });
  const injection = "  const requestedAtStart = requestedURL();";
  const script = source("reader.js");
  assert.ok(script.includes(injection), "reader lifecycle fixture injection point must remain available");
  vm.runInContext(script.replace(injection, `
    mount = () => { lifecycleFixture.calls.mount++; host = lifecycleFixture.host; root = lifecycleFixture.root; };
    renderFilters = renderList = renderReading = renderListFooter = () => {};
    resetReplyPager = () => {};
    loadContext = () => { lifecycleFixture.calls.context++; };
    loadList = async () => { lifecycleFixture.calls.list++; lifecycleFixture.calls.listPaths.push(state.initialFeedPath); };
    globalThis.testLifecycle = {
      state, initialize, showReader, requestedURL, openFromURL, syncNativeLayout, applyNativeNavigation,
      get host() { return host; }, get modeSwitch() { return modeSwitch; }, get pendingOpen() { return pendingOpen; },
      setInFlight() {
        state.listBusy = true;
        listRequest = { abort: () => lifecycleFixture.calls.aborts.push("list") };
        topicRequest = { abort: () => lifecycleFixture.calls.aborts.push("topic") };
      }
    };
    ${injection}
  `), context);
  return {
    api: context.testLifecycle, calls, nodes: { document, header, outlet, host, logoSource, originalMedia },
    navigate(target) { context.location = new URL(target, context.location.href); },
    get href() { return context.location.href; },
    message() {
      let response;
      onMessage({ type: "linux-do-reader:open" }, {}, value => { response = plain(value); });
      return response;
    }
  };
}

test("native routes reject all reader lifecycle entrances without DOM, URL or request changes", () => {
  for (const path of ["/t/topic/123/2", "/topic/123", "/latest", "/c/develop/4", "/tag/test/3", "/u/mipawn"]) {
    const url = `https://linux.do${path}?ld-reader=1#ld-reader`;
    const f = readerLifecycleFixture(url);
    f.api.initialize();
    assert.equal(f.api.requestedURL(), false, path);
    assert.equal(f.api.showReader(), false, path);
    f.api.openFromURL();
    assert.deepEqual(f.message(), { open: false }, path);
    assert.equal(f.api.state.onScreen, false, path);
    assert.equal(f.api.modeSwitch.isConnected, false, path);
    assert.equal(f.nodes.host.isConnected, false, path);
    assert.equal(f.nodes.outlet.classList.contains("ld-reader-active"), false, path);
    assert.equal(f.calls.mount + f.calls.list + f.calls.context + f.calls.requests, 0, path);
    assert.equal(f.calls.intervals, 0, path);
    assert.deepEqual(f.calls.history, [], path);
    assert.equal(f.href, url, path);
  }
});

test("a startup reader request cannot mutate a native route reached before DOM readiness", () => {
  const f = readerLifecycleFixture("https://linux.do/?ld-reader=1");
  assert.equal(f.api.requestedURL(), true);
  const url = "https://linux.do/latest?ld-reader=1#ld-reader";
  f.navigate(url);
  f.api.initialize();
  assert.equal(f.api.state.onScreen, false);
  assert.equal(f.calls.mount + f.calls.list + f.calls.context + f.calls.requests, 0);
  assert.deepEqual(f.calls.history, []);
  assert.equal(f.href, url);
  assert.equal(f.api.modeSwitch.isConnected, false);
});

test("homepage initialization enables the reader in-place without opening any topic", () => {
  const url = "https://linux.do/?foo=bar#native";
  const f = readerLifecycleFixture(url);
  f.api.initialize();
  assert.equal(f.api.state.onScreen, true);
  assert.equal(f.api.modeSwitch.isConnected, true);
  assert.equal(f.api.modeSwitch.hidden, false);
  assert.equal(f.nodes.host.isConnected, true);
  assert.equal(f.nodes.outlet.classList.contains("ld-reader-active"), true);
  assert.equal(f.api.state.selected, null);
  assert.equal(f.calls.mount, 1);
  assert.equal(f.calls.list, 1);
  assert.equal(f.calls.context, 1);
  assert.equal(f.calls.requests, 0);
  assert.equal(f.calls.intervals, 0);
  assert.deepEqual(f.calls.history, []);
  assert.equal(f.href, url);
  assert.deepEqual(f.message(), { open: true });
});

test("SPA navigation to any non-home route removes reader UI and restores native styles on the same outlet", () => {
  for (const path of ["/t/topic/123/2", "/topic/123", "/latest", "/c/develop/4", "/tag/test/3", "/u/mipawn"]) {
    const f = readerLifecycleFixture("https://linux.do/");
    f.api.initialize();
    assert.equal(f.nodes.document.documentElement.dataset.ldReaderTheme, "dark");
    assert.equal(f.nodes.logoSource.getAttribute("media"), "all");
    f.api.setInFlight();
    f.api.state.selected = { id: 123 };
    const url = `https://linux.do${path}`;
    f.navigate(url);
    // Keep #main-outlet and the mounted host connected: route changes alone must clean up.
    f.api.syncNativeLayout();
    assert.equal(f.api.state.onScreen, false, path);
    assert.equal(f.api.state.selected, null, path);
    assert.equal(f.api.state.listBusy, false, path);
    assert.equal(f.api.pendingOpen, false, path);
    assert.equal(f.api.modeSwitch.isConnected, false, path);
    assert.equal(f.nodes.host.isConnected, false, path);
    assert.equal(f.nodes.outlet.classList.contains("ld-reader-active"), false, path);
    assert.equal(f.nodes.document.documentElement.dataset.ldReaderTheme, undefined, path);
    assert.equal(f.nodes.logoSource.getAttribute("media"), f.nodes.originalMedia, path);
    assert.ok(f.calls.aborts.includes("list"), path);
    assert.ok(f.calls.aborts.includes("topic"), path);
    f.api.syncNativeLayout();
    assert.deepEqual(f.message(), { open: false }, path);
    assert.equal(f.calls.list, 1, path);
    assert.equal(f.calls.context, 1, path);
    assert.deepEqual(f.calls.history, [], path);
    assert.equal(f.href, url, path);
  }
});
