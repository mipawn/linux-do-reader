import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const liveSource = readFileSync(new URL("../live.js", import.meta.url), "utf8");
const forumSource = readFileSync(new URL("../forum.js", import.meta.url), "utf8");
const settle = () => new Promise(resolve => setImmediate(resolve));
const presenceName = "/discourse-presence/reply/123";
const post = (floor, cooked = `<p>${floor}</p>`) => ({
  id: 100 + floor, topic_id: 123, post_number: floor, username: `user${floor}`, cooked,
  deleted: false, user_deleted: false, deleted_at: null
});
const snapshot = (stream, posts, lastId = 10) => ({
  id: 123, title: "Topic", posts_count: stream.length, chunk_size: 20, message_bus_last_id: lastId,
  post_stream: { stream: [...stream], posts }
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function clockFixture() {
  let time = 0, serial = 0;
  const tasks = new Map();
  return {
    now: () => time,
    setTimer(fn, delay = 0) {
      const timer = ++serial;
      tasks.set(timer, { fn, at: time + Math.max(0, delay) });
      return timer;
    },
    clearTimer(timer) { tasks.delete(timer); },
    async advance(duration) {
      const end = time + duration;
      let steps = 0;
      while (true) {
        const next = [...tasks].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        assert.ok(++steps < 100, "a race must not trigger an automatic retry/poll loop");
        tasks.delete(next[0]);
        time = next[1].at;
        next[1].fn();
        await settle();
      }
      time = end;
      await settle();
    }
  };
}

function runtime(clock, extras = {}) {
  class ClockDate extends Date { static now() { return clock.now(); } }
  const context = vm.createContext({
    URL, URLSearchParams, Intl, Date: ClockDate, AbortController, DOMException,
    setTimeout: clock.setTimer, clearTimeout: clock.clearTimer, ...extras
  });
  vm.runInContext(liveSource, context);
  return context;
}

function detailFixture() {
  return {
    data: { id: 123, title: "Topic", posts_count: 2, message_bus_last_id: 10, chunk_size: 20 },
    stream: [101, 102], posts: new Map([post(1), post(2)].map(value => [value.id, value])),
    attempted: new Set([101, 102]), loadingIds: new Set(), collapsed: new Set([2]), sort: "top",
    controller: new AbortController()
  };
}

function fixture({ presenceEnabled = false, requestResponse, postsResponse } = {}) {
  const clock = clockFixture(), context = runtime(clock), detail = detailFixture();
  const calls = [], statuses = [], unwatches = [];
  let listener;
  const client = {
    watch(topicId, options, handler) {
      listener = handler;
      return { watchId: "race-watch", ready: Promise.resolve({ presenceEnabled }) };
    },
    unwatch(watchId) { unwatches.push(watchId); }
  };
  const forum = {
    requestQueue: {
      cooldown: () => 0,
      busyError: () => Object.assign(new Error("原站限流"), { status: 429 })
    },
    async request(path, options) {
      calls.push({ kind: "request", path, options, at: clock.now() });
      if (requestResponse) return requestResponse(path, options);
      if (path.startsWith("/presence/")) return { [presenceName]: { count: 0, last_message_id: 20, users: [] } };
      return snapshot(detail.stream, [post(1)]);
    },
    async postsPage(topicId, ids, signal, options) {
      calls.push({ kind: "posts", ids: [...ids], signal, options, at: clock.now() });
      return postsResponse ? postsResponse(ids, signal, options) : ids.map(id => post(id - 100));
    }
  };
  const session = new context.LDLive.TopicSession({
    client, forum, detail, presenceEnabled, currentUserId: 7,
    onStatus: value => statuses.push(value),
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer
  });
  detail.live = session;
  return { clock, detail, session, calls, statuses, unwatches, event: (...args) => listener(...args) };
}

function topic(f, floor, type, messageId) {
  f.event("topic", { id: 100 + floor, post_number: floor, type }, messageId);
}

test("default browser timers retain the Window receiver through start, hide, pause, refresh and stop", async () => {
  const clock = clockFixture(), context = runtime(clock, {
    hostSetTimer: clock.setTimer, hostClearTimer: clock.clearTimer
  });
  // Node timers do not enforce Window's receiver. Emulate the browser's
  // brand check in this realm instead of letting a permissive VM hide it.
  vm.runInContext(`
    globalThis.setTimeout = function (...args) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return hostSetTimer(...args);
    };
    globalThis.clearTimeout = function (...args) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return hostClearTimer(...args);
    };
  `, context);
  const detail = detailFixture(), calls = [];
  let visible = true, listener;
  const session = new context.LDLive.TopicSession({
    detail, now: clock.now, isVisible: () => visible,
    client: {
      watch(topicId, options, handler) { listener = handler; return { watchId: "receiver", ready: Promise.resolve({ presenceEnabled: true }) }; },
      unwatch() {}
    },
    forum: {
      requestQueue: { cooldown: () => 0 },
      async request(path) { calls.push(path); return { [presenceName]: { count: 0, last_message_id: 20, users: [] } }; }
    }
  });
  await session.start();
  assert.equal(session.status().phase, "active", "start -> kick must not pause before the presence GET");
  await clock.advance(0);
  assert.equal(calls.length, 1, "typing visibility initializes without opening an editor");
  assert.equal(session.status().presenceReady, true);
  listener("topic", { id: 103, post_number: 3, type: "created" }, 11);
  visible = false; session.visibilityChanged();
  visible = true; session.visibilityChanged();
  session.pause(new Error("manual pause"));
  session.refresh();
  session.stop();
  await clock.advance(60000);
  assert.equal(calls.length, 1, "all timer cleanup paths must preserve the browser receiver too");
});

test("real shared RequestQueue latency cannot compress successive live HTTP starts below five seconds", async t => {
  const clock = clockFixture(), blockedForeground = deferred(), network = [];
  const context = runtime(clock, {
    fetch: async (path, options) => {
      network.push({ path, options, at: clock.now() });
      if (path === "/latest.json") await blockedForeground.promise;
      const ids = new URL(path, "https://linux.do").searchParams.getAll("post_ids[]").map(Number);
      const payload = path === "/latest.json" ? {} : { post_stream: { posts: ids.map(id => post(id - 100)) } };
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => payload };
    }
  });
  vm.runInContext(forumSource, context);
  const forum = context.LDForum, detail = detailFixture();
  let listener;
  const session = new context.LDLive.TopicSession({
    forum, detail, presenceEnabled: false,
    client: {
      watch(topicId, options, handler) {
        listener = handler;
        return { watchId: "queue-race", ready: Promise.resolve({ presenceEnabled: false }) };
      },
      unwatch() {}
    },
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer
  });
  t.after(() => { blockedForeground.resolve(); session.stop(); });

  const foreground = forum.request("/latest.json");
  await settle();
  await session.start();
  listener("topic", { id: 103, post_number: 3, type: "created" }, 11);
  await clock.advance(1000);
  assert.equal(forum.requestQueue.pending.length, 1, "the first live read is waiting behind foreground content");
  listener("topic", { id: 104, post_number: 4, type: "created" }, 12);
  await clock.advance(9000);
  blockedForeground.resolve();
  await foreground;
  await settle();
  await clock.advance(6000);

  const live = network.filter(value => value.path.startsWith("/t/123/posts.json"));
  assert.equal(live.length, 2, "each event batch performs exactly one incremental GET");
  assert.equal(live[0].at, 10000, "measure actual fetch start, not live enqueue time");
  assert.ok(live[1].at - live[0].at >= 5000,
    `actual live HTTP starts were only ${live[1].at - live[0].at}ms apart after queue latency`);
  assert.deepEqual(live.map(value => new URL(value.path, "https://linux.do").searchParams.getAll("post_ids[]")), [["103"], ["104"]]);
  await clock.advance(60000);
  assert.equal(network.length, 3, "catch-up must become idle rather than poll or duplicate requests");
});

test("presence gaps arriving throughout a stale in-flight recovery coalesce and then stop", async t => {
  const recovery = deferred();
  let reads = 0;
  const oldPresence = { [presenceName]: { count: 0, last_message_id: 20, users: [] } };
  const f = fixture({ presenceEnabled: true, requestResponse: () => ++reads === 1 ? oldPresence : recovery.promise });
  t.after(() => { recovery.resolve(oldPresence); f.session.stop(); });
  await f.session.start();
  await f.clock.advance(0);
  f.event("presence", { count_delta: 1 }, 22);
  await f.clock.advance(5000);
  for (let messageId = 23; messageId < 40; messageId++) f.event("presence", { count_delta: 1 }, messageId);
  recovery.resolve(oldPresence);
  await settle();
  assert.match(f.session.status().presenceError, /手动/);
  for (let messageId = 40; messageId < 60; messageId++) {
    f.event("presence", { count_delta: 1 }, messageId);
    await f.clock.advance(5000);
  }
  assert.equal(reads, 2, "one initial GET and one failed gap recovery, regardless of later deltas");
});

for (const change of [
  { name: "leaving", initial: [{ id: 8, username: "stopped" }], delta: { leaving_user_ids: [8] }, expectedIds: [] },
  { name: "entering", initial: [], delta: { entering_users: [{ id: 8, username: "typing" }] }, expectedIds: [8] }
]) {
  test(`manual presence resnapshot cannot roll back an already applied ${change.name} delta`, async t => {
    const resnapshot = deferred();
    let presenceReads = 0;
    const oldPresence = { [presenceName]: { count: change.initial.length, last_message_id: 20, users: change.initial } };
    const f = fixture({ presenceEnabled: true, requestResponse: path => {
      if (path.startsWith("/t/")) return snapshot([101, 102], [post(1), post(2)]);
      return ++presenceReads === 1 ? oldPresence : resnapshot.promise;
    } });
    t.after(() => { resnapshot.resolve(oldPresence); f.session.stop(); });
    await f.session.start();
    await f.clock.advance(0);
    f.session.refresh();
    await f.clock.advance(20000);
    assert.equal(presenceReads, 2, "the explicit refresh has reached its second presence GET");

    f.event("presence", change.delta, 21);
    assert.equal(f.session.presence.cursor, 21);
    assert.equal(f.session.status().count, change.expectedIds.length);
    resnapshot.resolve(oldPresence);
    await settle();
    await f.clock.advance(60000);

    assert.equal(f.session.presence.cursor, 21, "an old HTTP snapshot must not rewind applied channel messages");
    assert.equal(f.session.status().count, change.expectedIds.length, "typing count must reflect the newer delta");
    assert.deepEqual([...f.session.status().users].map(user => user.id), change.expectedIds);
    assert.equal(presenceReads, 2, "discarding a stale response must not create automatic resnapshot retries");
  });
}

test("a gap snapshot revalidates already loaded historical edits outside the snapshot first page", async t => {
  const f = fixture({
    requestResponse: () => snapshot([101, 102, 140, 150], [post(1)], 12),
    postsResponse: ids => ids.map(id => post(id - 100, id === 150 ? "<p>EDITED_ON_SERVER</p>" : `<p>${id - 100}</p>`))
  });
  t.after(() => f.session.stop());
  f.detail.stream.push(140, 150);
  f.detail.data.posts_count = 4;
  f.detail.posts.set(150, post(50, "<p>BEFORE_MISSED_EDIT</p>"));
  f.detail.attempted.add(150);
  await f.session.start();
  f.event("topic", { type: "stats" }, 12); // message 11 revised the already loaded floor 50
  await f.clock.advance(20000);

  assert.equal(f.detail.posts.get(150).cooked, "<p>EDITED_ON_SERVER</p>");
  const reads = f.calls.filter(value => value.kind === "posts");
  assert.equal(reads.flatMap(value => value.ids).filter(id => id === 150).length, 1, "revalidate the missed edit once");
  assert.ok(reads.every(value => !value.ids.includes(140)), "do not fetch genuinely unloaded history during live recovery");
  assert.equal(f.calls.filter(value => value.kind === "request").length, 1, "one gap uses one topic snapshot");
  assert.equal(f.detail.collapsed.has(2), true);
  assert.equal(f.detail.sort, "top");
  const count = f.calls.length;
  await f.clock.advance(60000);
  assert.equal(f.calls.length, count, "completed revalidation must settle without a retry loop");
});

for (const mode of ["gap", "manual"]) {
  test(`a sufficiently new ${mode} snapshot can recover a tombstoned floor after its recovered event was missed`, async t => {
    const lastId = mode === "gap" ? 13 : 12;
    const f = fixture({
      requestResponse: () => snapshot([101, 102], [post(1)], lastId),
      postsResponse: ids => ids.map(id => post(id - 100, id === 102 ? "<p>RECOVERED_ON_SERVER</p>" : `<p>${id - 100}</p>`))
    });
    t.after(() => f.session.stop());
    await f.session.start();
    topic(f, 2, "deleted", 11);
    assert.equal(f.detail.posts.get(102).deleted, true);
    assert.equal(f.detail.stream.includes(102), false);
    // The server recovered message 12, but our selected-topic callback missed it.
    if (mode === "gap") f.event("topic", { type: "stats" }, 13);
    else f.session.refresh();
    await f.clock.advance(20000);

    assert.equal(f.detail.posts.get(102).deleted, false, "fresh authority plus a readable post must permit legitimate recovery");
    assert.equal(f.detail.posts.get(102).cooked, "<p>RECOVERED_ON_SERVER</p>");
    assert.equal(f.detail.stream.includes(102), true);
    assert.equal(f.detail.collapsed.has(2), true);
    assert.equal(f.detail.sort, "top");
    assert.equal(f.calls.filter(value => value.kind === "request").length, 1);
    assert.equal(f.calls.filter(value => value.kind === "posts").flatMap(value => value.ids).filter(id => id === 102).length, 1,
      "probe/recover a deleted floor only once, rather than polling it");
    const count = f.calls.length;
    await f.clock.advance(60000);
    assert.equal(f.calls.length, count);
  });
}

test("a topic snapshot already in flight when deletion arrives cannot authorize stale post resurrection", async t => {
  const pendingSnapshot = deferred();
  const oldSnapshot = snapshot([101, 102], [post(1), post(2, "<p>STALE_BEFORE_DELETE</p>")], 10);
  const f = fixture({ requestResponse: () => pendingSnapshot.promise });
  t.after(() => { pendingSnapshot.resolve(oldSnapshot); f.session.stop(); });
  await f.session.start();
  f.session.refresh();
  await f.clock.advance(0);
  assert.equal(f.calls.filter(value => value.kind === "request").length, 1);
  topic(f, 2, "deleted", 11);
  pendingSnapshot.resolve(oldSnapshot);
  await settle();
  await f.clock.advance(60000);

  const deleted = f.detail.posts.get(102);
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.cooked, undefined, "do not restore stale deleted content from an older snapshot");
  assert.equal(deleted.username, undefined, "deleted identities remain scrubbed");
  assert.equal(f.detail.stream.includes(102), false);
  assert.ok(f.calls.filter(value => value.kind === "posts").every(value => !value.ids.includes(102)),
    "an older in-flight snapshot must not authorize a recovery probe for the deleted post");
  assert.equal(f.calls.filter(value => value.kind === "request").length, 1, "do not compensate with repeated snapshots");
});

