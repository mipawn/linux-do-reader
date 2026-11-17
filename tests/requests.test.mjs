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
        const { status = 200, payload = {}, retryAfter, serverDate, invalidJSON } = await respond(url, options, calls.length);
        return { ok: status >= 200 && status < 300, status,
          headers: { get: name => name === "Retry-After" ? retryAfter : name === "Date" ? serverDate : null },
          json: async () => { if (invalidJSON) throw new SyntaxError("bad JSON"); return payload; } };
      } finally { active--; }
    }
  });
  vm.runInContext(source, context);
  const forum = context.LDForum;
  forum.requestQueue.wait = async ms => { waits.push(ms); clock += ms; };
  return { forum, calls, waits, storage, peak: () => peak, now: () => clock, advance: ms => { clock += ms; } };
}

const limited = ms => error => error.status === 429 && error.retryAfter === ms && error.recoverable;

test("content, posts and background requests share one paced lane", async () => {
  const f = fixture();
  await Promise.all([
    f.forum.request("/latest.json"), f.forum.request("/t/1/posts.json"),
    f.forum.request("/bookmarks.json", { method: "POST", background: true, priority: 2 })
  ]);
  assert.equal(f.peak(), 1);
  assert.deepEqual(f.calls.map(call => call.time), [0, 1100, 2200]);
});

test("newly clicked content overtakes queued metadata and background work", async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const f = fixture(async url => { if (url === "/first.json") await blocked; return {}; });
  const first = f.forum.request("/first.json");
  const background = f.forum.request("/bookmarks.json", { method: "POST", priority: 2, background: true });
  const metadata = f.forum.request("/site.json", { priority: 1 });
  const clicked = f.forum.request("/t/2.json");
  release(); await Promise.all([first, background, metadata, clicked]);
  assert.deepEqual(f.calls.map(call => call.url), ["/first.json", "/t/2.json", "/site.json", "/bookmarks.json"]);
});

test("429 immediately rejects both panes and metadata instead of hiding a cooldown in loading", async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const f = fixture(async () => { await blocked; return { status: 429, retryAfter: "45" }; });
  const requests = ["/latest.json", "/t/1/posts.json", "/site.json", "/bookmarks.json"]
    .map((path, index) => assert.rejects(f.forum.request(path, { priority: index }), limited(45000)));
  release(); await Promise.all(requests);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.waits, []);
  assert.equal(f.forum.requestQueue.pending.length, 0);
  assert.equal(f.forum.requestQueue.running, false);
  assert.equal(f.storage.getItem("linux-do-reader-retry-at"), "45000");
  await assert.rejects(f.forum.request("/new.json"), limited(45000));
  assert.equal(f.calls.length, 1);
});

test("short, fractional and zero server deadlines are not forced to thirty seconds", async () => {
  for (const [header, ms] of [["2", 2000], ["0.25", 250], ["0", 0]]) {
    const f = fixture((url, options, count) => count === 1 ? { status: 429, retryAfter: header } : {});
    await assert.rejects(f.forum.request("/latest.json"), limited(ms));
    assert.equal(f.calls.length, 1, "no implicit replay even with a zero deadline");
    f.advance(ms);
    await f.forum.request("/latest.json");
    assert.equal(f.calls.length, 2, "an explicit action recovers after the real deadline");
  }
});

test("missing or invalid rate limit deadlines use a finite short safety fallback", async () => {
  for (const retryAfter of [undefined, "garbage", "-2", "Infinity"]) {
    const f = fixture(() => ({ status: 429, retryAfter, payload: { wait_seconds: -1 } }));
    await assert.rejects(f.forum.request("/latest.json"), limited(5000));
    assert.deepEqual(f.calls.map(call => call.time), [0]);
    assert.deepEqual(f.waits, []);
  }
});

test("HTTP 200 JSON rate_limit surfaces the actual longer wait_seconds deadline", async () => {
  const f = fixture(() => ({ payload: {
    error_type: "rate_limit", extras: { wait_seconds: 2 }, wait_seconds: 4, errors: ["busy"]
  } }));
  await assert.rejects(f.forum.request("/latest.json"), limited(4000));
  assert.equal(f.calls.length, 1);
});

test("HTTP-date Retry-After combines with the longer JSON deadline", async () => {
  const f = fixture(() => ({ status: 429, retryAfter: new Date(60000).toUTCString(), payload: { wait_seconds: 90 } }));
  await assert.rejects(f.forum.request("/latest.json"), limited(90000));
});

test("HTTP-date uses the server clock when Date is provided", async () => {
  const f = fixture(() => ({ status: 429, retryAfter: new Date(105000).toUTCString(), serverDate: new Date(100000).toUTCString() }));
  await assert.rejects(f.forum.request("/latest.json"), limited(5000));
});

