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
  emit(type) { for (const handler of [...this.listeners.get(type) || []]) handler(); }
  count(type) { return this.listeners.get(type)?.size || 0; }
}

function fixture() {
  const window = new Events(), document = new Events(), frames = new Map();
  let nextFrame = 0;
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
  const make = ({ load, key = "next-1", threshold = 300 } = {}) => {
    const state = { key, enabled: true }, viewport = new Events(), calls = [];
    Object.assign(viewport, {
      ownerDocument: document, hidden: false, isConnected: true,
      clientWidth: 600, clientHeight: 400, scrollHeight: 1200, scrollTop: 550,
      style: { display: "block", visibility: "visible", opacity: "1", contentVisibility: "visible" },
      rect: { top: 0, bottom: 400, left: 0, right: 600, width: 600, height: 400 },
      getBoundingClientRect() { return this.rect; }
    });
    const pager = new context.LDScroll.Pager({
      viewport, canLoad: () => state.enabled, getKey: () => state.key,
      load: () => { calls.push(state.key); return load?.(state, viewport); }, threshold
    });
    return { pager, state, viewport, calls };
  };
  return { window, document, frames, context, frame, make };
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


test("an advancing cursor with no visible height growth cannot fetch a whole folded thread", async () => {
  const f = fixture(), page = f.make({ load: state => { state.key += "-next"; } });
  page.viewport.scrollHeight = 200;
  f.frame(); await drain(f);
  assert.equal(page.calls.length, 1);
  for (let i = 0; i < 5; i++) { page.pager.check(); f.window.emit("resize"); f.frame(); await drain(f); }
  assert.equal(page.calls.length, 1);
  page.viewport.emit("wheel"); page.viewport.emit("scroll"); f.frame(); await drain(f);
  assert.equal(page.calls.length, 2, "a later scroll can request another bounded page");
});

test("a short viewport automatically fills at most two growing pages per scroll burst", async () => {
  const f = fixture(), page = f.make({ load: (state, viewport) => {
    state.key += "-next"; viewport.scrollHeight += 10;
  } });
  page.viewport.scrollHeight = 200;
  f.frame(); await drain(f);
  assert.equal(page.calls.length, 2);
  page.pager.check(); f.frame(); await drain(f);
  assert.equal(page.calls.length, 2);
  page.viewport.emit("wheel"); page.viewport.emit("scroll"); f.frame(); await drain(f);
  assert.equal(page.calls.length, 4);
});


test("programmatic anchor scroll events do not renew the two-page budget", async () => {
  const f = fixture(), page = f.make({ load: (state, viewport) => {
    state.key += "-next"; viewport.scrollHeight += 10;
    viewport.emit("scroll");
  } });
  page.viewport.scrollHeight = 200;
  f.frame(); await drain(f);
  assert.equal(page.calls.length, 2);
  for (let i = 0; i < 5; i++) { page.viewport.emit("scroll"); f.frame(); await drain(f); }
  assert.equal(page.calls.length, 2);
});
