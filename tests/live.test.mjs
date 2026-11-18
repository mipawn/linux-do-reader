import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../live.js", import.meta.url), "utf8");
const context = vm.createContext({ AbortController, DOMException, URLSearchParams, setTimeout, clearTimeout });
vm.runInContext(source, context);
const { TopicSession, NativeClient } = context.LDLive;
const plain = value => JSON.parse(JSON.stringify(value));
const settle = () => new Promise(resolve => setImmediate(resolve));
const presenceName = "/discourse-presence/reply/123";
const post = floor => ({ id: 100 + floor, topic_id: 123, post_number: floor, username: `user${floor}`, cooked: `<p>${floor}</p>` });

function clockFixture() {
  let time = 0, serial = 0;
  const tasks = new Map();
  const clock = {
    now: () => time,
    setTimer(fn, delay) { const id = ++serial; tasks.set(id, { fn, at: time + delay }); return id; },
    clearTimer(id) { tasks.delete(id); },
    tasks,
    async advance(duration) {
      const end = time + duration;
      let steps = 0;
      while (true) {
        const next = [...tasks].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        assert.ok(++steps < 100, "a snapshot must not become an automatic retry/poll loop");
        tasks.delete(next[0]);
        time = next[1].at;
        next[1].fn();
        await settle();
      }
      time = end;
      await settle();
    }
  };
  return clock;
}