test("past HTTP-date deadline allows explicit retry without extending cooldown", async () => {
  const f = fixture(() => ({ status: 429, retryAfter: new Date(0).toUTCString() }));
  f.advance(10000);
  await assert.rejects(f.forum.request("/latest.json"), limited(0));
});

test("502/503/504 with Retry-After surface cooldown and never silently auto-replay", async () => {
  for (const status of [502, 503, 504]) {
    const f = fixture(() => ({ status, retryAfter: "3" }));
    await assert.rejects(f.forum.request("/t/1.json"), error => error.status === status && error.retryAfter === 3000);
    await assert.rejects(f.forum.request("/site.json"), limited(3000));
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.waits, []);
  }
});

test("a transient GET 502/503/504 gets exactly one short paced recovery", async () => {
  for (const status of [502, 503, 504]) {
    const f = fixture((url, options, count) => count === 1 ? { status } : {});
    await f.forum.request("/t/1.json");
    assert.deepEqual(f.calls.map(call => call.time), [0, 1100]);
    assert.equal(f.forum.requestQueue.cooldown(), 0);
    const failed = fixture(() => ({ status }));
    await assert.rejects(failed.forum.request("/t/1.json"), error => error.status === status && error.recoverable);
    assert.deepEqual(failed.calls.map(call => call.time), [0, 1100]);
  }
});

test("a fetch network transient recovers once and a persistent network error is visible", async () => {
  const f = fixture((url, options, count) => { if (count === 1) throw new TypeError("Failed to fetch"); return {}; });
  await f.forum.request("/latest.json");
  assert.deepEqual(f.calls.map(call => call.time), [0, 1100]);
  const failed = fixture(() => { throw new TypeError("offline"); });
  await assert.rejects(failed.forum.request("/latest.json"), error => error.name === "TypeError" && error.recoverable);
  assert.equal(failed.calls.length, 2);
});

test("writes, lowercase methods and background GETs are never automatically replayed", async () => {
  for (const options of [{ method: "POST" }, { method: "post" }, { method: "PATCH" }, { method: "DELETE" }, { background: true }]) {
    for (const response of [() => ({ status: 503 }), () => ({ status: 429, retryAfter: "120" }), () => { throw new TypeError("offline"); }]) {
      const f = fixture(response);
      await assert.rejects(f.forum.request("/bookmarks.json", options));
      assert.equal(f.calls.length, 1);
    }
  }
});

test("CSRF 403 invalidates the token for the next explicit action, never replays its write", async () => {
  const f = fixture(url => url === "/session/csrf.json" ? { payload: { csrf: "token" } } : { status: 403 });
  await assert.rejects(f.forum.change("/bookmarks.json", "POST", { id: 1 }), error => error.status === 403);
  assert.deepEqual(f.calls.map(call => call.url), ["/session/csrf.json", "/bookmarks.json"]);
  await assert.rejects(f.forum.change("/bookmarks.json", "POST", { id: 1 }), error => error.status === 403);
  assert.deepEqual(f.calls.map(call => call.url), ["/session/csrf.json", "/bookmarks.json", "/session/csrf.json", "/bookmarks.json"]);
});

test("cooling actions reject before fetching CSRF, and reading-sync exports are removed", async () => {
  const f = fixture();
  f.forum.requestQueue.defer(90000);
  await assert.rejects(f.forum.change("/bookmarks.json", "POST", {}), limited(90000));
  assert.equal(f.calls.length, 0);
  assert.equal("visitTopic" in f.forum, false);
  assert.equal("recordReading" in f.forum, false);
});

test("queued background work is discarded together with foreground after 429", async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const f = fixture(async () => { await blocked; return { status: 429 }; });
  const content = assert.rejects(f.forum.request("/latest.json"), limited(5000));
  const background = assert.rejects(f.forum.request("/bookmarks.json", { method: "POST", background: true, priority: 2 }), limited(5000));
  release(); await Promise.all([content, background]);
  assert.deepEqual(f.calls.map(call => call.url), ["/latest.json"]);
});

test("switching a topic cancels its queued request without fetching", async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const f = fixture(async () => { await blocked; return {}; });
  const first = f.forum.request("/first.json");
  const controller = new AbortController();
  const rejected = assert.rejects(f.forum.request("/t/obsolete.json", { signal: controller.signal }), error => error.name === "AbortError");
  controller.abort(); await rejected;
  release(); await first; await settle();
  assert.equal(f.calls.length, 1);
});

test("already-aborted signals reject without entering the lane or fetching", async () => {
  const f = fixture(), controller = new AbortController();
  controller.abort();
  await assert.rejects(f.forum.request("/latest.json", { signal: controller.signal }), error => error.name === "AbortError");
  assert.equal(f.calls.length, 0);
});

