import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../forum.js", import.meta.url), "utf8");
const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture(respond = () => ({})) {
  let clock = 0, active = 0, peak = 0;
  const calls = [], waits = [], values = new Map();
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  class ClockDate extends Date { static now() { return clock; } }
  const context = vm.createContext({ URL, URLSearchParams, Intl, Date: ClockDate, DOMException, AbortController, setTimeout, clearTimeout,
    localStorage: storage, fetch: async (url, options) => {
      calls.push({ url, options, time: clock }); active++; peak = Math.max(peak, active);
      try {
        const result = await respond(url, options, calls.length);
        const { status = 200, payload = {}, retryAfter } = result;
        return { ok: status >= 200 && status < 300, status,
          headers: { get: name => name === "Retry-After" ? retryAfter : null },
          json: async () => payload };
      } finally { active--; }
    }
  });
  vm.runInContext(source, context);
  const forum = context.LDForum;
  forum.requestQueue.wait = async ms => { waits.push(ms); clock += ms; };
  return { forum, calls, waits, storage, peak: () => peak, now: () => clock };
}

test("content, posts and background requests share one paced lane", async () => {
  const f = fixture();
  await Promise.all([
    f.forum.request("/latest.json"), f.forum.request("/t/1/posts.json"),
    f.forum.request("/topics/timings", { method: "POST", background: true, priority: 2 })
  ]);
  assert.equal(f.peak(), 1);
  assert.deepEqual(f.calls.map(call => call.time), [0, 1100, 2200]);
});

test("newly clicked content overtakes queued metadata and timings", async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const f = fixture(async url => { if (url === "/first.json") await blocked; return {}; });
  const first = f.forum.request("/first.json");
  const background = f.forum.request("/topics/timings", { method: "POST", priority: 2, background: true });
  const metadata = f.forum.request("/site.json", { priority: 1 });
  const clicked = f.forum.request("/t/2.json");
  release(); await Promise.all([first, background, metadata, clicked]);
  assert.deepEqual(f.calls.map(call => call.url), ["/first.json", "/t/2.json", "/site.json", "/topics/timings"]);
});

test("429 pauses both panes and retries a content GET only once after Retry-After", async () => {
  const f = fixture((url, options, count) => count === 1
    ? { status: 429, retryAfter: "45", payload: { errors: ["操作繁忙"] } } : {});
  await Promise.all([f.forum.request("/latest.json"), f.forum.request("/t/1/posts.json")]);
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[1].time, 45000);
  assert.equal(f.calls[2].time, 46100);
  assert.equal(f.calls.filter(call => call.url === "/latest.json").length, 2);
  assert.equal(f.storage.getItem("linux-do-reader-retry-at"), "45000");
});

test("repeated 429 stops after one recovery attempt instead of looping", async () => {
  const f = fixture(() => ({ status: 429 }));
  await assert.rejects(f.forum.request("/latest.json"), error => error.status === 429);
  assert.deepEqual(f.calls.map(call => call.time), [0, 30000]);
});

test("server JSON rate_limit and wait_seconds are honored even with HTTP 200", async () => {
  const f = fixture((url, options, count) => count === 1
    ? { payload: { error_type: "rate_limit", extras: { wait_seconds: 80 }, errors: ["busy"] } } : {});
  await f.forum.request("/latest.json");
  assert.equal(f.calls[1].time, 80000);
});

test("HTTP-date Retry-After is honored and combined with the longer JSON deadline", async () => {
  const f = fixture((url, options, count) => count === 1
    ? { status: 429, retryAfter: new Date(60000).toUTCString(), payload: { wait_seconds: 90 } } : {});
  await f.forum.request("/latest.json");
  assert.equal(f.calls[1].time, 90000);
});

test("503 uses the shared cooldown and bounded content recovery too", async () => {
  const f = fixture((url, options, count) => count === 1 ? { status: 503 } : {});
  await f.forum.request("/t/1.json");
  assert.deepEqual(f.calls.map(call => call.time), [0, 30000]);
});