function fixture({ presenceEnabled = false, presence = { count: 0, last_message_id: 20, users: [] },
  postsResponse, topicResponse, requestResponse, watchResult = {}, visible = true } = {}) {
  const clock = clockFixture(), calls = [], changes = [], statuses = [], watches = [], unwatches = [];
  let listener, cooldownUntil = 0;
  const detail = { data: { id: 123, title: "Topic", posts_count: 2, message_bus_last_id: 10, chunk_size: 20 },
    stream: [101, 102], posts: new Map([post(1), post(2)].map(value => [value.id, value])), attempted: new Set([101, 102]),
    collapsed: new Set([2]), sort: "top", controller: new AbortController() };
  const client = {
    watch(topicId, options, handler) { watches.push({ topicId, ...plain(options) }); listener = handler; return { watchId: "own-watch", ready: Promise.resolve(watchResult) }; },
    unwatch(watchId) { unwatches.push(watchId); }
  };
  const forum = {
    requestQueue: {
      cooldown: () => Math.max(0, cooldownUntil - clock.now()),
      busyError: () => Object.assign(new Error("原站限流"), { status: 429, retryAt: cooldownUntil })
    },
    async request(path, options) {
      calls.push({ kind: "request", path, options, at: clock.now() });
      if (requestResponse) return requestResponse(path, options);
      if (path.startsWith("/presence/")) return { [presenceName]: presence };
      if (topicResponse) return topicResponse(path, options);
      return { ...detail.data, message_bus_last_id: 100, post_stream: { stream: [...detail.stream], posts: [post(1)] } };
    },
    async postsPage(topicId, ids, signal, options) {
      calls.push({ kind: "posts", topicId, ids: [...ids], signal, options, at: clock.now() });
      return postsResponse ? postsResponse(ids, signal) : ids.map(id => post(id - 100));
    }
  };
  const session = new TopicSession({ client, forum, detail, presenceEnabled, currentUserId: 7, isVisible: () => visible,
    onChange: value => changes.push(value), onStatus: value => statuses.push(value),
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  return { session, detail, clock, calls, changes, statuses, watches, unwatches,
    event: (...args) => listener(...args), hide: () => { visible = false; session.visibilityChanged(); },
    show: () => { visible = true; session.visibilityChanged(); },
    cooldown: until => { cooldownUntil = until; } };
}

function topic(f, floor, type = "created", messageId) { f.event("topic", { id: 100 + floor, post_number: floor, type }, messageId); }

test("one native watch starts at the topic JSON cursor and idle time performs no polling", async () => {
  const f = fixture();
  await f.session.start();
  assert.deepEqual(f.watches, [{ topicId: 123, topicLastId: 10 }]);
  await f.clock.advance(300000);
  assert.equal(f.calls.length, 0);
  assert.equal(f.session.status().phase, "active");
  f.session.stop();
  assert.deepEqual(f.unwatches, ["own-watch"]);
});

test("bursts and duplicate creations are batched as background incremental reads, never a topic reload", async () => {
  const f = fixture();
  await f.session.start();
  topic(f, 3, "created", 11);
  topic(f, 4, "created", 12);
  topic(f, 3, "created", 12);
  assert.equal(f.calls.length, 0);
  await f.clock.advance(1000);
  assert.deepEqual(f.calls.map(call => call.ids), [[103, 104]]);
  assert.equal(f.calls[0].options.background, true);
  assert.equal(f.calls[0].options.priority, 2);
  assert.equal(f.detail.data.posts_count, 4);
  assert.equal(f.detail.sort, "top");
  assert.deepEqual([...f.detail.collapsed], [2]);
  topic(f, 5, "created", 13);
  await f.clock.advance(4999);
  assert.equal(f.calls.length, 1);
  await f.clock.advance(1);
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls[1].at - f.calls[0].at >= 5000);
  await f.clock.advance(60000);
  assert.equal(f.calls.length, 2);
});

test("non-content events and revisions of unloaded history do not issue GETs", async () => {
  const f = fixture();
  await f.session.start();
  for (const [index, type] of ["stats", "liked", "acted", "read", "unknown", "revised"].entries()) {
    f.event("topic", { type, id: 120, post_number: 20 }, 11 + index);
  }
  await f.clock.advance(30000);
  assert.equal(f.calls.length, 0);
  topic(f, 2, "revised", 17);
  await f.clock.advance(1000);
  assert.deepEqual(f.calls[0].ids, [102]);
});

test("message gaps coalesce to one controlled topic snapshot and only new missing posts", async () => {
  const f = fixture({ topicResponse: () => ({ id: 123, posts_count: 4, message_bus_last_id: 14,
    post_stream: { stream: [101, 102, 103, 104], posts: [post(1), post(4)] } }) });
  await f.session.start();
  topic(f, 4, "created", 13);
  f.event("topic", { type: "reload_topic" }, 14);
  await f.clock.advance(1000);
  assert.equal(f.calls[0].path, "/t/123.json");
  await f.clock.advance(5000);
  assert.deepEqual(f.calls[1].ids, [103, 102]);
  await f.clock.advance(60000);
  assert.equal(f.calls.length, 2);
});

test("a protected existing native channel cursor asks for one catch-up snapshot", async () => {
  const f = fixture({ watchResult: { needsTopicSnapshot: true } });
  await f.session.start();
  await f.clock.advance(0);
  assert.equal(f.calls[0].path, "/t/123.json");
  await f.clock.advance(60000);
  assert.equal(f.calls.length, 2, "the snapshot and one recheck of loaded history settle without polling");
});

test("an event gap received during an in-flight topic snapshot is not erased by its response", async () => {
  let release;
  const f = fixture({ topicResponse: () => new Promise(resolve => { release = resolve; }) });
  await f.session.start();
  f.event("topic", { type: "reload_topic" }, 11);
  await f.clock.advance(1000);
  topic(f, 3, "created", 14);
  release({ id: 123, posts_count: 2, message_bus_last_id: 11, post_stream: { stream: [101, 102], posts: [post(1)] } });
  await settle();
  assert.equal(f.session.topicNeeded, true);
  assert.ok(f.detail.stream.includes(103));
  f.session.stop();
});

test("a newer revision during an in-flight incremental read gets a subsequent paced read", async () => {
  let release, reads = 0;
  const f = fixture({ postsResponse: () => ++reads === 1 ? new Promise(resolve => { release = resolve; }) : [{ ...post(2), cooked: "latest" }] });
  await f.session.start();
  topic(f, 2, "revised", 11);
  await f.clock.advance(1000);
  topic(f, 2, "revised", 12);
  release([{ ...post(2), cooked: "older" }]);
  await settle();
  assert.equal(f.session.hasPending(102), true);
  await f.clock.advance(5000);
  assert.equal(f.calls.length, 2);
  assert.equal(f.detail.posts.get(102).cooked, "latest");
});

test("empty incremental pages settle once and scrub stale content without claiming deletion", async () => {
  const f = fixture({ postsResponse: () => [] });
  await f.session.start();
  topic(f, 2, "revised", 11);
  topic(f, 3, "created", 12);
  await f.clock.advance(1000);
  const existing = f.detail.posts.get(102);
  assert.equal(existing.unavailable, true);
  assert.equal(existing.deleted, undefined);
  assert.equal(existing.username, undefined);
  assert.equal(existing.cooked, undefined);
  assert.equal(f.detail.posts.has(103), false);
  assert.equal(f.detail.attempted.has(103), true);
  await f.clock.advance(120000);
  assert.equal(f.calls.length, 1);
});

test("deletion immediately scrubs identity/body and an old in-flight response cannot revive it", async () => {
  let release;
  const f = fixture({ postsResponse: () => new Promise(resolve => { release = resolve; }) });
  await f.session.start();
  topic(f, 2, "revised", 11);
  await f.clock.advance(1000);
  topic(f, 2, "deleted", 12);
  const deleted = f.detail.posts.get(102);
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.cooked, undefined);
  assert.equal(deleted.username, undefined);
  assert.equal(f.detail.stream.includes(102), false);
  release([post(2)]);
  await settle();
  assert.equal(f.detail.posts.get(102).deleted, true);
  await f.clock.advance(60000);
  assert.equal(f.calls.length, 1);
});

