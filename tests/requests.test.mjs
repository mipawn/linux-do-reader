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
        const { status = 200, payload = {}, text, headers: extraHeaders, url: responseUrl, retryAfter, serverDate, invalidJSON } = await respond(url, options, calls.length);
        const headerMap = new Map(Object.entries(extraHeaders || {}).map(([key, value]) => [key.toLowerCase(), value]));
        const responseHeaders = {
          get: name => {
            const key = String(name).toLowerCase();
            if (headerMap.has(key)) return headerMap.get(key);
            if (key === "retry-after") return retryAfter ?? null;
            if (key === "date") return serverDate ?? null;
            return null;
          }
        };
        const response = {
          ok: status >= 200 && status < 300,
          status,
          url: responseUrl,
          headers: responseHeaders,
          json: async () => { if (invalidJSON) throw new SyntaxError("bad JSON"); return payload; }
        };
        if (text !== undefined) response.text = async () => text;
        return response;
      } finally { active--; }
    }
  });
  vm.runInContext(source, context);
  const forum = context.LDForum;
  forum.requestQueue.wait = async ms => { waits.push(ms); clock += ms; };
  return { forum, calls, waits, storage, peak: () => peak, now: () => clock, advance: ms => { clock += ms; } };
}

test("rate-limit errors identify the triggering operation across blocked actions and tabs without retaining sensitive data", async () => {
  const secret = "PRIVATE_QUERY_ACCOUNT_TOKEN";
  const f = fixture(() => ({ status: 429, retryAfter: "5", payload: { errors: [secret] } }));
  await assert.rejects(f.forum.request(`/presence/get.json?channels[]=/discourse-presence/reply/991122&token=${secret}`),
    error => error.status === 429 && error.requestSource === "正在回复状态" && /正在回复状态/.test(error.message));
  await assert.rejects(f.forum.request(`/search.json?q=${secret}`),
    error => error.requestSource === "正在回复状态" && error.blockedRequestSource === "搜索" && /正在回复状态/.test(error.message));
  const other = new f.forum.RequestQueue({ now: f.now, storage: f.storage });
  assert.equal(other.busyError().requestSource, "正在回复状态");
  assert.match(other.busyError().message, /正在回复状态/);
  const diagnostic = f.forum.requestQueue.diagnostics();
  assert.equal(diagnostic.length, 1, "requests rejected during cooldown did not actually hit the network");
  assert.deepEqual(JSON.parse(JSON.stringify(diagnostic[0])), {
    requestSource: "正在回复状态", method: "GET", background: false, startedAt: 0, completedAt: 0, status: 429
  });
  for (const value of [JSON.stringify(diagnostic), f.storage.getItem("linux-do-reader-retry-info")]) {
    assert.doesNotMatch(value, /PRIVATE_QUERY|991122|channels|errors|token/);
  }
  assert.deepEqual(JSON.parse(f.storage.getItem("linux-do-reader-retry-info")), {
    requestSource: "正在回复状态", method: "GET", status: 429, retryAt: 5000
  });
});

test("request diagnostics are bounded snapshots of local whitelisted classifications and real HTTP statuses", async () => {
  const f = fixture((url, options) => ({ status: options.method === "DELETE" ? 204 : 200 }));
  const cases = [
    ["/latest.json", "话题列表"], ["/site.json", "社区元数据"], ["/session/current.json", "登录状态"],
    ["/session/csrf.json", "操作准备"], ["/search.json?q=SECRET", "搜索"],
    ["/t/private-slug/992233.json", "话题详情"], ["/t/992233/posts.json?post_ids[]=998877", "回复分页"],
    ["/bookmarks/887766.json", "书签操作"], ["/t/992233/notifications", "话题通知设置"]
  ];
  for (const [path, label] of cases) {
    await f.forum.request(path);
    assert.equal(f.forum.requestQueue.diagnostics().at(-1).requestSource, label);
  }
  await f.forum.request("/unknown.json", { requestSource: "constructor" });
  await f.forum.request("/unknown.json", { requestSource: "SECRET_QUERY" });
  await f.forum.request("/bookmarks/1.json", { method: "DELETE", body: { secret: "SECRET_BODY" }, csrf: "SECRET_CSRF" });
  const records = f.forum.requestQueue.diagnostics();
  assert.equal(records.length, 10);
  assert.equal(records.at(-2).requestSource, "其他读取");
  assert.equal(records.at(-1).status, 204);
  assert.equal(records.at(-1).method, "DELETE");
  assert.doesNotMatch(JSON.stringify(records), /SECRET|992233|998877|887766|private-slug|unknown/);
  records[0].requestSource = "MODIFIED";
  records.pop();
  assert.equal(f.forum.requestQueue.diagnostics().length, 10);
  assert.notEqual(f.forum.requestQueue.diagnostics()[0].requestSource, "MODIFIED");
  assert.equal(f.storage.getItem("linux-do-reader-retry-info"), undefined, "successful history is never persisted");
});

