import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../scrolling.js", import.meta.url), "utf8");
const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

class Events {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }
  removeEventListener(type, handler) { this.listeners.get(type)?.delete(handler); }
  emit(type, event = {}) { for (const handler of [...this.listeners.get(type) || []]) handler(event); }
  count(type) { return this.listeners.get(type)?.size || 0; }
}

function fixture({ observers = false, failObserver = false } = {}) {
  const window = new Events(), document = new Events(), frames = new Map();
  const intersections = [], mutations = [], resizes = [];
  let nextFrame = 0, clock = 0;
  if (observers) {
    window.IntersectionObserver = class {
      constructor(callback, options) {
        if (failObserver) throw new Error("unsupported");
        Object.assign(this, { callback, options, nodes: new Set(), removed: [], disconnected: false });
        intersections.push(this);
      }
      observe(node) { this.nodes.add(node); }
      unobserve(node) { this.nodes.delete(node); this.removed.push(node); }
      disconnect() { this.nodes.clear(); this.disconnected = true; }
      emit(target, isIntersecting = true) { this.callback([{ target, isIntersecting }]); }
    };
    const observerClass = list => class {
      constructor(callback) { Object.assign(this, { callback, nodes: new Set(), disconnected: false }); list.push(this); }
      observe(node) { this.nodes.add(node); }
      unobserve(node) { this.nodes.delete(node); }
      disconnect() { this.nodes.clear(); this.disconnected = true; }
      emit() { this.callback([]); }
    };
    window.MutationObserver = observerClass(mutations);
    window.ResizeObserver = observerClass(resizes);
  }
  Object.assign(window, {
    document, innerWidth: 1200, innerHeight: 800,
    getComputedStyle: node => node.style,
    requestAnimationFrame: callback => { const id = nextFrame++; frames.set(id, callback); return id; },
    cancelAnimationFrame: id => frames.delete(id)
  });
  Object.assign(document, { defaultView: window, hidden: false });
  const context = vm.createContext({ window });
  vm.runInContext(source, context);
  const frame = () => {
    const current = [...frames];
    for (const [id, callback] of current) { frames.delete(id); callback(); }
  };
  const make = ({ load, key = "next-1", threshold = 300, noProgressLimit = 3, getSentinel, onStateChange } = {}) => {
    const state = { key, enabled: true }, viewport = new Events(), calls = [], states = [];
    Object.assign(viewport, {
      ownerDocument: document, hidden: false, isConnected: true,
      clientWidth: 600, clientHeight: 400, scrollHeight: 1200, scrollTop: 550,
      style: { display: "block", visibility: "visible", opacity: "1", contentVisibility: "visible" },
      rect: { top: 0, bottom: 400, left: 0, right: 600, width: 600, height: 400 },
      getBoundingClientRect() { return this.rect; }
    });
    const pager = new context.LDScroll.Pager({
      viewport, canLoad: () => state.enabled, getKey: () => state.key,
      load: () => { calls.push(state.key); return load?.(state, viewport); }, threshold, noProgressLimit, getSentinel,
      now: () => clock, onStateChange: value => { states.push(value); onStateChange?.(value); }
    });
    return { pager, state, viewport, calls, states };
  };
  return { window, document, frames, context, frame, make, intersections, mutations, resizes, advance: ms => { clock += ms; } };
}

async function drain(f, limit = 10) {
  for (let i = 0; i < limit; i++) {
    await settle();
    if (!f.frames.size) return;
    f.frame();
  }
  assert.fail("automatic checks did not become idle");
}

test("near-bottom events and explicit checks coalesce into one RAF load", async () => {
  const f = fixture(), page = f.make();
  page.pager.check(); page.pager.check(); page.viewport.emit("scroll"); f.window.emit("resize");
  assert.equal(f.frames.size, 1);
  assert.equal(page.calls.length, 0);
  f.frame(); await drain(f);
  assert.deepEqual(page.calls, ["next-1"]);
});