test("a revised historical paging-in-flight id queues one follow-up read after the old page commits", async t => {
  const f = fixture({ postsResponse: ids => ids.map(id => post(id - 100, "<p>EDITED_DURING_HISTORY_GET</p>")) });
  t.after(() => f.session.stop());
  f.detail.stream.push(140);
  f.detail.data.posts_count = 3;
  await f.session.start();
  f.detail.moreBusy = true;
  f.detail.loadingIds.add(140);
  topic(f, 40, "revised", 11);
  assert.equal(f.session.hasPending(140), true, "recognize a historical id currently owned by the pager");
  assert.equal(f.calls.length, 0, "live reads must wait for the historical request lane");

  // Match reader.loadReplies' commit/finally sequence without coupling to its DOM fixture.
  f.detail.posts.set(140, post(40, "<p>OLD_PAGER_RESPONSE</p>"));
  f.detail.attempted.add(140);
  f.detail.loadingIds.clear();
  f.detail.moreBusy = false;
  f.session.kick();
  await f.clock.advance(10000);

  assert.equal(f.detail.posts.get(140).cooked, "<p>EDITED_DURING_HISTORY_GET</p>");
  assert.equal(f.calls.filter(value => value.kind === "posts").length, 1);
  assert.deepEqual(f.calls.find(value => value.kind === "posts").ids, [140]);
  assert.equal(f.session.hasPending(140), false);
  await f.clock.advance(60000);
  assert.equal(f.calls.length, 1, "the reconciled historical edit must become idle");
});