test("diagnostics expose in-flight and failed outcomes, and native draft cooldowns use the same safe source", async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const f = fixture(async () => { await blocked; throw new TypeError("PRIVATE_NETWORK_ERROR"); });
  const request = assert.rejects(f.forum.request("/search.json?q=PRIVATE", { background: true }));
  await settle();
  assert.equal(f.forum.requestQueue.diagnostics()[0].status, null);
  assert.equal(f.forum.requestQueue.diagnostics()[0].completedAt, null);
  release(); await request;
  assert.equal(f.forum.requestQueue.diagnostics()[0].status, 0);
  assert.equal(f.forum.requestQueue.diagnostics()[0].completedAt, 0);
  f.forum.requestQueue.defer(5000, { source: "draft", status: 429, body: "PRIVATE_DRAFT" });
  assert.match(f.forum.requestQueue.busyError().message, /原版草稿读取/);
  assert.equal(f.forum.requestQueue.busyError().requestSource, "原版草稿读取");
  assert.equal(f.forum.requestQueue.diagnostics().at(-1).requestSource, "原版草稿读取");
  assert.equal(f.forum.requestQueue.diagnostics().at(-1).status, 429);
  assert.doesNotMatch(JSON.stringify(f.forum.requestQueue.diagnostics()) + f.storage.getItem("linux-do-reader-retry-info"), /PRIVATE/);
});

test("unknown cooldown origins stay explicitly unknown and storage input cannot inject private sources", () => {
  const f = fixture();
  f.storage.setItem("linux-do-reader-retry-at", "5000");
  f.storage.setItem("linux-do-reader-retry-info", JSON.stringify({ requestSource: "PRIVATE_TOPIC_TITLE", retryAt: 5000 }));
  const error = f.forum.requestQueue.busyError("搜索");
  assert.equal(error.requestSource, null);
  assert.match(error.message, /来源未记录/);
  assert.doesNotMatch(error.message, /PRIVATE|搜索/);
});

const cooling = (ms, status = 0) => error => error.status === status && error.retryAfter === ms && error.recoverable;
const limited = ms => cooling(ms, 429);

test("content, posts and background requests share a two-second default lane", async () => {
  const f = fixture();
  await Promise.all([
    f.forum.request("/latest.json"), f.forum.request("/t/1/posts.json"),
    f.forum.request("/bookmarks.json", { method: "POST", background: true, priority: 2 })
  ]);
  assert.equal(f.peak(), 1);
  assert.deepEqual(f.calls.map(call => call.time), [0, 2000, 4000]);
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

test("short, fractional and zero rate-limit deadlines keep a five-second safety floor without replay", async () => {
  for (const header of ["2", "0.25", "0"]) {
    const f = fixture((url, options, count) => count === 1 ? { status: 429, retryAfter: header } : {});
    await assert.rejects(f.forum.request("/latest.json"), limited(5000));
    assert.equal(f.calls.length, 1, "no implicit replay even with a zero server deadline");
    assert.equal(f.forum.requestQueue.currentInterval(), 4000);
    f.advance(5000);
    await f.forum.request("/latest.json");
    assert.equal(f.calls.length, 2, "an explicit action recovers after the safety deadline");
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
    error_type: "rate_limit", extras: { wait_seconds: 2 }, wait_seconds: 8, errors: ["busy"]
  } }));
  await assert.rejects(f.forum.request("/latest.json"), limited(8000));
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

test("past HTTP-date rate-limit deadline still gets a safety wait without replay", async () => {
  const f = fixture(() => ({ status: 429, retryAfter: new Date(0).toUTCString() }));
  f.advance(10000);
  await assert.rejects(f.forum.request("/latest.json"), limited(5000));
  assert.equal(f.calls.length, 1);
});

test("502/503/504 with Retry-After surface cooldown and never silently auto-replay", async () => {
  for (const status of [502, 503, 504]) {
    const f = fixture(() => ({ status, retryAfter: "3" }));
    await assert.rejects(f.forum.request("/t/1.json"), error => error.status === status && error.retryAfter === 3000);
    await assert.rejects(f.forum.request("/site.json"), cooling(3000, status));
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.waits, []);
  }
});