test("far from bottom does not load until a scroll enters the threshold", async () => {
  const f = fixture(), page = f.make();
  page.viewport.scrollTop = 0;
  f.frame(); await settle();
  assert.equal(page.calls.length, 0);
  page.viewport.scrollTop = 500; // Exactly 300px from the end.
  page.viewport.emit("scroll"); f.frame(); await drain(f);
  assert.equal(page.calls.length, 1);
});

test("in-flight loading blocks concurrent loads even when the cursor changes", async () => {
  const f = fixture(), pending = deferred();
  const page = f.make({ load: (state, viewport) => {
    viewport.scrollHeight += 10;
    if (state.key === "next-1") return pending.promise;
    state.enabled = false;
  } });
  f.frame(); page.state.key = "next-2";
  page.viewport.emit("scroll"); f.window.emit("resize"); f.frame();
  assert.deepEqual(page.calls, ["next-1"]);
  pending.resolve(); await drain(f);
  assert.deepEqual(page.calls, ["next-1", "next-2"]);
});

test("changed cursors fill a short viewport until no next page remains", async () => {
  const f = fixture();
  const page = f.make({ load: (state, viewport) => {
    viewport.scrollHeight += 50;
    state.key = state.key === "next-1" ? "next-2" : "next-3";
    if (state.key === "next-3") state.enabled = false;
  } });
  page.viewport.scrollHeight = 200;
  f.frame(); await drain(f);
  assert.deepEqual(page.calls, ["next-1", "next-2"]);
});

test("new content that moves the bottom away stops the automatic fill", async () => {
  const f = fixture();
  const page = f.make({ load: (state, viewport) => {
    state.key = "next-2";
    viewport.scrollHeight += 1000;
  } });
  f.frame(); await drain(f);
  assert.deepEqual(page.calls, ["next-1"]);
});

test("a successful no-progress response never retries the same cursor", async () => {
  const f = fixture(), page = f.make({ load: () => ({ success: true }) });
  f.frame(); await drain(f);
  for (let i = 0; i < 4; i++) {
    page.viewport.emit("scroll"); page.pager.check(); f.frame(); await drain(f);
  }
  assert.deepEqual(page.calls, ["next-1"]);
});

test("a cursor cycle cannot start an infinite loading loop", async () => {
  const f = fixture(), page = f.make({ load: state => {
    state.key = state.key === "next-1" ? "next-2" : "next-1";
    page.viewport.scrollHeight += 10;
  } });
  f.frame(); await drain(f);
  assert.deepEqual(page.calls, ["next-1", "next-2"]);
});

test("a rejected page stays stopped under subsequent scroll and resize events", async () => {
  const f = fixture(), page = f.make({ load: async () => { throw new Error("offline"); } });
  f.frame(); await settle();
  assert.equal(f.frames.size, 0);
  for (let i = 0; i < 3; i++) {
    page.viewport.emit("scroll"); f.window.emit("resize"); f.frame(); await settle();
  }
  assert.deepEqual(page.calls, ["next-1"]);
  // An external manual load may advance the cursor, allowing the next page.
  page.state.key = "next-2"; page.pager.check(); f.frame(); await settle();
  assert.deepEqual(page.calls, ["next-1", "next-2"]);
});

test("synchronous loading failures are caught and do not retry", async () => {
  const f = fixture(), page = f.make({ load: () => { throw new Error("bad page"); } });
  assert.doesNotThrow(() => f.frame());
  page.pager.check(); f.frame(); await settle();
  assert.equal(page.calls.length, 1);
});

test("canLoad dynamically gates missing pages, business errors, and external busy state", async () => {
  const f = fixture(), page = f.make();
  page.state.enabled = false; f.frame();
  assert.equal(page.calls.length, 0);
  page.state.enabled = true; page.pager.check(); f.frame(); await drain(f);
  assert.equal(page.calls.length, 1);
});