test("in-flight abort releases the lane even if the transport ignores cancellation", async () => {
  let firstSignal;
  const f = fixture((url, options, count) => {
    if (count === 1) { firstSignal = options.signal; return new Promise(() => {}); }
    return {};
  });
  const controller = new AbortController();
  const first = assert.rejects(f.forum.request("/first.json", { signal: controller.signal }), error => error.name === "AbortError");
  const clicked = f.forum.request("/t/1.json");
  controller.abort(); await Promise.all([first, clicked]);
  assert.equal(firstSignal.aborted, true);
  assert.equal(f.calls.length, 2);
});

test("tabs share only a cooldown deadline and never shorten it", () => {
  const f = fixture();
  const other = new f.forum.RequestQueue({ now: f.now, storage: f.storage });
  f.forum.requestQueue.defer(90000);
  assert.equal(other.cooldown(), 90000);
  other.defer(30000);
  assert.equal(f.forum.requestQueue.cooldown(), 90000);
  assert.equal(f.storage.getItem("linux-do-reader-retry-at"), "90000");
});

test("another tab's cooldown rejects new foreground requests without waiting", async () => {
  const f = fixture();
  f.storage.setItem("linux-do-reader-retry-at", "2000");
  await assert.rejects(f.forum.request("/site.json"), limited(2000));
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.waits, []);
});

test("cooldown is rechecked after the normal pacing wait", async () => {
  const f = fixture();
  await f.forum.request("/first.json");
  f.forum.requestQueue.wait = async () => f.storage.setItem("linux-do-reader-retry-at", "9000");
  await assert.rejects(f.forum.request("/next.json"), limited(9000));
  assert.equal(f.calls.length, 1);
});

test("malformed storage and invalid defer durations do not create infinite cooldowns", async () => {
  const f = fixture();
  f.storage.setItem("linux-do-reader-retry-at", "Infinity");
  for (const duration of [Infinity, NaN, -1]) f.forum.requestQueue.defer(duration);
  assert.equal(f.forum.requestQueue.cooldown(), 0);
  await f.forum.request("/site.json");
});

test("storage access failure does not break the request queue", async () => {
  const f = fixture();
  f.forum.requestQueue.storage = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } };
  f.forum.requestQueue.defer(2000);
  await assert.rejects(f.forum.request("/site.json"), limited(2000));
  f.advance(2000); await f.forum.request("/site.json");
});

test("non-transient errors and error-shaped HTTP 200 are not implicitly retried", async () => {
  for (const response of [{ status: 401 }, { status: 403 }, { status: 404 }, { status: 500 }, { payload: { errors: ["busy"] } }]) {
    const f = fixture(() => response);
    await assert.rejects(f.forum.request("/latest.json"));
    assert.equal(f.calls.length, 1);
  }
});

test("204 remains a valid empty response", async () => {
  const f = fixture(() => ({ status: 204 }));
  assert.deepEqual(JSON.parse(JSON.stringify(await f.forum.request("/bookmarks/1.json", { method: "DELETE" }))), {});
});

test("a hung request times out, aborts transport and releases the lane without a hidden second timeout", async () => {
  let firstSignal;
  const f = fixture((url, options, count) => {
    if (count === 1) { firstSignal = options.signal; return new Promise(() => {}); }
    return {};
  });
  f.forum.requestQueue.timeout = 5;
  const first = assert.rejects(f.forum.request("/site.json"), error => error.name === "TimeoutError" && error.recoverable);
  const clicked = f.forum.request("/t/1.json");
  await Promise.all([first, clicked]);
  assert.equal(firstSignal.aborted, true);
  assert.equal(f.calls.length, 2);
});

test("HTTP 200 HTML, null, array and unparseable JSON writes are visible failures", async () => {
  for (const result of [{ payload: null }, { payload: "<html>login</html>" }, { payload: [] }, { invalidJSON: true }]) {
    const f = fixture(() => result);
    await assert.rejects(f.forum.request("/bookmarks.json", { method: "POST" }), /无法识别/);
    assert.equal(f.calls.length, 1);
  }
});

test("cross-origin, credentials and unsafe paths cannot enter the request queue", async () => {
  const f = fixture();
  for (const path of ["https://evil.example/latest.json", "javascript:alert(1)", "https://user:pass@linux.do/latest.json"]) {
    await assert.rejects(f.forum.request(path), /无效/);
  }
  assert.equal(f.calls.length, 0);
});

test("malformed reply pagination is a retryable failure, never an empty successful page", async () => {
  for (const payload of [{}, { post_stream: {} }, { post_stream: { posts: null } }]) {
    const f = fixture(() => ({ payload }));
    await assert.rejects(f.forum.postsPage(1, [11, 12]), /有效的回复分页/);
    assert.equal(f.calls.length, 1);
  }
});

test("explicit empty and partial reply pages remain valid for unavailable/deleted stream ids", async () => {
  for (const posts of [[], [{ id: 11, post_number: 2 }]]) {
    const f = fixture(() => ({ payload: { post_stream: { posts } } }));
    assert.deepEqual(await f.forum.postsPage(1, [11, 12]), posts);
  }
});