test("an explicit recovery can restore a deleted floor without losing branches or sort", async () => {
  const f = fixture();
  await f.session.start();
  topic(f, 2, "deleted", 11);
  topic(f, 2, "recovered", 12);
  await f.clock.advance(1000);
  assert.equal(f.detail.posts.get(102).cooked, post(2).cooked);
  assert.equal(f.detail.posts.get(102).deleted, undefined);
  assert.equal(f.detail.data.posts_count, 2);
  assert.deepEqual([...f.detail.collapsed], [2]);
});

test("429 pauses automatic reads indefinitely; new messages and cooldown expiry do not silently replay", async () => {
  let fail = true;
  const f = fixture({ postsResponse: () => {
    if (fail) throw Object.assign(new Error("rate limited"), { status: 429, retryAt: 11000 });
    return [post(3), post(4)];
  } });
  await f.session.start();
  topic(f, 3, "created", 11);
  await f.clock.advance(1000);
  assert.equal(f.session.status().phase, "paused");
  f.session.refresh();
  await f.clock.advance(1000);
  assert.equal(f.calls.length, 1, "explicit click before the deadline is also blocked");
  topic(f, 4, "created", 12);
  await f.clock.advance(60000);
  assert.equal(f.calls.length, 1);
  fail = false;
  f.session.refresh();
  await f.clock.advance(0);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].options.background, false);
});

test("a cooldown from the other pane/tab prevents even the first live fetch", async () => {
  const f = fixture();
  await f.session.start();
  f.cooldown(20000);
  topic(f, 3, "created", 11);
  await f.clock.advance(1000);
  assert.equal(f.calls.length, 0);
  assert.equal(f.session.status().retryAt, 20000);
  await f.clock.advance(60000);
  assert.equal(f.calls.length, 0);
});

test("network failures have no automatic retry, even after more events", async () => {
  const f = fixture({ postsResponse: () => { throw new TypeError("network"); } });
  await f.session.start();
  topic(f, 3, "created", 11);
  await f.clock.advance(1000);
  topic(f, 4, "created", 12);
  await f.clock.advance(60000);
  assert.equal(f.calls.length, 1);
  assert.equal(f.session.status().phase, "paused");
});

test("hidden tabs coalesce events without requests and catch up once visible", async () => {
  const f = fixture();
  await f.session.start();
  topic(f, 3, "created", 11);
  f.hide();
  topic(f, 4, "created", 12);
  await f.clock.advance(30000);
  assert.equal(f.calls.length, 0);
  f.show();
  await f.clock.advance(0);
  assert.deepEqual(f.calls[0].ids, [103, 104]);
  await f.clock.advance(30000);
  assert.equal(f.calls.length, 1);
});

test("the historical pager and live reads never claim the same request lane simultaneously", async () => {
  const f = fixture();
  await f.session.start();
  f.detail.moreBusy = true;
  topic(f, 3, "created", 11);
  await f.clock.advance(10000);
  assert.equal(f.calls.length, 0);
  assert.equal(f.session.hasPending(103), true);
  f.detail.moreBusy = false;
  f.session.kick();
  await f.clock.advance(1000);
  assert.deepEqual(f.calls[0].ids, [103]);
});