test("hidden, zero-sized, disconnected, and offscreen containers do not load", async () => {
  const cases = [
    [f => { f.document.hidden = true; }, f => { f.document.hidden = false; }],
    [(_, p) => { p.viewport.hidden = true; }, (_, p) => { p.viewport.hidden = false; }],
    [(_, p) => { p.viewport.clientHeight = 0; }, (_, p) => { p.viewport.clientHeight = 400; }],
    [(_, p) => { p.viewport.clientWidth = 0; }, (_, p) => { p.viewport.clientWidth = 600; }],
    [(_, p) => { p.viewport.rect.height = 0; }, (_, p) => { p.viewport.rect.height = 400; }],
    [(_, p) => { p.viewport.style.visibility = "hidden"; }, (_, p) => { p.viewport.style.visibility = "visible"; }],
    [(_, p) => { p.viewport.style.opacity = "0"; }, (_, p) => { p.viewport.style.opacity = "1"; }],
    [(_, p) => { p.viewport.style.contentVisibility = "hidden"; }, (_, p) => { p.viewport.style.contentVisibility = "visible"; }],
    [(_, p) => { p.viewport.isConnected = false; }, (_, p) => { p.viewport.isConnected = true; }],
    [(_, p) => { p.viewport.rect.top = 900; }, (_, p) => { p.viewport.rect.top = 0; }]
  ];
  for (const [hide, reveal] of cases) {
    const f = fixture(), page = f.make(); hide(f, page); f.frame();
    assert.equal(page.calls.length, 0);
    reveal(f, page); f.document.emit("visibilitychange"); f.frame(); await drain(f);
    assert.equal(page.calls.length, 1);
  }
});

test("destroy cancels frame zero and unsubscribes all event listeners", async () => {
  const f = fixture(), page = f.make();
  assert.equal(f.frames.has(0), true);
  page.pager.destroy(); page.pager.destroy();
  assert.equal(f.frames.size, 0);
  assert.equal(page.viewport.count("scroll"), 0);
  assert.equal(f.window.count("resize"), 0);
  assert.equal(f.document.count("visibilitychange"), 0);
  page.viewport.emit("scroll"); f.window.emit("resize"); page.pager.check(); page.pager.reset();
  f.frame(); await settle();
  assert.equal(page.calls.length, 0);
});

test("destroy ignores a late successful promise without scheduling another page", async () => {
  const f = fixture(), pending = deferred(), page = f.make({ load: () => pending.promise });
  f.frame(); page.pager.destroy(); page.state.key = "next-2";
  pending.resolve(); await settle();
  assert.equal(f.frames.size, 0);
  assert.deepEqual(page.calls, ["next-1"]);
});

test("two viewport instances load independently and removing one preserves the other", async () => {
  const f = fixture(), pendingA = deferred(), pendingB = deferred();
  const a = f.make({ key: "a-1", load: (state, viewport) => {
    viewport.scrollHeight += 10;
    if (state.key === "a-1") return pendingA.promise;
    state.enabled = false;
  } });
  const b = f.make({ key: "b-1", load: (state, viewport) => {
    viewport.scrollHeight += 10;
    if (state.key === "b-1") return pendingB.promise;
    state.enabled = false;
  } });
  f.frame(); assert.deepEqual(a.calls, ["a-1"]); assert.deepEqual(b.calls, ["b-1"]);
  a.state.key = "a-2"; pendingA.resolve(); await drain(f);
  assert.deepEqual(a.calls, ["a-1", "a-2"]); assert.deepEqual(b.calls, ["b-1"]);
  a.pager.destroy(); assert.equal(f.window.count("resize"), 1);
  b.state.key = "b-2"; pendingB.resolve(); await drain(f);
  assert.deepEqual(b.calls, ["b-1", "b-2"]);
});