test("a transient GET 502/503/504 gets exactly one short paced recovery", async () => {
  for (const status of [502, 503, 504]) {
    const f = fixture((url, options, count) => count === 1 ? { status } : {});
    await f.forum.request("/t/1.json");
    assert.deepEqual(f.calls.map(call => call.time), [0, 2000]);
    assert.equal(f.forum.requestQueue.cooldown(), 0);
    const failed = fixture(() => ({ status }));
    await assert.rejects(failed.forum.request("/t/1.json"), error => error.status === status && error.recoverable);
    assert.deepEqual(failed.calls.map(call => call.time), [0, 2000]);
  }
});

test("a fetch network transient recovers once and a persistent network error is visible", async () => {
  const f = fixture((url, options, count) => { if (count === 1) throw new TypeError("Failed to fetch"); return {}; });
  await f.forum.request("/latest.json");
  assert.deepEqual(f.calls.map(call => call.time), [0, 2000]);
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
  await assert.rejects(f.forum.change("/bookmarks.json", "POST", {}), cooling(90000));
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

test("tabs never shorten shared cooldown deadlines", () => {
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
  await assert.rejects(f.forum.request("/site.json"), cooling(2000));
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.waits, []);
});

test("cooldown is rechecked after the normal pacing wait", async () => {
  const f = fixture();
  await f.forum.request("/first.json");
  f.forum.requestQueue.wait = async () => f.storage.setItem("linux-do-reader-retry-at", "9000");
  await assert.rejects(f.forum.request("/next.json"), cooling(9000));
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
  await assert.rejects(f.forum.request("/site.json"), cooling(2000));
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

function managedLocks(gate = Promise.resolve()) {
  let tail = gate, active = 0;
  const calls = [];
  return {
    calls, active: () => active,
    request(name, callback) {
      const result = tail.then(async () => {
        active++;
        try {
          const value = callback();
          calls.push({ name, asyncCallback: typeof value?.then === "function" });
          return await value;
        } finally { active--; }
      });
      tail = result.catch(() => {});
      return result;
    }
  };
}

function sharedQueue(f, locks) {
  return new f.forum.RequestQueue({ now: f.now, storage: f.storage, locks,
    wait: async ms => { f.advance(ms); } });
}

test("real one-second 429s impose five-second waits and adapt 4/8 seconds without penalizing blocked clicks", async () => {
  const f = fixture(() => ({ status: 429, retryAfter: "1" }));
  await assert.rejects(f.forum.request("/latest.json"), error => limited(5000)(error) && /原站返回限流.*HTTP 429/.test(error.message));
  assert.equal(f.forum.requestQueue.currentInterval(), 4000);
  const firstPenalty = f.storage.getItem("linux-do-reader-pacing");
  for (let i = 0; i < 3; i++) {
    await assert.rejects(f.forum.request("/t/1.json"), error => limited(5000)(error) && /本次未向原站重新请求/.test(error.message));
  }
  assert.equal(f.calls.length, 1);
  assert.equal(f.storage.getItem("linux-do-reader-pacing"), firstPenalty, "blocked clicks neither escalate nor extend adaptation");
  assert.equal(f.forum.requestQueue.diagnostics().length, 1);
  f.advance(5000);
  await assert.rejects(f.forum.request("/latest.json"), limited(5000));
  assert.equal(f.forum.requestQueue.currentInterval(), 8000);
  f.advance(5000);
  await assert.rejects(f.forum.request("/latest.json"), limited(5000));
  assert.equal(f.forum.requestQueue.currentInterval(), 8000, "adaptation is capped");
  assert.deepEqual(f.calls.map(call => call.time), [0, 5000, 13000]);
});

test("JSON rate limits and native 429 observations share adaptation but service failures do not", async () => {
  const f = fixture(() => ({ payload: { error_type: "rate_limit", wait_seconds: 1 } }));
  await assert.rejects(f.forum.request("/latest.json"), error => limited(5000)(error) && /JSON rate_limit/.test(error.message));
  assert.equal(f.forum.requestQueue.currentInterval(), 4000);
  const other = sharedQueue(f, null);
  assert.equal(other.currentInterval(), 4000);
  other.defer(1000, { source: "draft", status: 429 });
  assert.equal(other.currentInterval(), 8000);
  assert.equal(f.forum.requestQueue.currentInterval(), 8000);
  assert.equal(other.cooldown(), 5000);
  const penalty = f.storage.getItem("linux-do-reader-pacing");
  other.defer(20000, { source: "composer", status: 503 });
  assert.equal(f.storage.getItem("linux-do-reader-pacing"), penalty);
  assert.equal(f.forum.requestQueue.busyError().status, 503);
  assert.doesNotMatch(f.forum.requestQueue.busyError().message, /限流/);
});

test("adaptive intervals expire after ten minutes and cooldown origins do not survive expiry", async () => {
  const f = fixture();
  f.forum.requestQueue.defer(1000, { requestSource: "feed", status: 429 });
  const other = sharedQueue(f, null);
  assert.equal(other.currentInterval(), 4000);
  assert.equal(other.busyError().requestSource, "话题列表");
  f.advance(599999);
  assert.equal(other.currentInterval(), 4000);
  f.advance(1);
  assert.equal(f.forum.requestQueue.currentInterval(), 2000);
  assert.equal(other.currentInterval(), 2000);
  assert.equal(f.forum.requestQueue.cooldown(), 0);
  assert.equal(f.forum.requestQueue.retryInfo, null);
  assert.equal(other.busyError().requestSource, null);
  assert.equal(other.busyError().status, 0);
  assert.doesNotMatch(other.busyError().message, /限流|话题列表/);
  f.storage.setItem("linux-do-reader-retry-at", String(f.now() + 1000));
  const unknown = f.forum.requestQueue.busyError("搜索");
  assert.equal(unknown.status, 0);
  assert.equal(unknown.requestSource, null);
  assert.match(unknown.message, /等待原因未确认.*本次未向原站重新请求/);
});

test("one-second 503 waits remain service errors for queued clicks and other tabs, never synthetic 429s", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(async () => { await gate; return { status: 503, retryAfter: "1" }; });
  const original = assert.rejects(f.forum.request("/latest.json"), error => cooling(1000, 503)(error) && /暂时不可用/.test(error.message));
  const queued = assert.rejects(f.forum.request("/t/1.json"), error => cooling(1000, 503)(error) && /本次未向原站重新请求/.test(error.message) && !/限流/.test(error.message));
  release(); await Promise.all([original, queued]);
  const other = sharedQueue(f, null);
  assert.equal(other.busyError().status, 503);
  assert.doesNotMatch(other.busyError().message, /限流/);
  assert.equal(other.currentInterval(), 2000);
  assert.equal(f.storage.getItem("linux-do-reader-pacing"), undefined);
  assert.equal(f.calls.length, 1);
  assert.equal(f.forum.requestQueue.diagnostics().length, 1);
});

test("cross-tab queues atomically share HTTP starts under a short Web Lock", async () => {
  const f = fixture(), locks = managedLocks();
  const one = sharedQueue(f, locks), two = sharedQueue(f, locks);
  const starts = [];
  const work = async () => { assert.equal(locks.active(), 0, "HTTP work executes after releasing the lock"); starts.push(f.now()); };
  await Promise.all([one.schedule(work), two.schedule(work), one.schedule(work), two.schedule(work)]);
  assert.equal(starts.length, 4);
  assert.equal(starts[0], 0);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 2000, JSON.stringify(starts));
  assert.equal(Number(f.storage.getItem("linux-do-reader-last-start")), starts.at(-1));
  assert.ok(locks.calls.length >= 4);
  assert.ok(locks.calls.every(call => call.name === "linux-do-reader-http-start" && !call.asyncCallback));
});

test("a slow HTTP in one tab never holds the start lock against another tab", async () => {
  const f = fixture(), locks = managedLocks();
  const one = sharedQueue(f, locks), two = sharedQueue(f, locks);
  let release;
  const slowHTTP = new Promise(resolve => { release = resolve; });
  const starts = [];
  const first = one.schedule(async () => { assert.equal(locks.active(), 0); starts.push(f.now()); await slowHTTP; });
  await two.schedule(async () => { assert.equal(locks.active(), 0); starts.push(f.now()); });
  release(); await first;
  assert.deepEqual(starts, [0, 2000]);
});

test("canceled entries waiting on a start lock consume no shared slot or request diagnostic", async () => {
  const f = fixture();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const locks = managedLocks(gate), one = sharedQueue(f, locks), two = sharedQueue(f, locks);
  const controller = new AbortController();
  const canceled = assert.rejects(one.schedule(() => assert.fail("canceled work started"), { signal: controller.signal }), error => error.name === "AbortError");
  let startedAt;
  const next = two.schedule(() => { startedAt = f.now(); });
  controller.abort(); await canceled;
  assert.equal(f.storage.getItem("linux-do-reader-last-start"), undefined);
  release(); await next; await settle();
  assert.equal(startedAt, 0);
  assert.equal(one.diagnostics().length, 0);
  assert.equal(two.diagnostics().length, 1);
});

test("content arriving while a start lock is queued overtakes metadata before reserving HTTP", async () => {
  const f = fixture();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const locks = managedLocks(gate), queue = sharedQueue(f, locks), order = [];
  const metadata = queue.schedule(() => order.push(["metadata", f.now()]), { priority: 1 });
  const content = queue.schedule(() => order.push(["content", f.now()]), { priority: 0 });
  release(); await Promise.all([metadata, content]);
  assert.deepEqual(order, [["content", 0], ["metadata", 2000]]);
});

test("without Web Locks or after lock denial, shared start pacing still works best-effort", async () => {
  for (const locks of [null, { request() { throw new TypeError("unavailable"); } }]) {
    const f = fixture(), one = sharedQueue(f, locks), two = sharedQueue(f, locks), starts = [];
    await one.schedule(() => starts.push(f.now()));
    await two.schedule(() => starts.push(f.now()));
    assert.deepEqual(starts, [0, 2000]);
  }
});

test("shared pacing metadata is numerical, bounded and cannot retain sensitive inputs", async () => {
  const f = fixture();
  for (const pacing of [{ interval: 4000, expiresAt: Infinity }, { interval: 8000, expiresAt: 600001 },
    { interval: "PRIVATE_TOKEN", expiresAt: 600000 }, { interval: 99999999, expiresAt: 600000 }]) {
    f.storage.setItem("linux-do-reader-pacing", JSON.stringify(pacing));
    assert.equal(f.forum.requestQueue.currentInterval(), 2000);
  }
  for (const start of ["PRIVATE_URL", "Infinity", "-1", "9999999999999"]) {
    f.storage.setItem("linux-do-reader-last-start", start);
    assert.equal(f.forum.requestQueue.startDelay(), 0);
  }
  f.forum.requestQueue.defer(1000, { requestSource: "PRIVATE_QUERY", status: 429,
    url: "/t/private/991122", body: "PRIVATE_BODY", interval: "PRIVATE_TOKEN" });
  assert.deepEqual(JSON.parse(f.storage.getItem("linux-do-reader-pacing")), { interval: 4000, expiresAt: 600000 });
  assert.doesNotMatch(f.storage.getItem("linux-do-reader-pacing") + f.storage.getItem("linux-do-reader-retry-info"), /PRIVATE|991122|url|body/);
});

test("feed propagates background policy and explicit signals so automatic pages never retry transients", async () => {
  for (const respond of [() => ({ status: 503 }), () => { throw new TypeError("offline"); }]) {
    const f = fixture(respond);
    await assert.rejects(f.forum.feed("/latest.json", undefined, { background: true, priority: 2 }));
    assert.equal(f.calls.length, 1);
    assert.equal(f.forum.requestQueue.diagnostics()[0].background, true);
    assert.equal(f.forum.requestQueue.diagnostics()[0].requestSource, "话题列表");
  }
  const f = fixture(() => ({ payload: { topic_list: { topics: [] } } }));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.forum.feed("/latest.json", controller.signal, { signal: new AbortController().signal, background: true }), error => error.name === "AbortError");
  assert.equal(f.calls.length, 0);
});