test("stop/topic switch aborts pending reads and removes only the owned watch", async () => {
  let release;
  const f = fixture({ postsResponse: () => new Promise(resolve => { release = resolve; }) });
  await f.session.start();
  topic(f, 3, "created", 11);
  await f.clock.advance(1000);
  f.session.stop();
  f.session.stop();
  assert.equal(f.calls[0].signal.aborted, true);
  assert.deepEqual(f.unwatches, ["own-watch"]);
  const changes = f.changes.length;
  release([post(3)]);
  await settle();
  topic(f, 4, "created", 12);
  await f.clock.advance(60000);
  assert.equal(f.detail.posts.has(103), false);
  assert.equal(f.changes.length, changes);
  assert.equal(f.clock.tasks.size, 0);
});

test("the parent topic abort releases the live subscriptions", async () => {
  const f = fixture();
  await f.session.start();
  f.detail.controller.abort();
  assert.deepEqual(f.unwatches, ["own-watch"]);
  assert.equal(f.session.stopped, true);
});

for (const presence of [
  { count: 0, last_message_id: null, users: [] },
  { count: 0, last_message_id: null },
  { count: 3, last_message_id: null },
  { count: 1, last_message_id: null, users: [{ id: 8, username: "other" }] }
]) {
  test(`native null presence cursor is valid with count ${presence.count} in ${presence.users ? "user" : "anonymous"} mode`, async t => {
    const f = fixture({ presenceEnabled: true, presence }); t.after(() => f.session.stop());
    await f.session.start(); await f.clock.advance(0);
    assert.equal(f.session.status().phase, "active"); assert.equal(f.session.status().presenceReady, true);
    assert.equal(f.session.presence.cursor, 0); assert.equal(f.session.status().count, presence.count);
    if (presence.users) f.event("presence", { entering_users: [{ id: 9, username: "next" }] }, 1);
    else f.event("presence", { count_delta: 1 }, 1);
    assert.equal(f.session.presence.cursor, 1); assert.equal(f.session.status().count, presence.count + 1);
    await f.clock.advance(120000); assert.equal(f.calls.length, 1);
  });
}

for (const presence of [
  undefined, { count: 0, users: [] }, { count: 0, last_message_id: -1, users: [] },
  { count: "0", last_message_id: null }, { count: 0.5, last_message_id: 0 },
  { count: 0, last_message_id: 0, users: {} }
]) {
  test(`malformed presence ${JSON.stringify(presence)} degrades only typing and never retries from events`, async t => {
    const f = fixture({ presenceEnabled: true, requestResponse: () => ({ [presenceName]: presence }) });
    t.after(() => f.session.stop()); await f.session.start(); await f.clock.advance(0);
    assert.equal(f.session.status().phase, "active"); assert.equal(f.session.status().error, undefined);
    assert.match(f.session.status().presenceError, /未返回有效/); assert.equal(f.session.status().presenceReady, false);
    for (let i = 1; i <= 250; i++) f.event("presence", { entering_users: [{ id: 8 }] }, i);
    topic(f, 3, "created", 11); await f.clock.advance(120000);
    assert.equal(f.detail.posts.has(103), true); assert.equal(f.calls.length, 2);
    assert.equal(f.calls[1].kind, "posts"); assert.ok(f.session.presenceBuffer.length <= 200);
  });
}

for (const status of [0, 401, 403, 404, 503]) {
  test(`presence failure HTTP ${status} without a server wait does not suspend正文`, async t => {
    const f = fixture({ presenceEnabled: true, requestResponse: () => { throw Object.assign(new Error("presence failed"), { status }); } });
    t.after(() => f.session.stop()); await f.session.start(); await f.clock.advance(0);
    assert.equal(f.session.status().phase, "active"); assert.equal(f.session.status().error, undefined);
    assert.equal(f.session.status().presenceReady, false);
    if ([401, 403, 404].includes(status)) { assert.equal(f.session.status().presenceUnavailable, true); assert.equal(f.session.refreshPresence(), false); }
    topic(f, 2, "revised", 11); await f.clock.advance(120000);
    assert.deepEqual(f.calls.map(c => c.kind), ["request", "posts"]);
  });
}