test("reset explicitly retries a failed cursor once", async () => {
  const f = fixture(); let failed = true;
  const page = f.make({ load: state => {
    if (failed) throw new Error("offline");
    state.enabled = false;
  } });
  f.frame(); await settle(); failed = false;
  page.pager.reset(); f.frame(); await drain(f);
  assert.deepEqual(page.calls, ["next-1", "next-1"]);
});

test("reset during a topic change waits for the old promise and retains its attempted cursor", async () => {
  const f = fixture(), pending = deferred();
  const page = f.make({ key: "topic-a:1", load: state => {
    if (state.key === "topic-a:1") return pending.promise;
    state.enabled = false;
  } });
  f.frame(); page.state.key = "topic-b:1"; page.pager.reset(); f.frame();
  assert.deepEqual(page.calls, ["topic-a:1"]);
  pending.resolve(); await drain(f);
  assert.deepEqual(page.calls, ["topic-a:1", "topic-b:1"]);
  page.state.key = "topic-a:1"; page.state.enabled = true; page.pager.check(); f.frame();
  assert.deepEqual(page.calls, ["topic-a:1", "topic-b:1"]);
});

test("reset cannot duplicate an in-flight unchanged cursor", async () => {
  const f = fixture(), pending = deferred(), page = f.make({ load: () => pending.promise });
  f.frame(); page.pager.reset(); f.frame(); pending.resolve(); await drain(f);
  assert.deepEqual(page.calls, ["next-1"]);
});

test("empty and unstable cursor keys are skipped; zero is a valid offset", async () => {
  for (const key of [null, undefined, "", {}, () => {}, NaN, Infinity]) {
    const f = fixture(), page = f.make(); page.state.key = key; f.frame(); await settle();
    assert.equal(page.calls.length, 0);
  }
  const f = fixture(), page = f.make({ key: 0 }); f.frame(); await drain(f);
  assert.deepEqual(page.calls, [0]);
});

test("refresh generation can reuse the next-page cursor after the old request aborts", async () => {
  const f = fixture(), pending = deferred();
  const page = f.make({ key: "generation-0:page-1", load: state => {
    if (state.key === "generation-0:page-1") return pending.promise;
    state.enabled = false;
  } });
  f.frame();
  page.state.key = "generation-1:page-1"; page.pager.reset(); f.frame();
  assert.deepEqual(page.calls, ["generation-0:page-1"]);
  pending.reject(new Error("AbortError")); await drain(f);
  assert.deepEqual(page.calls, ["generation-0:page-1", "generation-1:page-1"]);
});


test("advancing cursors without height growth use a finite visible budget and manual recovery", async () => {
  const f = fixture(), page = f.make({ load: state => { state.key += "-next"; } });
  page.viewport.scrollHeight = 200;
  f.frame(); await drain(f);
  assert.equal(page.calls.length, 3);
  assert.equal(page.pager.state.status, "paused");
  assert.equal(page.pager.state.reason, "no-progress");
  for (let i = 0; i < 5; i++) { page.pager.check(); f.window.emit("resize"); page.viewport.emit("wheel"); f.frame(); await drain(f); }
  assert.equal(page.calls.length, 3, "incidental input cannot reset the safety budget");
  assert.equal(page.pager.resume(), true);
  f.frame(); await drain(f);
  assert.equal(page.calls.length, 6);
});

test("a short viewport fills healthy pages beyond two until the actual next page ends", async () => {
  let number = 1;
  const f = fixture(), page = f.make({ load: (state, viewport) => {
    state.key = `next-${++number}`; viewport.scrollHeight += 10;
    if (number > 12) state.enabled = false;
    return { progress: true };
  } });
  page.viewport.scrollHeight = 200;
  f.frame(); await drain(f, 20);
  assert.equal(page.calls.length, 12);
  assert.equal(page.pager.paused, false);
  assert.equal(page.pager.state.status, "exhausted");
});