test("writes and view registration are never automatically replayed", async () => {
  for (const view of [false, true]) {
    const f = fixture(() => ({ status: 429, retryAfter: "120" }));
    const request = view ? f.forum.visitTopic(1) : f.forum.request("/topics/timings", { method: "POST" });
    await assert.rejects(request, error => error.status === 429 && error.retryAfter === 120000);
    assert.equal(f.calls.length, 1);
  }
});

test("paused reading does not fetch CSRF or enqueue another timing batch", async () => {
  const f = fixture();
  f.forum.requestQueue.defer(90000);
  await assert.rejects(f.forum.recordReading({ topic_id: 1, topic_time: 1000, timings: { 1: 1000 } }), error => error.status === 429);
  assert.equal(f.calls.length, 0);
});

test("queued background work is discarded when another request discovers 429", async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const f = fixture(async (url, options, count) => {
    if (count === 1) { await blocked; return { status: 429 }; }
    return {};
  });
  const content = f.forum.request("/latest.json");
  const background = assert.rejects(f.forum.request("/topics/timings", { method: "POST", background: true, priority: 2 }), error => error.status === 429);
  release(); await Promise.all([content, background]);
  assert.deepEqual(f.calls.map(call => call.url), ["/latest.json", "/latest.json"]);
});

test("switching a topic cancels its queued request without making a fetch", async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const f = fixture(async () => { await blocked; return {}; });
  const first = f.forum.request("/first.json");
  const controller = new AbortController();
  const obsolete = f.forum.request("/t/obsolete.json", { signal: controller.signal });
  const rejected = assert.rejects(obsolete, error => error.name === "AbortError");
  controller.abort(); await rejected;
  release(); await first; await settle();
  assert.equal(f.calls.length, 1);
});

test("tabs share only the cooldown deadline and never shorten it", () => {
  const f = fixture();
  const other = new f.forum.RequestQueue({ now: f.now, storage: f.storage });
  f.forum.requestQueue.defer(90000);
  assert.equal(other.cooldown(), 90000);
  other.defer(30000);
  assert.equal(f.forum.requestQueue.cooldown(), 90000);
  assert.equal(f.storage.getItem("linux-do-reader-retry-at"), "90000");
});

test("error-shaped HTTP 200 writes do not count as accepted reading", async () => {
  const f = fixture(() => ({ payload: { errors: ["操作繁忙"] } }));
  await assert.rejects(f.forum.request("/topics/timings", { method: "POST" }), /操作繁忙/);
  assert.equal(f.calls.length, 1);
});

test("204 remains a valid empty response", async () => {
  const f = fixture(() => ({ status: 204 }));
  assert.deepEqual(JSON.parse(JSON.stringify(await f.forum.request("/bookmarks/1.json", { method: "DELETE" }))), {});
});


test("a hung request times out, aborts transport and releases the single lane", async () => {
  let firstSignal;
  const f = fixture((url, options, count) => {
    if (count === 1) { firstSignal = options.signal; return new Promise(() => {}); }
    return {};
  });
  f.forum.requestQueue.timeout = 5;
  const first = assert.rejects(f.forum.request("/site.json"), error => error.name === "TimeoutError");
  const clicked = f.forum.request("/t/1.json");
  await Promise.all([first, clicked]);
  assert.equal(firstSignal.aborted, true);
  assert.equal(f.calls.length, 2);
});


test("HTTP 200 HTML, null JSON and unparseable writes are failures, not accepted reading", async () => {
  for (const payload of [null, "<html>login</html>"]) {
    const f = fixture(() => ({ payload }));
    await assert.rejects(f.forum.recordReading({ topic_id: 1, topic_time: 1000, timings: { 1: 1000 } }), /无法识别/);
    assert.equal(f.calls.length, 1);
  }
});