for (const shared of ["429", "queue", "503 wait"]) {
  test(`presence ${shared} retains shared pause and never automatically resumes`, async t => {
    const f = fixture({ presenceEnabled: true, requestResponse: () => {
      if (shared === "queue") f.cooldown(5000);
      throw Object.assign(new Error("wait"), shared === "429" ? { status: 429, retryAt: 5000 } : shared === "503 wait" ? { status: 503, retryAfter: 5000 } : {});
    }});
    t.after(() => f.session.stop()); await f.session.start(); await f.clock.advance(0);
    assert.equal(f.session.status().phase, "paused"); topic(f, 3, "created", 11);
    await f.clock.advance(120000); assert.equal(f.calls.length, 1); assert.equal(f.detail.posts.has(103), false);
    assert.equal(f.session.refreshPresence(), false);
  });
}

test("a null channel reset replays a new epoch message 1 received below the old in-flight cursor 20", async t => {
  let reads = 0, release;
  const f = fixture({ presenceEnabled: true, requestResponse: () => ++reads === 1
    ? { [presenceName]: { count: 0, last_message_id: 20, users: [] } }
    : new Promise(resolve => { release = resolve; }) });
  t.after(() => f.session.stop()); await f.session.start(); await f.clock.advance(0);
  f.session.refreshPresence(); await f.clock.advance(5000);
  f.event("presence", { entering_users: [{ id: 8, username: "new-epoch" }] }, 1);
  assert.equal(f.session.presenceBuffer.length, 1);
  release({ [presenceName]: { count: 0, last_message_id: null, users: [] } }); await settle();
  assert.equal(f.session.presence.cursor, 1); assert.equal(f.session.status().count, 1);
  assert.equal(f.session.status().presenceReady, true);
  f.event("presence", { leaving_user_ids: [8] }, 2);
  assert.equal(f.session.status().count, 0); assert.equal(f.session.presence.cursor, 2);
  await f.clock.advance(120000); assert.equal(f.calls.length, 2);
});

test("explicit presence recovery is not starved by pending or continuous正文 events", async t => {
  let reads = 0;
  const f = fixture({ presenceEnabled: true, requestResponse: () => ({ [presenceName]: ++reads === 1 ? {} : { count: 0, last_message_id: null, users: [] } }) });
  t.after(() => f.session.stop()); await f.session.start(); await f.clock.advance(0);
  f.session.refreshPresence(); topic(f, 3, "created", 11);
  await f.clock.advance(5000);
  assert.equal(f.calls.length, 2); assert.ok(f.calls[1].path.startsWith("/presence/"));
  assert.equal(f.calls[1].options.background, false); assert.equal(f.session.presenceManual, false);
  assert.equal(f.session.status().presenceError, null);
  for (let floor = 4; floor <= 8; floor++) { topic(f, floor, "created", floor + 8); await f.clock.advance(5000); }
  assert.equal(f.detail.posts.has(103), true); assert.equal(f.detail.posts.has(108), true);
  assert.ok(f.calls.filter(c => c.kind === "posts").every(c => c.options.background === true));
  assert.equal(f.calls.filter(c => c.path?.startsWith("/presence/")).length, 2);
  const count = f.calls.length; await f.clock.advance(120000); assert.equal(f.calls.length, count);
});

test("presence-only recovery coalesces clicks and adds exactly one foreground presence snapshot, no topic reload", async t => {
  let reads = 0;
  const f = fixture({ presenceEnabled: true, requestResponse: () => ({ [presenceName]: ++reads === 1 ? {} : { count: 0, last_message_id: null, users: [] } }) });
  t.after(() => f.session.stop()); await f.session.start(); await f.clock.advance(0);
  assert.equal(f.session.refreshPresence(), true); assert.equal(f.session.refreshPresence(), false);
  await f.clock.advance(5000); assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(c => c.path.startsWith("/presence/"))); assert.equal(f.calls[1].options.background, false);
  assert.equal(f.calls[1].options.priority, 0); assert.equal(f.session.status().presenceError, null);
  assert.equal(f.session.status().presenceReady, true); assert.equal(f.session.topicNeeded, false);
  await f.clock.advance(120000); assert.equal(f.calls.length, 2);
});