test("programmatic anchor scroll events cannot renew the no-progress budget", async () => {
  const f = fixture(), page = f.make({ load: (state, viewport) => {
    state.key += "-next"; viewport.emit("scroll");
  } });
  page.viewport.scrollHeight = 200;
  f.frame(); await drain(f);
  assert.equal(page.calls.length, 3);
  for (let i = 0; i < 5; i++) { page.viewport.emit("scroll"); f.frame(); await drain(f); }
  assert.equal(page.calls.length, 3);
});

const sentinel = (top = 600) => ({
  isConnected: true, rect: { top, bottom: top + 1, left: 0, right: 600, width: 600, height: 1 },
  getBoundingClientRect() { return this.rect; }
});

test("IntersectionObserver uses the viewport root and sentinel root margin", async () => {
  const f = fixture({ observers: true }), node = sentinel();
  const page = f.make({ getSentinel: () => node });
  f.frame();
  const observer = f.intersections[0];
  assert.equal(observer.options.root, page.viewport);
  assert.equal(observer.options.rootMargin, "300px 0px");
  assert.equal(observer.options.threshold, 0);
  assert.equal(observer.nodes.has(node), true);
  assert.equal(page.calls.length, 0);
  observer.emit(node); observer.emit(node); f.frame(); await drain(f);
  assert.deepEqual(page.calls, ["next-1"]);
  assert.equal(page.pager.state.reason, "duplicate-cursor");
});

test("IO enters and exits gate loading, and far-away current geometry defeats stale intersecting state", async () => {
  const f = fixture({ observers: true }), node = sentinel(800);
  const page = f.make({ getSentinel: () => node, load: (state, viewport) => {
    state.key = "next-2"; viewport.scrollHeight += 1000; node.rect.top = 2000; node.rect.bottom = 2001;
  } });
  f.frame(); const observer = f.intersections[0];
  observer.emit(node, false); f.frame(); assert.equal(page.calls.length, 0);
  observer.emit(node, true); f.frame(); assert.equal(page.calls.length, 0, "stale intersection outside margin is ignored");
  node.rect.top = 600; node.rect.bottom = 601;
  observer.emit(node, true); f.frame(); await drain(f);
  assert.equal(page.calls.length, 1, "appended height stops filling even before IO sends an exit");
});

test("DOM replacement automatically unobserves the old sentinel and ignores its late notifications", async () => {
  const f = fixture({ observers: true }), old = sentinel(); let current = old;
  const page = f.make({ getSentinel: () => current });
  f.frame(); const observer = f.intersections[0];
  current = sentinel(); old.isConnected = false;
  f.mutations[0].emit(); f.frame();
  assert.equal(observer.nodes.has(old), false);
  assert.equal(observer.nodes.has(current), true);
  assert.equal(observer.removed.includes(old), true);
  observer.emit(old); f.frame(); assert.equal(page.calls.length, 0);
  observer.emit(current); f.frame(); await drain(f);
  assert.equal(page.calls.length, 1);
});

test("an explicit render check rebinds a replaced sentinel without MutationObserver", async () => {
  const f = fixture({ observers: true }), old = sentinel(); let current = old;
  f.window.MutationObserver = undefined;
  const page = f.make({ getSentinel: () => current });
  f.frame(); current = sentinel(); page.pager.check(); f.frame();
  assert.equal(f.intersections[0].nodes.has(current), true);
  assert.equal(f.intersections[0].nodes.has(old), false);
});

test("scroll and sentinel geometry work when IO is absent or its constructor is unsupported", async () => {
  for (const options of [{}, { observers: true, failObserver: true }]) {
    const f = fixture(options), node = sentinel(900), page = f.make({ getSentinel: () => node });
    f.frame(); assert.equal(page.calls.length, 0);
    node.rect.top = 700; node.rect.bottom = 701;
    page.viewport.emit("scroll"); f.frame(); await drain(f);
    assert.equal(page.calls.length, 1, "the sentinel geometry includes the exact threshold boundary");
  }
});