test("Cloudflare challenges on 429/403/503 pause without rate-limit penalty, auto-retry, or leaking URLs", async () => {
  const cfHTML = "<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={};</script><script src=\"/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1\"></script></body></html>";
  const cases = [
    { status: 429, headers: { "cf-mitigated": "challenge", "content-type": "text/html; charset=UTF-8" }, text: cfHTML, retryAfter: "60" },
    { status: 403, headers: { "content-type": "text/html" }, text: cfHTML },
    { status: 503, headers: { "content-type": "text/html" }, text: "<html><div id=\"cf-turnstile\"></div></html>" }
  ];
  for (const response of cases) {
    const f = fixture(() => response);
    await assert.rejects(f.forum.request("/t/private-slug/991122.json"), error =>
      error.challenge === true && error.recoverable === false && error.status === response.status &&
      error.retryAfter === undefined && error.retryAt === undefined && /Cloudflare 人机验证/.test(error.message));
    assert.equal(f.calls.length, 1, "503 challenge must not auto-retry");
    assert.equal(f.forum.requestQueue.currentInterval(), 2000, "CF challenge must not trigger 4/8s pacing penalty");
    assert.equal(f.storage.getItem("linux-do-reader-pacing"), undefined);
    assert.equal(f.storage.getItem("linux-do-reader-retry-at"), undefined);
    assert.equal(f.forum.requestQueue.cooldown(), 0);
    const record = f.forum.requestQueue.diagnostics()[0];
    assert.equal(record.challenge, true);
    assert.equal(record.status, response.status);
    assert.equal(record.requestSource, "话题详情");

    // Subsequent foreground and cross-tab requests reject immediately without hitting fetch.
    await assert.rejects(f.forum.request("/search.json?q=SECRET_QUERY"), error =>
      error.challenge === true && error.requestSource === "话题详情" && error.blockedRequestSource === "搜索");
    const other = new f.forum.RequestQueue({ now: f.now, storage: f.storage });
    assert.ok(other.activeChallenge());
    await assert.rejects(other.schedule(() => assert.fail("must not run")), error => error.challenge === true);
    assert.equal(f.calls.length, 1);
    assert.doesNotMatch(f.storage.getItem("linux-do-reader-challenge") + JSON.stringify(f.forum.requestQueue.diagnostics()), /private-slug|991122|SECRET_QUERY/);

    // Clearing the challenge unlocks the queue immediately.
    f.forum.requestQueue.clearChallenge();
    assert.equal(f.forum.requestQueue.activeChallenge(), null);
    assert.equal(other.activeChallenge(), null);
  }
});