for (const changed of [false, true]) {
  test(`a null resnapshot ${changed ? "preserves newer in-flight entering deltas" : "can reset an unchanged stale channel baseline"}`, async t => {
    let release, reads = 0;
    const f = fixture({ presenceEnabled: true, requestResponse: () => ++reads === 1
      ? { [presenceName]: { count: 0, last_message_id: 20, users: [] } }
      : new Promise(resolve => { release = resolve; }) });
    t.after(() => f.session.stop()); await f.session.start(); await f.clock.advance(0);
    assert.equal(f.session.refreshPresence(), true); await f.clock.advance(5000);
    if (changed) f.event("presence", { entering_users: [{ id: 8, username: "new" }] }, 21);
    release({ [presenceName]: { count: 0, last_message_id: null, users: [] } }); await settle();
    assert.equal(f.session.presence.cursor, changed ? 21 : 0); assert.equal(f.session.status().count, changed ? 1 : 0);
    assert.equal(f.session.status().presenceReady, true); await f.clock.advance(120000); assert.equal(f.calls.length, 2);
  });
}

test("a first null snapshot replays buffered first-channel events, and late snapshots cannot revive stopped topics", async t => {
  let release;
  const f = fixture({ presenceEnabled: true, requestResponse: () => new Promise(resolve => { release = resolve; }) });
  t.after(() => f.session.stop()); await f.session.start(); await f.clock.advance(0);
  f.event("presence", { entering_users: [{ id: 8, username: "new" }] }, 1);
  release({ [presenceName]: { count: 0, last_message_id: null, users: [] } }); await settle();
  assert.equal(f.session.presence.cursor, 1); assert.equal(f.session.status().count, 1);
  f.session.refreshPresence(); await f.clock.advance(5000); f.session.stop();
  release({ [presenceName]: { count: 0, last_message_id: null, users: [] } }); await settle();
  assert.equal(f.session.presence.cursor, 1); assert.equal(f.session.status().count, 1); assert.equal(f.clock.tasks.size, 0);
});

test("presence uses one queued initial snapshot and native sequenced deltas, excluding ourselves", async () => {
  const f = fixture({ presenceEnabled: true, presence: { count: 2, last_message_id: 20,
    users: [{ id: 7, username: "self" }, { id: 8, username: "other" }] } });
  await f.session.start();
  await f.clock.advance(0);
  assert.equal(f.calls.length, 1);
  const url = new URL(f.calls[0].path, "https://linux.do");
  assert.equal(url.pathname, "/presence/get.json");
  assert.deepEqual(url.searchParams.getAll("channels[]"), [presenceName]);
  assert.equal(f.calls[0].options.background, true);
  assert.equal(f.session.status().count, 1);
  f.event("presence", { entering_users: [{ id: 8, username: "other" }, { id: 9, username: "third" }] }, 21);
  f.event("presence", { leaving_user_ids: [8] }, 22);
  f.event("presence", { entering_users: [{ id: 10, username: "duplicate-old" }] }, 21);
  assert.deepEqual(plain(f.session.status().users).map(user => user.id), [9]);
  await f.clock.advance(120000);
  assert.equal(f.calls.length, 1);
});

test("presence events received while its first snapshot is in-flight are replayed in channel order", async () => {
  let release;
  const f = fixture({ presenceEnabled: true, requestResponse: () => new Promise(resolve => { release = resolve; }) });
  await f.session.start();
  await f.clock.advance(0);
  f.event("presence", { entering_users: [{ id: 8, username: "other" }] }, 21);
  f.event("presence", { leaving_user_ids: [8] }, 22);
  release({ [presenceName]: { count: 0, last_message_id: 20, users: [] } });
  await settle();
  assert.equal(f.session.status().count, 0);
  assert.equal(f.session.presence.cursor, 22);
  await f.clock.advance(60000);
  assert.equal(f.calls.length, 1);
});

test("count-only presence stays anonymous and never invents avatar users", async () => {
  const f = fixture({ presenceEnabled: true, presence: { count: 3, last_message_id: 20 } });
  await f.session.start();
  await f.clock.advance(0);
  f.event("presence", { count_delta: 2 }, 21);
  f.event("presence", { count_delta: -20 }, 22);
  assert.equal(f.session.status().count, 0);
  assert.deepEqual(plain(f.session.status().users), []);
  assert.equal(f.calls.length, 1);
});