test("missing or detached sentinels fall back to scroll metrics and later rebind", async () => {
  const f = fixture({ observers: true }); let current = null;
  const page = f.make({ getSentinel: () => current });
  page.viewport.scrollTop = 0; f.frame(); assert.equal(page.calls.length, 0);
  current = sentinel(); current.isConnected = false;
  page.pager.check(); f.frame(); assert.equal(page.pager.sentinel, null);
  current.isConnected = true;
  f.mutations[0].emit(); f.frame();
  assert.equal(f.intersections[0].nodes.has(current), true);
  f.intersections[0].emit(current); f.frame(); await drain(f);
  assert.equal(page.calls.length, 1);
});

test("an out-of-root sentinel is ignored rather than observed", async () => {
  const f = fixture({ observers: true }), node = sentinel(), page = f.make({ getSentinel: () => node });
  page.viewport.contains = () => false; page.viewport.scrollTop = 0;
  f.frame(); assert.equal(page.pager.sentinel, null);
  assert.equal(f.intersections[0].nodes.size, 0);
});

test("IO cannot load a hidden pane and a visibility change can recover an intersecting sentinel", async () => {
  const f = fixture({ observers: true }), node = sentinel(), page = f.make({ getSentinel: () => node });
  f.document.hidden = true; f.frame();
  f.intersections[0].emit(node); f.frame(); assert.equal(page.calls.length, 0);
  assert.equal(page.pager.state.status, "hidden");
  f.document.hidden = false; f.document.emit("visibilitychange"); f.frame(); await drain(f);
  assert.equal(page.calls.length, 1);
});

test("IO storms and cursor changes preserve single-flight loading", async () => {
  const f = fixture({ observers: true }), node = sentinel(), pending = deferred();
  const page = f.make({ getSentinel: () => node, load: (state, viewport) => {
    viewport.scrollHeight += 10;
    if (state.key === "next-1") return pending.promise;
    state.enabled = false;
  } });
  f.frame(); f.intersections[0].emit(node); f.frame();
  page.state.key = "next-2";
  for (let i = 0; i < 5; i++) { f.intersections[0].emit(node); page.viewport.emit("scroll"); f.frame(); }
  assert.deepEqual(page.calls, ["next-1"]);
  pending.resolve(); await drain(f);
  assert.deepEqual(page.calls, ["next-1", "next-2"]);
});

test("duplicates remain bounded even if loading placeholders make the DOM taller", async () => {
  const f = fixture(), page = f.make({ noProgressLimit: 2, load: (state, viewport) => {
    state.key += "-next"; viewport.scrollHeight += 10; return { progress: false };
  } });
  f.frame(); await drain(f);
  assert.equal(page.calls.length, 2);
  assert.equal(page.pager.state.status, "paused");
  assert.equal(page.pager.state.reason, "no-progress");
});

test("successful real progress resets a consecutive no-progress budget", async () => {
  let number = 0;
  const f = fixture(), page = f.make({ load: (state, viewport) => {
    number++; state.key += "-next";
    if (number % 3 === 0) viewport.scrollHeight += 10;
    if (number === 8) state.enabled = false;
  } });
  f.frame(); await drain(f);
  assert.equal(page.calls.length, 8);
  assert.equal(page.pager.paused, false);
});

test("cursor cycles are visible and a manual resume gives one bounded new cycle", async () => {
  const f = fixture(), page = f.make({ load: (state, viewport) => {
    state.key = state.key === "next-1" ? "next-2" : "next-1"; viewport.scrollHeight += 10;
  } });
  f.frame(); await drain(f);
  assert.equal(page.pager.state.reason, "duplicate-cursor");
  assert.equal(page.pager.resume(), true); f.frame(); await drain(f);
  assert.deepEqual(page.calls, ["next-1", "next-2", "next-1", "next-2"]);
});

