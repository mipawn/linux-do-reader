(() => {
  // Only forum browsing routes get the automatic overlay. Account, composer and
  // administration pages must remain usable in the native application.
  function readerRoute(path) {
    return /^\/$/.test(path) ||
      /^\/(latest|new|unseen|unread|hot|top|posted|read|bookmarks)(\/|$)/.test(path) ||
      /^\/(t|c|tag)\//.test(path);
  }

  function feedRoute(pathname, search = "") {
    const parts = pathname.split("/").filter(Boolean);
    const view = ["latest", "new", "unseen", "hot", "top", "posted", "read", "bookmarks"].includes(parts[0]) ? parts[0] : "latest";
    const params = new URLSearchParams(search);
    let path = pathname === "/" ? "/latest" : pathname.replace(/\/$/, "");
    if (parts[0] === "top" && parts[1]) {
      path = "/top";
      params.set("period", parts[1]);
    }
    const route = { view, path: path + ".json" + (params.size ? "?" + params : "") };
    if (parts[0] === "c") {
      const index = parts.findIndex((part, i) => i > 0 && /^\d+$/.test(part));
      if (index > 1) Object.assign(route, { categoryId: Number(parts[index]), categorySlug: parts[index - 1] });
    }
    if (parts[0] === "tag" && parts[1]) Object.assign(route, { tagSlug: decodeURIComponent(parts[1]), tagId: /^\d+$/.test(parts[2] || "") ? Number(parts[2]) : undefined });
    return route;
  }

  function visiblePosts(root, viewport) {
    const bounds = viewport.getBoundingClientRect();
    const top = Math.max(0, bounds.top), bottom = Math.min(innerHeight, bounds.bottom);
    const left = Math.max(0, bounds.left), right = Math.min(innerWidth, bounds.right);
    if (bottom <= top || right <= left) return [];
    return [...root.querySelectorAll('[data-post-number]')].filter(node => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.bottom > top && rect.top < bottom && rect.right > left && rect.left < right;
    }).map(node => Number(node.dataset.postNumber));
  }

  // Keep the server's unread-reply distinction: reading an untracked new topic
  // must not invent a badge for every remaining floor. Only advance known state.
  function markRead(topic, lastRead) {
    if (!Number.isSafeInteger(lastRead) || lastRead <= 0) return false;
    const previous = topic.last_read_post_number || 0;
    const next = Math.max(previous, lastRead);
    const changed = topic.unseen !== false || next !== previous;
    topic.unseen = false;
    topic.last_read_post_number = next;
    if (typeof topic.unread_posts === "number") {
      topic.unread_posts = Math.max(0, topic.unread_posts - (next - previous));
    }
    return changed;
  }

  class Tracker {
    constructor({ send, visit, acknowledge, report = () => {}, now = () => performance.now(), interval = 30000, enabled = true }) {
      Object.assign(this, { send, visit, acknowledge, report, now, interval, enabled });
      this.sessions = new Set();
      this.current = null;
      this.lastTick = now();
      this.nextFlushAt = now() + interval;
      this.flushing = false;
      this.generation = 0;
    }

    setEnabled(enabled) {
      if (this.enabled === enabled) return;
      this.enabled = enabled;
      this.generation++;
      this.sessions.clear();
      this.current = null;
      this.nextFlushAt = Math.max(this.nextFlushAt, this.now() + this.interval);
      this.resetClock();
      // An already accepted HTTP request cannot be undone, but disabling must
      // discard unsent time and must not acknowledge or retry a late response.
    }

    start(topicId) {
      if (!this.enabled || this.current?.topicId === topicId) return;
      this.stop();
      this.current = [...this.sessions].find(session => session.topicId === topicId) ||
        { topicId, topicTime: 0, timings: {}, totals: {}, visited: false, visitRetryAt: 0, retryAt: 0 };
      this.sessions.add(this.current);
      this.resetClock();
    }

    resetClock() {
      this.lastTick = this.now();
      this.previousFloors = new Set();
    }

    sample(floors, active) {
      const now = this.now(), elapsed = Math.floor(now - this.lastTick);
      this.lastTick = now;
      const session = this.current;
      const visible = new Set(active ? floors.filter(floor => Number.isSafeInteger(floor) && floor > 0) : []);
      const previous = this.previousFloors || new Set();
      this.previousFloors = visible;
      // Count only floors visible at BOTH ends of the interval. A post that
      // appeared immediately before this tick has not been read for a second.
      // A stalled timer (sleep or throttling) is not time spent reading either.
      if (!session || !active || elapsed <= 0 || elapsed > 2000) return;
      const credited = [...visible].filter(floor => previous.has(floor) && (session.totals[floor] || 0) < 360000);
      if (!credited.length) return;
      session.topicTime += elapsed;
      for (const floor of credited) {
        const time = Math.min(elapsed, 360000 - (session.totals[floor] || 0));
        session.totals[floor] = (session.totals[floor] || 0) + time;
        session.timings[floor] = (session.timings[floor] || 0) + time;
      }
      if (!session.visited && now >= session.visitRetryAt) {
        session.visited = true;
        const generation = this.generation;
        Promise.resolve().then(() => {
          if (this.enabled && generation === this.generation) return this.visit(session.topicId);
        }).catch(() => {
          session.visited = false;
          session.visitRetryAt = this.now() + 30000;
        });
      }
      // New floors only add to the batch; scrolling never triggers a POST.
    }

    stop() {
      const previous = this.current;
      this.current = null;
      this.resetClock();
      if (previous) void this.flush();
    }

    notify(status) {
      // A UI observer must never turn an accepted request into a retry.
      try { this.report(status); } catch {}
    }

    async flush() {
      // Lifecycle events must not open another lane or bypass server backoff.
      if (!this.enabled || this.flushing || this.now() < this.nextFlushAt) return;
      for (const session of this.sessions) {
        if (!session.topicTime && this.current !== session) this.sessions.delete(session);
      }
      const session = [...this.sessions].find(session => session.topicTime && session.retryAt <= this.now());
      if (!session) return;
      const generation = this.generation;
      const time = Math.min(60000, session.topicTime);
      const fraction = time / session.topicTime;
      const timings = Object.fromEntries(Object.entries(session.timings).map(([floor, pending]) => [floor, Math.floor(pending * fraction)]).filter(([, value]) => value > 0));
      const batch = { topic_id: session.topicId, topic_time: time, timings };
      session.topicTime -= time;
      for (const [floor, sent] of Object.entries(timings)) {
        session.timings[floor] -= sent;
        if (!session.timings[floor]) delete session.timings[floor];
      }
      const floors = Object.keys(batch.timings).map(Number);
      this.flushing = true;
      this.nextFlushAt = this.now() + this.interval;
      this.notify({ topicId: session.topicId, phase: "sending", floors });
      try {
        await this.send(batch);
        if (generation !== this.generation) return;
        session.retryAt = 0;
        try { this.acknowledge(session.topicId, floors); } catch {}
        this.notify({ topicId: session.topicId, phase: "synced", floors });
      } catch (error) {
        if (generation !== this.generation) return;
        // Retain unacknowledged time, but do not let switches/blur/pagehide
        // override either the server's deadline or the tracker cadence.
        session.topicTime += batch.topic_time;
        for (const [floor, time] of Object.entries(batch.timings)) {
          session.timings[floor] = (session.timings[floor] || 0) + time;
        }
        session.retryAt = this.now() + Math.max(30000, error?.retryAfter || 0);
        this.nextFlushAt = Math.max(this.nextFlushAt, session.retryAt);
        this.notify({ topicId: session.topicId, phase: error?.status === 429 ? "paused" : "failed", floors });
      } finally {
        this.flushing = false;
        if (!session.topicTime && this.current !== session) this.sessions.delete(session);
      }
    }
  }

  globalThis.LDReading = { readerRoute, feedRoute, visiblePosts, markRead, Tracker };
})();