test("presence gaps require one controlled snapshot, not native five-second resubscribe retries", async () => {
  let reads = 0;
  const f = fixture({ presenceEnabled: true, requestResponse: () => ({ [presenceName]: ++reads === 1
    ? { count: 0, last_message_id: 20, users: [] }
    : { count: 1, last_message_id: 22, users: [{ id: 9, username: "synced" }] } }) });
  await f.session.start();
  await f.clock.advance(0);
  f.event("presence", { entering_users: [{ id: 9, username: "synced" }] }, 22);
  await f.clock.advance(5000);
  assert.equal(f.session.status().count, 1);
  assert.equal(f.session.presence.cursor, 22);
  await f.clock.advance(120000);
  assert.equal(f.calls.length, 2);
});

test("a stale presence snapshot pauses only presence recovery and never loops on subsequent messages", async () => {
  const f = fixture({ presenceEnabled: true });
  await f.session.start();
  await f.clock.advance(0);
  f.event("presence", { entering_users: [{ id: 8 }] }, 22);
  await f.clock.advance(5000);
  assert.match(f.session.status().presenceError, /手动/);
  f.event("presence", { leaving_user_ids: [8] }, 23);
  await f.clock.advance(120000);
  assert.equal(f.calls.length, 2);
  topic(f, 3, "created", 11);
  await f.clock.advance(1000);
  assert.equal(f.calls.length, 3, "topic updates remain usable after a stale presence snapshot");
});

test("unsequenced events cannot cancel or latch a queued explicit presence retry", async t => {
  const f = fixture({ presenceEnabled: true }); t.after(() => f.session.stop());
  await f.session.start(); await f.clock.advance(0);
  f.event("presence", { entering_users: [{ id: 8 }] });
  assert.equal(f.session.refreshPresence(), true);
  f.event("presence", { entering_users: [{ id: 9 }] });
  assert.equal(f.session.presenceNeeded, true);
  await f.clock.advance(5000);
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].options.background, false);
  assert.equal(f.session.presenceManual, false);
  assert.equal(f.session.status().phase, "active");
  await f.clock.advance(120000); assert.equal(f.calls.length, 2);
  assert.equal(f.session.refreshPresence(), true);
});

test("missing presence message ids cannot turn each incoming event into another snapshot", async () => {
  const f = fixture({ presenceEnabled: true });
  await f.session.start();
  assert.equal(f.session.status().presenceReady, false);
  // Even an event racing the initial GET must not cause it to repeat forever.
  f.event("presence", { entering_users: [{ id: 8 }] });
  await f.clock.advance(0);
  assert.equal(f.calls.length, 1);
  assert.match(f.session.status().presenceError, /消息序号/);
  assert.equal(f.session.status().presenceReady, false);
  for (let i = 0; i < 20; i++) {
    f.event("presence", { count_delta: 1 });
    await f.clock.advance(5000);
  }
  assert.equal(f.calls.length, 1, "unsequenced presence traffic never starts automatic recovery GETs");
  topic(f, 3, "created", 11);
  await f.clock.advance(1000);
  assert.equal(f.calls.length, 2, "only presence is degraded; topic updates remain active");
  assert.equal(f.calls[1].options.requestSource, "实时楼层更新");
  f.session.refresh();
  await f.clock.advance(60000);
  assert.equal(f.calls.filter(call => call.path?.startsWith("/presence/")).length, 2,
    "an explicit refresh can read one presence snapshot, not re-enable a retry loop");
  f.session.stop();
});

test("a missing/forbidden presence channel is terminal for this session, not a retryable empty state", async () => {
  const f = fixture({ presenceEnabled: true, presence: null });
  await f.session.start();
  await f.clock.advance(0);
  assert.equal(f.session.status().presenceUnavailable, true);
  f.event("presence", { entering_users: [{ id: 8 }] }, 21);
  await f.clock.advance(120000);
  assert.equal(f.calls.length, 1);
  assert.equal(f.session.status().count, 0);
});

test("native disabled presence does not make a snapshot request", async () => {
  const f = fixture({ presenceEnabled: true, watchResult: { presenceEnabled: false } });
  await f.session.start();
  await f.clock.advance(120000);
  assert.equal(f.calls.length, 0);
});

test("only a matching successful native save queues created/revised post ids", async () => {
  const f = fixture();
  await f.session.start();
  f.event("saved", { id: 103, topic_id: 456, type: "created" });
  f.event("saved", { id: 103, topic_id: 123, type: "created" });
  f.event("saved", { id: 102, topic_id: 123, type: "revised" });
  await f.clock.advance(1000);
  assert.deepEqual(f.calls[0].ids, [103, 102]);
});