test("errors are visible without permanently blacklisting the cursor; resume can retry", async () => {
  let offline = true;
  const error = new Error("offline");
  const f = fixture(), page = f.make({ load: state => {
    if (offline) throw error;
    state.enabled = false;
  } });
  f.frame(); await settle();
  assert.equal(page.pager.state.status, "error");
  assert.equal(page.pager.state.error, error);
  assert.equal(page.pager.attempted.has("next-1"), false);
  assert.deepEqual(page.states.map(value => value.status), ["loading", "error"]);
  offline = false; page.pager.resume(); f.frame(); await drain(f);
  assert.deepEqual(page.calls, ["next-1", "next-1"]);
});

test("manual error recovery respects Retry-After and reports its remaining time", async () => {
  let fail = true;
  const error = Object.assign(new Error("limited"), { status: 429, retryAfter: 2000, recoverable: true });
  const f = fixture(), page = f.make({ load: state => { if (fail) throw error; state.enabled = false; } });
  f.frame(); await settle();
  assert.equal(page.pager.state.retryAt, 2000);
  assert.equal(page.pager.state.retryAfter, 2000);
  assert.equal(page.pager.resume(), false);
  f.advance(1999); assert.equal(page.pager.resume(), false);
  assert.equal(page.calls.length, 1);
  fail = false; f.advance(1); assert.equal(page.pager.resume(), true);
  f.frame(); await drain(f); assert.equal(page.calls.length, 2);
});

test("absolute server retryAt is preferred over recomputing retryAfter", async () => {
  const error = Object.assign(new Error("limited"), { retryAt: 3000, retryAfter: 9000 });
  const f = fixture(), page = f.make({ load: () => { throw error; } });
  f.advance(1000); f.frame(); await settle();
  assert.equal(page.pager.state.retryAt, 3000);
  assert.equal(page.pager.state.retryAfter, 2000);
});

test("online transient recovery is limited and never bypasses a cooldown", async () => {
  const f = fixture(), error = Object.assign(new Error("offline"), { recoverable: true });
  const page = f.make({ load: () => { throw error; } });
  f.frame(); await settle(); f.window.emit("online"); f.frame(); await settle();
  assert.equal(page.calls.length, 2);
  for (let i = 0; i < 5; i++) { f.window.emit("online"); f.frame(); await settle(); }
  assert.equal(page.calls.length, 2);
  const cooling = f.make({ load: () => { throw Object.assign(new Error("limited"), { recoverable: true, retryAfter: 2000 }); } });
  f.frame(); await settle(); f.window.emit("online"); f.frame(); await settle();
  assert.equal(cooling.calls.length, 1);
});

test("destroy disconnects all observers, online listeners and late callbacks", async () => {
  const f = fixture({ observers: true }), node = sentinel(), page = f.make({ getSentinel: () => node });
  f.frame(); page.pager.destroy();
  assert.equal(f.intersections[0].disconnected, true);
  assert.equal(f.mutations[0].disconnected, true);
  assert.equal(f.resizes[0].disconnected, true);
  assert.equal(f.window.count("online"), 0);
  f.intersections[0].emit(node); f.mutations[0].emit(); f.resizes[0].emit();
  f.frame(); await settle(); assert.equal(page.calls.length, 0);
  assert.equal(page.pager.state.status, "destroyed");
  assert.equal(page.pager.resume(), false);
});

test("state rendering exceptions do not strand a single-flight request", async () => {
  const f = fixture(), page = f.make({ onStateChange: () => { throw new Error("render failed"); },
    load: state => { state.enabled = false; } });
  f.frame(); await drain(f);
  assert.equal(page.calls.length, 1);
  assert.equal(page.pager.pending, null);
  assert.equal(page.pager.state.status, "exhausted");
});

test("invalid safety limits and observer callbacks fail construction explicitly", () => {
  const f = fixture();
  for (const noProgressLimit of [0, -1, 1.5, Infinity]) assert.throws(() => f.make({ noProgressLimit }), /valid callbacks/);
  for (const getSentinel of [false, {}, "node"]) assert.throws(() => f.make({ getSentinel }), /valid callbacks/);
});