test("account() rethrows Cloudflare 403 challenge instead of treating it as logged-out guest", async () => {
  const f = fixture(() => ({
    status: 403,
    headers: { "cf-mitigated": "challenge", "content-type": "text/html" },
    text: "<html><script>window._cf_chl_opt={};</script></html>"
  }));
  await assert.rejects(f.forum.account(), error => error.challenge === true && error.status === 403);
  const guest = fixture(() => ({ status: 403, payload: { errors: ["forbidden"] } }));
  assert.equal(await guest.forum.account(), null);
});

test("plain Discourse 429 and ordinary non-CF HTML 403/200 keep existing handling", async () => {
  const limited = fixture(() => ({ status: 429, retryAfter: "2", payload: { error_type: "rate_limit" } }));
  await assert.rejects(limited.forum.request("/latest.json"), error => error.status === 429 && !error.challenge && error.retryAfter === 5000);
  const plain403 = fixture(() => ({ status: 403, headers: { "content-type": "text/html" }, text: "<html><body>Forbidden</body></html>" }));
  await assert.rejects(plain403.forum.request("/latest.json"), error => error.status === 403 && !error.challenge);
  const html200 = fixture(() => ({ status: 200, headers: { "content-type": "text/html" }, text: "<html><body>Login</body></html>" }));
  await assert.rejects(html200.forum.request("/bookmarks.json", { method: "POST" }), error => !error.challenge && /无法识别/.test(error.message));
});