function windowFixture() {
  const listeners = new Set(), sent = [];
  const target = { location: new URL("https://linux.do/"), addEventListener(type, fn) { if (type === "message") listeners.add(fn); },
    removeEventListener(type, fn) { if (type === "message") listeners.delete(fn); },
    postMessage(message, origin) { sent.push({ message, origin }); } };
  const emit = (data, source = target, origin = target.location.origin) => { for (const listener of listeners) listener({ data, source, origin }); };
  const response = (request, result, error) => emit({ type: "linux-do-reader:native-response", clientId: request.clientId,
    requestId: request.requestId, ok: !error, result, error });
  return { target, sent, emit, response, listeners };
}

test("the bridge client verifies source, origin, client/request ids and accepts structured native errors", async () => {
  const f = windowFixture(), client = new NativeClient({ window: f.target });
  const pending = client.context();
  const request = f.sent[0].message;
  const event = { type: "linux-do-reader:native-response", clientId: request.clientId, requestId: request.requestId, ok: true, result: { user: null } };
  f.emit(event, {});
  f.emit(event, f.target, "https://evil.example");
  f.emit({ ...event, clientId: "other" });
  assert.equal(client.pending.size, 1);
  f.response(request, null, { code: "NATIVE_UNAVAILABLE", message: "native unavailable", status: 503 });
  await assert.rejects(pending, error => error.message === "native unavailable" && error.status === 503);
  client.close();
  assert.equal(f.listeners.size, 0);
});

test("watch callbacks are registered before acknowledgement and cleanup is allowed off-home", async () => {
  const f = windowFixture(), client = new NativeClient({ window: f.target }), events = [];
  const watch = client.watch(123, { topicLastId: 10 }, (...args) => events.push(args));
  const request = f.sent[0].message;
  f.emit({ type: "linux-do-reader:native-event", clientId: client.clientId, watchId: watch.watchId, kind: "topic", data: { type: "stats" }, messageId: 11 });
  assert.equal(events.length, 1);
  f.response(request, { watching: true });
  await watch.ready;
  f.target.location = new URL("https://linux.do/topic/123");
  await assert.rejects(client.reply({ id: 123 }), /首页/);
  client.unwatch(watch.watchId);
  assert.equal(f.sent.at(-1).message.action, "unwatch");
  assert.equal(client.watchers.size, 0);
  client.close();
});

test("closing the client cancels pending native replies without publishing or replaying anything", async () => {
  const f = windowFixture(), client = new NativeClient({ window: f.target });
  const promise = client.reply({ id: 123 }, { id: 102, post_number: 2 });
  client.close();
  await assert.rejects(promise, error => error.name === "AbortError");
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[0].message.action, "reply");
  assert.equal(f.sent[1].message.action, "dispose");
  assert.equal(client.pending.size, 0);
});

test("live observation contains no independent transport, timers loop, presence write, or read tracking", () => {
  assert.doesNotMatch(source, /fetch\s*\(|setInterval\s*\(|MessageBus\.start|presence\/update|track_visit|\/timings|markRead/);
});

test("repeated manual refresh while a watch is still opening cannot duplicate subscriptions or leak them", async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const f = fixture({ watchResult: blocked });
  const opening = f.session.start();
  await f.session.start();
  f.session.refresh(); f.session.refresh();
  assert.equal(f.watches.length, 1);
  release({ presenceEnabled: false }); await opening;
  await f.session.start();
  assert.equal(f.watches.length, 1);
  f.session.stop();
  assert.deepEqual(f.unwatches, ["own-watch"]);
});

test("topic stop sends owned topic cleanup even after the client's failed watch already removed its listener", async () => {
  const f = windowFixture(), client = new NativeClient({ window: f.target });
  const watch = client.watch(123, { topicLastId: 10 }, () => {});
  const request = f.sent[0].message;
  f.response(request, null, { code: "MESSAGE_BUS_UNAVAILABLE", message: "not ready" });
  await assert.rejects(watch.ready, /not ready/);
  assert.equal(client.watchers.size, 0);
  client.unwatch(watch.watchId, 123);
  assert.equal(f.sent.at(-1).message.action, "unwatch");
  assert.deepEqual(plain(f.sent.at(-1).message.payload), { watchId: watch.watchId, topicId: 123 });
  client.close();
});
