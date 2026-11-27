(() => {
  const requestType = "linux-do-reader:native-request";
  const responseType = "linux-do-reader:native-response";
  const eventType = "linux-do-reader:native-event";
  const id = value => Number.isSafeInteger(value) && value > 0;
  const cursor = value => Number.isSafeInteger(value) && value >= 0;
  const uniqueId = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  // This client never fetches or publishes a reply. The MAIN-world adapter only
  // opens Discourse's own composer and observes its existing MessageBus instance.
  class NativeClient {
    constructor({ window: target = globalThis.window, timeout = 8000 } = {}) {
      this.window = target;
      this.timeout = timeout;
      this.clientId = uniqueId();
      this.pending = new Map();
      this.watchers = new Map();
      this.receive = event => {
        const message = event.data;
        if (event.source !== target || event.origin !== target.location.origin || message?.clientId !== this.clientId) return;
        if (message.type === responseType) {
          const pending = this.pending.get(message.requestId);
          if (!pending) return;
          this.pending.delete(message.requestId);
          clearTimeout(pending.timer);
          if (message.ok) pending.resolve(message.result);
          else {
            const detail = message.error;
            const error = new Error(typeof detail === "string" ? detail : detail?.message || "原站功能暂不可用。");
            if (detail && typeof detail === "object") Object.assign(error, detail);
            pending.reject(error);
          }
        } else if (message.type === eventType && ["topic", "presence", "saved"].includes(message.kind)) {
          this.watchers.get(message.watchId)?.(message.kind, message.data, message.messageId);
        }
      };
      target.addEventListener("message", this.receive);
    }

    send(action, payload, requestId) {
      this.window.postMessage({ type: requestType, clientId: this.clientId, requestId, action, payload }, this.window.location.origin);
    }

    request(action, payload = {}) {
      if (this.closed || this.window.location.pathname !== "/") return Promise.reject(new Error("阅读器仅在 Linux.do 首页启用。"));
      const requestId = uniqueId();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(requestId);
          reject(new Error("原站功能尚未就绪，请重试或在原站打开话题。"));
        }, this.timeout);
        this.pending.set(requestId, { resolve, reject, timer });
        try { this.send(action, payload, requestId); }
        catch (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error); }
      });
    }

    context() { return this.request("context"); }
    reply(topic, post) { return this.request("reply", { topic, post: post || null }); }

    watch(topicId, { topicLastId, presenceLastId = -1 } = {}, listener) {
      const watchId = uniqueId();
      this.watchers.set(watchId, listener);
      const ready = this.request("watch", { watchId, topicId, topicLastId, presenceLastId }).catch(error => {
        this.unwatch(watchId);
        throw error;
      });
      return { watchId, ready };
    }

    unwatch(watchId, topicId) {
      const owned = this.watchers.delete(watchId);
      if (!owned && !id(topicId)) return;
      // The subscription may have failed before registering. Explicit topic
      // cleanup must still cancel only this client's corresponding pending draft.
      const payload = { watchId };
      if (id(topicId)) payload.topicId = topicId;
      this.send("unwatch", payload);
    }

    close() {
      if (this.closed) return;
      for (const watchId of this.watchers.keys()) this.unwatch(watchId);
      this.send("dispose", {});
      this.closed = true;
      this.window.removeEventListener("message", this.receive);
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new DOMException("Reader closed", "AbortError"));
      }
      this.pending.clear();
    }
  }

  // One selected topic, one event-driven, paced incremental reader. No polling,
  // native presence retries, view/timing writes, or automatic write replays.
  class TopicSession {
    constructor({ client, forum, detail, isVisible = () => true, currentUserId, presenceEnabled = true,
      onChange = () => {}, onStatus = () => {}, now = () => Date.now(),
      // Browser timer functions brand-check their receiver. Never store a raw
      // Window method and then invoke it with a TopicSession as `this`.
      setTimer = (...args) => globalThis.setTimeout(...args), clearTimer = (...args) => globalThis.clearTimeout(...args),
      interval = 5000, debounce = 1000 } = {}) {
      Object.assign(this, { client, forum, detail, isVisible, currentUserId, presenceEnabled, onChange, onStatus,
        now, setTimer, clearTimer, interval, debounce });
      this.controller = new AbortController();
      this.parentAbort = () => this.stop();
      detail.controller.signal.addEventListener("abort", this.parentAbort, { once: true });
      this.pending = new Map();
      this.inFlight = new Set();
      this.tombstones = new Set([...detail.posts.values()].filter(post => post.deleted || post.user_deleted || post.deleted_at).map(post => post.id));
      this.revision = 0;
      this.topicCursor = cursor(detail.data.message_bus_last_id) ? detail.data.message_bus_last_id : null;
      this.deletedAt = new Map([...this.tombstones].map(postId => [postId, { revision: 0, cursor: this.topicCursor }]));
      this.recoveryChecks = new Map();
      this.presence = { users: new Map(), count: 0, cursor: null, usersMode: false };
      this.presenceBuffer = [];
      this.presenceRevision = 0;
      this.lastRead = -Infinity;
      this.phase = "connecting";
    }

    status() {
      const users = [...this.presence.users.values()].filter(user => user.id !== this.currentUserId);
      return { phase: this.phase, busy: !!this.busy, pending: this.pending.size, error: this.error?.message,
        challenge: !!this.error?.challenge, retryAt: this.error?.retryAt || 0, users,
        count: this.presence.usersMode ? users.length : this.presence.count,
        presenceReady: this.presence.cursor !== null && !this.presenceError && !this.presenceNeeded,
        presenceBusy: !!this.readingPresence && this.busy,
        presenceUnavailable: !!this.presenceUnavailable, presenceError: this.presenceError,
        requestSource: this.error?.requestSource };
    }

    emit() { if (!this.stopped) this.onStatus(this.status()); }
    hasPending(postId) { return this.pending.has(postId) || this.inFlight.has(postId); }

    async start() {
      if (this.stopped || this.detail.controller.signal.aborted || this.starting || this.connected) return;
      this.starting = true;
      this.emit();
      try {
        const watch = this.client.watch(this.detail.data.id, { topicLastId: this.topicCursor ?? -1 },
          (...args) => this.receive(...args));
        this.watchId = watch.watchId;
        const result = await watch.ready;
        if (this.stopped) return;
        this.connected = true;
        this.phase = "active";
        this.topicNeeded ||= this.topicCursor === null || !!result?.needsTopicSnapshot;
        this.presenceEnabled = this.presenceEnabled && result?.presenceEnabled !== false;
        this.presenceNeeded = this.presenceEnabled;
        this.presenceUnavailable = !this.presenceEnabled;
        this.kick(0);
        this.emit();
      } catch (error) { if (!this.stopped) this.pause(error); }
      finally { this.starting = false; }
    }

    receive(kind, data, messageId) {
      if (this.stopped || !data || typeof data !== "object") return;
      if (kind === "topic") this.topicEvent(data, messageId);
      else if (kind === "presence" && this.presenceEnabled) this.presenceEvent(data, messageId);
      else if (kind === "saved" && (!data.topic_id || data.topic_id === this.detail.data.id)) {
        if (id(data.id)) this.topicEvent({ ...data, type: data.type === "revised" ? "revised" : "created" });
        else { this.topicNeeded = true; this.kick(); }
      }
    }

    topicEvent(data, messageId) {
      if (cursor(messageId)) {
        if (this.topicCursor !== null && messageId <= this.topicCursor) return;
        if (this.topicCursor !== null && messageId !== this.topicCursor + 1) this.topicNeeded = true;
        this.topicCursor = messageId;
      }
      const { detail } = this;
      const postId = data.id;
      const type = data.type;
      if (type === "reload_topic") this.topicNeeded = true;
      else if (["deleted", "destroyed"].includes(type) && id(postId)) {
        const post = detail.posts.get(postId);
        const existed = detail.stream.includes(postId);
        this.tombstones.add(postId);
        this.deletedAt.set(postId, { revision: ++this.revision, cursor: cursor(messageId) ? messageId : this.topicCursor });
        this.recoveryChecks.delete(postId);
        this.pending.delete(postId);
        detail.stream = detail.stream.filter(value => value !== postId);
        if (post) detail.posts.set(postId, this.placeholder(post, true));
        if (existed) detail.data.posts_count = Math.max(0, (Number(detail.data.posts_count) || detail.posts.size) - 1);
        this.onChange({ opChanged: post?.post_number === 1 });
      } else if (["created", "revised", "rebaked", "recovered"].includes(type) && id(postId)) {
        const fresh = !detail.stream.includes(postId);
        if (type === "recovered") this.restorePost(postId);
        if ((!this.tombstones.has(postId) || this.canRecover(postId)) &&
            (((type === "created" || type === "recovered") && fresh) ||
             (type === "created" && !detail.posts.has(postId) && !detail.attempted.has(postId) && !this.pending.has(postId)) ||
             (type !== "created" && (detail.posts.has(postId) || this.pending.has(postId) || detail.loadingIds?.has(postId))))) {
          if (fresh) {
            detail.stream.push(postId);
            detail.data.posts_count = (Number(detail.data.posts_count) || detail.posts.size) + 1;
          }
          this.pending.set(postId, ++this.revision);
          detail.attempted.delete(postId);
          this.onChange({ opChanged: false });
        }
      }
      // stats, liked, acted, read, and unknown messages do not cause a GET.
      this.kick();
      this.emit();
    }

    bufferPresence(data, messageId) {
      this.presenceBuffer.push({ data, messageId });
      if (this.presenceBuffer.length > 200) this.presenceBuffer.splice(0, this.presenceBuffer.length - 200);
    }

    presenceEvent(data, messageId) {
      if (!cursor(messageId)) {
        // Without channel sequence numbers no delta can be reconciled safely.
        // Keep the one initial snapshot, but do not turn each such event into
        // another /presence/get request. Explicit refresh may read it once.
        this.presenceUnsequenced = true;
        if (this.presence.cursor !== null) {
          if (!this.presenceManual && !this.manual) this.presenceNeeded = false;
          this.presenceError = "正在回复状态缺少消息序号，可手动更新。";
          this.emit();
        }
        return;
      }
      if (this.presence.cursor !== null && messageId <= this.presence.cursor) {
        // A null response can start a new channel epoch at zero. Until this GET
        // resolves, retain low ids too; ordinary snapshots still discard them.
        if (this.readingPresence) this.bufferPresence(data, messageId);
        return;
      }
      if (this.presence.cursor === null || messageId !== this.presence.cursor + 1 || this.presenceError) {
        this.bufferPresence(data, messageId);
        this.presenceNeeded ||= !this.presenceError;
        this.kick();
        return;
      }
      this.applyPresence(data, messageId);
      this.emit();
    }

    applyPresence(data, messageId) {
      this.presenceRevision++;
      if (this.presence.usersMode) {
        for (const user of data.entering_users || []) if (id(user?.id)) this.presence.users.set(user.id, user);
        for (const userId of data.leaving_user_ids || []) this.presence.users.delete(userId);
        this.presence.count = this.presence.users.size;
      } else if (Number.isFinite(data.count_delta)) this.presence.count = Math.max(0, this.presence.count + data.count_delta);
      this.presence.cursor = messageId;
    }

    kick(delay = this.debounce) {
      if (this.stopped || !this.connected || this.error || !this.isVisible() || this.busy || this.detail.moreBusy || this.timer !== undefined ||
          !(this.topicNeeded || this.presenceNeeded || this.pending.size)) return;
      const wait = Math.max(delay, this.lastRead + this.interval - this.now(), 0);
      this.timer = this.setTimer(() => { this.timer = undefined; void this.flush(); }, wait);
    }

    pause(error) {
      if (this.timer !== undefined) this.clearTimer(this.timer);
      this.timer = undefined;
      this.error = error;
      if (!error.challenge) this.error.retryAt ||= this.now() + (error.retryAfter || 0);
      else this.error.retryAt = 0;
      this.phase = "paused";
      this.emit();
    }

    nextOperation() {
      if (this.presenceNeeded && (this.presence.cursor === null || this.presenceManual)) return "正在回复状态";
      if (this.topicNeeded) return "实时话题补读";
      if (this.pending.size) return "实时楼层更新";
      if (this.presenceNeeded) return "正在回复状态";
      return "实时更新";
    }

    async flush() {
      if (this.stopped || this.error || !this.isVisible() || this.busy || this.detail.moreBusy) return;
      const operation = this.nextOperation();
      if (this.forum.requestQueue.cooldown()) { this.pause(this.forum.requestQueue.busyError(operation)); return; }
      if (this.forum.requestQueue.activeChallenge?.()) { this.pause(this.forum.requestQueue.challengeError(operation)); return; }
      this.busy = true;
      this.readingPresence = operation === "正在回复状态";
      this.lastRead = this.now();
      this.emit();
      try {
        if (this.readingPresence) await this.readPresence();
        else if (this.topicNeeded) await this.readTopic();
        else if (this.pending.size) await this.readPosts();
      } catch (error) {
        if (!this.stopped && error.name !== "AbortError") {
          const waiting = error.challenge || !!this.forum.requestQueue.activeChallenge?.() ||
            error.status === 429 || this.forum.requestQueue.cooldown() > 0 ||
            error.retryAt > this.now() || Number.isFinite(error.retryAfter) && error.retryAfter > 0;
          if (this.readingPresence && !waiting) {
            this.presenceNeeded = false;
            this.presenceError = error.message;
            if ([401, 403, 404].includes(error.status)) {
              this.presenceUnavailable = true;
              this.presenceEnabled = false;
              this.presenceBuffer = [];
            }
          } else this.pause(error);
        }
      } finally {
        if (this.readingPresence) this.presenceManual = false;
        this.readingPresence = false;
        // The shared lane may delay the real HTTP start. Pace from completion,
        // not enqueue time, so foreground traffic cannot compress live batches.
        this.lastRead = this.now();
        this.busy = false;
        if (!this.stopped) {
          if (!(this.topicNeeded || this.presenceNeeded || this.pending.size)) this.manual = false;
          this.emit();
          this.kick();
        }
      }
    }

    options(requestSource) {
      const manual = this.manual || requestSource === "正在回复状态" && this.presenceManual;
      return { signal: this.controller.signal, background: !manual, priority: manual ? 0 : 2, requestSource };
    }
    placeholder(post, deleted = false) {
      // Scrub stale identities and bodies immediately. Descendants retain the
      // real floor and ancestry; absence alone never proves a deletion.
      return { id: post.id, post_number: post.post_number, reply_to_post_number: post.reply_to_post_number,
        created_at: post.created_at, ...(deleted ? { deleted: true } : { unavailable: true }) };
    }

    canRecover(postId) {
      return this.recoveryChecks.has(postId) && this.recoveryChecks.get(postId) === this.deletedAt.get(postId)?.revision;
    }
    restorePost(postId) {
      const deleted = this.tombstones.delete(postId);
      this.deletedAt.delete(postId);
      this.recoveryChecks.delete(postId);
      return deleted;
    }
    available(post) {
      return !post.deleted && !post.user_deleted && !post.deleted_at && !post.hidden && !post.unavailable &&
        !post.unloaded && typeof post.cooked === "string";
    }

    async readPosts() {
      const { detail } = this;
      const batch = [...this.pending].filter(([postId]) => !this.tombstones.has(postId) || this.canRecover(postId))
        .slice(0, Math.max(1, Math.min(Number(detail.data.chunk_size) || 20, 30)));
      if (!batch.length) { this.pending.clear(); return; }
      const ids = batch.map(([postId]) => postId);
      for (const postId of ids) this.inFlight.add(postId);
      try {
        const posts = await this.forum.postsPage(detail.data.id, ids, this.controller.signal, this.options("实时楼层更新"));
        if (this.stopped) return;
        const returned = new Set();
        let opChanged = false;
        for (const post of posts) {
          if (!ids.includes(post.id) || !id(post.post_number) || post.topic_id && post.topic_id !== detail.data.id) continue;
          if (this.tombstones.has(post.id)) {
            if (!this.canRecover(post.id) || !this.available(post)) continue;
            this.restorePost(post.id);
            if (!detail.stream.includes(post.id)) {
              detail.stream.push(post.id);
              detail.data.posts_count = (Number(detail.data.posts_count) || 0) + 1;
            }
          }
          detail.posts.set(post.id, post);
          returned.add(post.id);
          opChanged ||= post.post_number === 1;
        }
        for (const [postId, revision] of batch) {
          detail.attempted.add(postId);
          if (this.pending.get(postId) === revision) {
            this.pending.delete(postId);
            this.recoveryChecks.delete(postId);
          }
          if (!returned.has(postId) && !this.tombstones.has(postId) && detail.posts.has(postId)) {
            const previous = detail.posts.get(postId);
            opChanged ||= previous.post_number === 1;
            detail.posts.set(postId, this.placeholder(previous));
          }
        }
        this.onChange({ opChanged });
      } finally { for (const postId of ids) this.inFlight.delete(postId); }
    }

    async readTopic() {
      const { detail } = this;
      const revision = this.revision;
      this.topicNeeded = false;
      const snapshot = await this.forum.request(`/t/${detail.data.id}.json`, this.options("实时话题补读"));
      if (this.stopped) return;
      if (snapshot.id !== detail.data.id || !Array.isArray(snapshot.post_stream?.stream) || !Array.isArray(snapshot.post_stream?.posts)) throw new Error("原站未返回有效的话题更新，请重试。");
      const before = new Set(detail.stream);
      const serverStream = [...new Set(snapshot.post_stream.stream.filter(id))];
      const snapshotCursor = cursor(snapshot.message_bus_last_id) ? snapshot.message_bus_last_id : null;
      // A fresh authoritative stream may prove that a recovery event was lost.
      // Probe only deletions predating this request; old in-flight responses can
      // never remove a newer tombstone. A body must also be available to restore.
      for (const postId of this.tombstones) {
        const deletion = this.deletedAt.get(postId);
        if (!serverStream.includes(postId) || !deletion || deletion.revision > revision || snapshotCursor === null ||
            deletion.cursor !== null && snapshotCursor <= deletion.cursor) continue;
        this.recoveryChecks.set(postId, deletion.revision);
        if (!this.pending.has(postId)) this.pending.set(postId, ++this.revision);
      }
      const stream = serverStream.filter(postId => !this.tombstones.has(postId));
      // Preserve events received after the snapshot request started; never let an
      // older response revive a deleted post or discard a just-created reply.
      const extra = [...this.pending].filter(([postId, version]) => version > revision && !stream.includes(postId) && !this.tombstones.has(postId)).map(([postId]) => postId);
      for (const postId of stream) if (!before.has(postId) && !this.pending.has(postId)) this.pending.set(postId, ++this.revision);
      for (const [postId, post] of detail.posts) if (!stream.includes(postId) && !extra.includes(postId) && !this.tombstones.has(postId)) detail.posts.set(postId, this.placeholder(post));
      const returned = new Set();
      for (const post of snapshot.post_stream.posts) {
        if (!id(post.id) || !id(post.post_number) || post.topic_id && post.topic_id !== detail.data.id) continue;
        let restored = false;
        if (this.tombstones.has(post.id)) {
          if (!this.canRecover(post.id) || !this.available(post)) continue;
          restored = this.restorePost(post.id);
          if (!stream.includes(post.id)) stream.push(post.id);
        }
        if (!restored && (this.pending.get(post.id) || 0) > revision && before.has(post.id)) continue;
        detail.posts.set(post.id, post);
        detail.attempted.add(post.id);
        this.pending.delete(post.id);
        returned.add(post.id);
      }
      detail.stream = [...new Set([...stream, ...extra])];
      const currentIds = new Set(detail.stream);
      // A gap may hide an edit to any already-loaded floor, not only the first
      // JSON page. Recheck those missing bodies once through the paced lane.
      for (const postId of detail.posts.keys()) {
        if (!currentIds.has(postId) || returned.has(postId) || this.tombstones.has(postId) || this.pending.has(postId)) continue;
        this.pending.set(postId, ++this.revision);
        detail.attempted.delete(postId);
      }
      Object.assign(detail.data, snapshot);
      const deletedCount = serverStream.filter(postId => this.tombstones.has(postId)).length;
      detail.data.posts_count = Math.max(0, (Number(snapshot.posts_count) || serverStream.length) - deletedCount) + extra.length;
      if (snapshotCursor !== null) this.topicCursor = Math.max(this.topicCursor ?? 0, snapshotCursor);
      this.onChange({ opChanged: true });
    }

    async readPresence() {
      const name = `/discourse-presence/reply/${this.detail.data.id}`;
      const query = new URLSearchParams();
      query.append("channels[]", name);
      const revision = this.presenceRevision;
      const response = await this.forum.request(`/presence/get.json?${query}`, this.options("正在回复状态"));
      if (this.stopped) return;
      const snapshot = response?.[name];
      this.presenceNeeded = false;
      if (snapshot === null) {
        this.presenceError = null;
        this.presenceUnavailable = true;
        this.presenceEnabled = false;
        this.presence = { users: new Map(), count: 0, cursor: null, usersMode: false };
        this.presenceBuffer = [];
        return;
      }
      if (!snapshot || !(cursor(snapshot.last_message_id) || snapshot.last_message_id === null) || !Number.isSafeInteger(snapshot.count) || snapshot.count < 0 ||
          snapshot.users != null && !Array.isArray(snapshot.users)) throw new Error("原站未返回有效的正在回复状态，请重试。");
      this.presenceUnavailable = false;
      this.presenceError = null;
      // Continuous deltas may have advanced the state during this GET. Never
      // roll their cursor/users back to an older manual/recovery snapshot.
      // Discourse serializes an absent MessageBus backlog id as null. Its native
      // client uses null + 1 === 1 for the first delta: normalize only explicit
      // null, never a missing field/-1, and preserve the snapshot's real users.
      const lastId = snapshot.last_message_id === null ? 0 : snapshot.last_message_id;
      const freshReset = snapshot.last_message_id === null && revision === this.presenceRevision;
      if (this.presence.cursor === null || freshReset || lastId >= this.presence.cursor) {
        this.presence = { cursor: lastId, count: snapshot.count, usersMode: Array.isArray(snapshot.users),
          users: new Map((snapshot.users || []).filter(user => id(user?.id)).map(user => [user.id, user])) };
      }
      const buffered = this.presenceBuffer.sort((a, b) => a.messageId - b.messageId);
      this.presenceBuffer = [];
      for (const { data, messageId } of buffered) {
        if (messageId <= this.presence.cursor) continue;
        if (messageId !== this.presence.cursor + 1) {
          // A stale/partial snapshot cannot turn into a 5-second retry loop.
          this.presenceError = "正在回复状态暂未同步，可手动更新。";
          break;
        }
        this.applyPresence(data, messageId);
      }
      if (this.presenceUnsequenced) this.presenceError = "正在回复状态缺少消息序号，可手动更新。";
      this.emit();
    }

    refreshPresence() {
      if (this.stopped || !this.connected || !this.presenceEnabled || this.presenceUnavailable ||
          this.error || this.presenceManual || this.readingPresence) return false;
      if (this.forum.requestQueue.cooldown()) {
        this.pause(this.forum.requestQueue.busyError("正在回复状态"));
        return false;
      }
      if (this.forum.requestQueue.activeChallenge?.()) {
        this.pause(this.forum.requestQueue.challengeError("正在回复状态"));
        return false;
      }
      this.presenceManual = true;
      this.presenceNeeded = true;
      this.kick(0);
      this.emit();
      return true;
    }

    refresh() {
      if (this.stopped) return;
      if (this.forum.requestQueue.cooldown()) { this.pause(this.forum.requestQueue.busyError("实时更新")); return; }
      if (this.forum.requestQueue.activeChallenge?.()) { this.pause(this.forum.requestQueue.challengeError("实时更新")); return; }
      if (this.error?.retryAt > this.now()) return;
      this.error = null;
      this.presenceError = null;
      this.phase = this.connected ? "active" : "connecting";
      this.topicNeeded = true;
      this.presenceNeeded = this.presenceEnabled;
      this.manual = true;
      if (!this.connected) { void this.start(); return; }
      if (this.timer !== undefined) this.clearTimer(this.timer);
      this.timer = undefined;
      this.kick(0);
      this.emit();
    }

    visibilityChanged() {
      if (!this.isVisible()) {
        if (this.timer !== undefined) this.clearTimer(this.timer);
        this.timer = undefined;
      } else this.kick(0);
    }

    stop() {
      if (this.stopped) return;
      this.stopped = true;
      if (this.timer !== undefined) this.clearTimer(this.timer);
      this.timer = undefined;
      this.controller.abort();
      this.detail.controller.signal.removeEventListener("abort", this.parentAbort);
      if (this.watchId) this.client.unwatch(this.watchId, this.detail.data.id);
      this.pending.clear();
      this.inFlight.clear();
      this.presenceBuffer = [];
    }
  }

  globalThis.LDLive = Object.freeze({ NativeClient, TopicSession });
})();
