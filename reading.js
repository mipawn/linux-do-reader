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

  class Tracker {
    constructor({ send, visit, acknowledge, now = () => performance.now() }) {
      Object.assign(this, { send, visit, acknowledge, now });
      this.sessions = new Set();
      this.current = null;
      this.lastTick = now();
    }

    start(topicId) {
      if (this.current?.topicId === topicId) return;
      this.stop();
      this.current = { topicId, topicTime: 0, timings: {}, totals: {}, visited: false, visitRetryAt: 0, sending: new Set(), retryAt: 0 };
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
      const firstSeen = credited.some(floor => !session.totals[floor]);
      session.topicTime += elapsed;
      for (const floor of credited) {
        const time = Math.min(elapsed, 360000 - (session.totals[floor] || 0));
        session.totals[floor] = (session.totals[floor] || 0) + time;
        session.timings[floor] = (session.timings[floor] || 0) + time;
      }
      if (!session.visited && now >= session.visitRetryAt) {
        session.visited = true;
        Promise.resolve().then(() => this.visit(session.topicId)).catch(() => {
          session.visited = false;
          session.visitRetryAt = this.now() + 30000;
        });
      }
      if (firstSeen) void this.flush();
    }

    stop() {
      const previous = this.current;
      this.current = null;
      this.resetClock();
      if (previous) void this.flush();
    }

    async flush({ force = false } = {}) {
      await Promise.all([...this.sessions].map(async session => {
        if (session.sending.size && !force || session.retryAt > this.now() && !force) return;
        if (!session.topicTime) {
          if (this.current !== session && !session.sending.size) this.sessions.delete(session);
          return;
        }
        const time = Math.min(60000, session.topicTime);
        const fraction = time / session.topicTime;
        const timings = Object.fromEntries(Object.entries(session.timings).map(([floor, pending]) => [floor, Math.floor(pending * fraction)]).filter(([, value]) => value > 0));
        const batch = { topic_id: session.topicId, topic_time: time, timings };
        session.topicTime -= time;
        for (const [floor, sent] of Object.entries(timings)) {
          session.timings[floor] -= sent;
          if (!session.timings[floor]) delete session.timings[floor];
        }
        const sending = Promise.resolve().then(() => this.send(batch));
        session.sending.add(sending);
        try {
          await sending;
          session.retryAt = 0;
          this.acknowledge(session.topicId, Object.keys(batch.timings).map(Number));
        } catch {
          // Retain all unacknowledged milliseconds. The one-minute server
          // limit applies to each outgoing batch, not to the retry backlog.
          session.topicTime += batch.topic_time;
          for (const [floor, time] of Object.entries(batch.timings)) {
            session.timings[floor] = (session.timings[floor] || 0) + time;
          }
          session.retryAt = this.now() + 30000;
        } finally {
          session.sending.delete(sending);
          if (!session.topicTime && this.current !== session && !session.sending.size) this.sessions.delete(session);
          // A topic switch can happen while its previous batch is in flight.
          if (this.current !== session && session.topicTime && !session.retryAt) void this.flush();
        }
      }));
    }
  }

  globalThis.LDReading = { readerRoute, feedRoute, visiblePosts, Tracker };
})();
