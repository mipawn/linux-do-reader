// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mipawn
(() => {
  class Pager {
    constructor({ viewport, canLoad, getKey, load, getSentinel, onStateChange,
      threshold = 300, noProgressLimit = 3, autoLoadLimit = Infinity, now = () => Date.now() } = {}) {
      if (!viewport?.addEventListener || !viewport?.getBoundingClientRect ||
          [canLoad, getKey, load].some(callback => typeof callback !== "function")) {
        throw new TypeError("Pager requires a viewport and canLoad/getKey/load callbacks.");
      }
      if (!Number.isFinite(threshold) || threshold < 0 || !Number.isSafeInteger(noProgressLimit) || noProgressLimit < 1 ||
          getSentinel != null && typeof getSentinel !== "function" ||
          !(autoLoadLimit === Infinity || Number.isSafeInteger(autoLoadLimit) && autoLoadLimit >= 1) ||
          onStateChange != null && typeof onStateChange !== "function" || typeof now !== "function") {
        throw new TypeError("Pager requires valid callbacks, threshold and noProgressLimit.");
      }
      Object.assign(this, { viewport, canLoad, getKey, load, getSentinel, onStateChange, threshold, noProgressLimit, autoLoadLimit, now });
      this.window = viewport.ownerDocument?.defaultView || globalThis.window;
      this.document = viewport.ownerDocument || this.window.document;
      this.frame = null;
      this.pending = null;
      this.attempted = new Set();
      this.epoch = 0;
      this.destroyed = false;
      this.paused = false;
      this.noProgress = 0;
      this.onlineRetries = 0;
      this.state = { status: "idle", reason: null, error: null, retryAfter: 0, retryAt: 0 };
      this.sentinel = null;
      this.intersecting = false;
      this.autoLoads = 0;
      this.captureScrollPosition();
      this.onChange = () => this.check();
      this.onScroll = () => {
        const position = Number(this.viewport.scrollTop) || 0;
        if (Math.abs(position - this.scrollPosition) >= 1) this.autoLoads = 0;
        this.scrollPosition = position;
        this.check();
      };
      this.onOnline = () => {
        // One online transition may recover a transient failure. Repeated online
        // events cannot become an unbounded error/retry loop.
        if (this.state.status === "error" && this.state.error?.recoverable &&
            this.state.retryAt <= this.now() && this.onlineRetries < 1) {
          this.onlineRetries++;
          this.recover(false);
        }
      };
      viewport.addEventListener("scroll", this.onScroll, { passive: true });
      this.window.addEventListener("resize", this.onChange);
      this.window.addEventListener("online", this.onOnline);
      this.document?.addEventListener("visibilitychange", this.onChange);
      if (getSentinel && this.window.IntersectionObserver) {
        try {
          this.observer = new this.window.IntersectionObserver(entries => {
            for (const entry of entries) {
              // Ignore notifications queued by an old, replaced DOM node.
              if (entry.target !== this.sentinel) continue;
              this.intersecting = entry.isIntersecting;
              this.check();
            }
          }, { root: viewport, rootMargin: `${threshold}px 0px`, threshold: 0 });
        } catch { /* Unsupported observers fall back to geometry/scroll. */ }
      }
      // Re-resolve the callback after DOM replacement even without a scroll.
      if (getSentinel && this.window.MutationObserver) {
        try {
          this.mutations = new this.window.MutationObserver(this.onChange);
          this.mutations.observe(viewport, { childList: true, subtree: true });
        } catch { this.mutations?.disconnect(); this.mutations = null; }
      }
      if (this.window.ResizeObserver) {
        try {
          this.resizes = new this.window.ResizeObserver(this.onChange);
          this.resizes.observe(viewport);
        } catch { this.resizes?.disconnect(); this.resizes = null; }
      }
      this.check();
    }

    // Layout/anchor restoration is not a new request to keep reading. Callers
    // synchronize the position before its asynchronous scroll event is delivered.
    captureScrollPosition() { this.scrollPosition = Number(this.viewport.scrollTop) || 0; }
    consumeAutoBudget() { this.autoLoads++; }

    // Coalesce observer, scroll, resize and explicit render notifications.
    check() {
      if (this.destroyed || this.frame !== null) return;
      this.frame = this.window.requestAnimationFrame(() => {
        this.frame = null;
        this.run();
      });
    }

    setState(status, { reason = null, error = null, retryAt = 0 } = {}) {
      if (this.state.status === status && this.state.reason === reason &&
          this.state.error === error && this.state.retryAt === retryAt) return;
      this.state = { status, reason, error, retryAt, retryAfter: Math.max(0, retryAt - this.now()) };
      // A rendering callback must not strand the cursor or its single-flight slot.
      try { this.onStateChange?.(this.state); } catch { /* State remains inspectable. */ }
    }

    bindSentinel() {
      let next = this.getSentinel?.() || null;
      if (next && (next.isConnected === false || this.viewport.contains && !this.viewport.contains(next))) next = null;
      if (next === this.sentinel) return;
      if (this.sentinel) {
        this.observer?.unobserve(this.sentinel);
        this.resizes?.unobserve(this.sentinel);
      }
      this.sentinel = next;
      this.intersecting = false;
      if (next) {
        try { this.observer?.observe(next); }
        catch { this.observer?.disconnect(); this.observer = null; }
        try { this.resizes?.observe(next); } catch { /* Geometry remains available. */ }
      }
    }

    visible() {
      const viewport = this.viewport;
      if (this.document?.hidden || viewport.hidden || viewport.isConnected === false ||
          !(viewport.clientWidth > 0 && viewport.clientHeight > 0)) return false;
      const rect = viewport.getBoundingClientRect();
      if (!(rect.width > 0 && rect.height > 0)) return false;
      const style = this.window.getComputedStyle?.(viewport);
      if (style && (style.display === "none" || style.visibility === "hidden" ||
          style.visibility === "collapse" || style.contentVisibility === "hidden" || style.opacity === "0")) return false;
      if (this.window.innerHeight > 0 && (rect.bottom <= 0 || rect.top >= this.window.innerHeight)) return false;
      if (this.window.innerWidth > 0 && (rect.right <= 0 || rect.left >= this.window.innerWidth)) return false;
      return true;
    }

    nearEnd() {
      if (this.sentinel?.getBoundingClientRect) {
        const rect = this.sentinel.getBoundingClientRect(), root = this.viewport.getBoundingClientRect();
        const near = rect.top <= root.bottom + this.threshold && rect.bottom >= root.top - this.threshold;
        // Recheck current geometry: an old intersecting=true must not fetch more
        // after newly appended content moved the sentinel outside the margin.
        return near && (!this.observer || this.intersecting);
      }
      const remaining = this.viewport.scrollHeight - this.viewport.clientHeight - this.viewport.scrollTop;
      return Number.isFinite(remaining) && remaining <= this.threshold;
    }

    validKey(key) {
      return key != null && key !== "" && typeof key !== "object" && typeof key !== "function" &&
        !(typeof key === "number" && !Number.isFinite(key));
    }

    run() {
      if (this.destroyed) return;
      this.bindSentinel();
      if (this.pending) return;
      const key = this.getKey();
      if (this.state.status === "error") {
        // An external successful action/dataset change may have advanced a cursor.
        if (key === this.failedKey) return;
        this.setState("idle");
      }
      if (this.paused) return;
      if (!this.visible()) { this.setState("hidden"); return; }
      if (!this.canLoad()) { this.setState("exhausted"); return; }
      if (!this.validKey(key)) { this.setState("idle", { reason: "invalid-cursor" }); return; }
      if (!this.nearEnd()) { this.setState("idle"); return; }
      if (this.attempted.has(key)) {
        this.paused = true;
        this.setState("paused", { reason: "duplicate-cursor" });
        return;
      }
      if (this.autoLoads >= this.autoLoadLimit) {
        this.setState("idle", { reason: "await-scroll" });
        return;
      }
      const token = { key, epoch: this.epoch, height: this.viewport.scrollHeight };
      this.consumeAutoBudget();
      this.pending = token;
      this.setState("loading");
      try {
        // Invoke immediately so callers capture their current dataset.
        Promise.resolve(this.load()).then(
          result => this.finish(token, true, result),
          error => this.finish(token, false, error)
        );
      } catch (error) {
        this.finish(token, false, error);
      }
    }

    finish(token, success, result) {
      if (this.destroyed || this.pending !== token) return;
      this.pending = null;
      if (token.epoch !== this.epoch) {
        this.setState("idle");
        this.check();
        return;
      }
      if (!success) {
        // Failures are not successful cursor visits. Keep the error visible and
        // allow explicit recovery, rather than permanently blacklisting its key.
        this.failedKey = token.key;
        const retryAt = Number.isFinite(result?.retryAt) ? result.retryAt
          : this.now() + (Number.isFinite(result?.retryAfter) ? Math.max(0, result.retryAfter) : 0);
        this.setState("error", { error: result, reason: "load-failed", retryAt });
        return;
      }
      this.attempted.add(token.key);
      const grew = Number.isFinite(this.viewport.scrollHeight) && this.viewport.scrollHeight > token.height;
      this.noProgress = grew && result?.progress !== false ? 0 : this.noProgress + 1;
      // No two-page cap: healthy pages continue until the sentinel leaves range.
      // Folded threads and pages of duplicates receive a small, explicit budget.
      if (this.canLoad() && this.noProgress >= this.noProgressLimit) {
        this.paused = true;
        this.setState("paused", { reason: "no-progress" });
      } else {
        this.setState(this.canLoad() ? "idle" : "exhausted");
        this.check();
      }
    }

    recover(manual = true) {
      if (this.destroyed || this.pending || this.state.retryAt > this.now()) return false;
      this.autoLoads = 0;
      this.captureScrollPosition();
      this.attempted.clear();
      this.paused = false;
      this.noProgress = 0;
      this.failedKey = undefined;
      if (manual) this.onlineRetries = 0;
      this.setState("idle");
      this.check();
      return true;
    }

    // Manual recovery never bypasses a server's Retry-After deadline.
    resume() { return this.recover(); }

    // Dataset transition. An old promise continues to own its single-flight slot.
    reset() {
      if (this.destroyed) return;
      this.epoch++;
      this.autoLoads = 0;
      this.captureScrollPosition();
      this.attempted.clear();
      this.paused = false;
      this.noProgress = 0;
      this.onlineRetries = 0;
      this.failedKey = undefined;
      if (this.pending) this.attempted.add(this.pending.key);
      this.setState(this.pending ? "loading" : "idle");
      this.check();
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.epoch++;
      if (this.frame !== null) this.window.cancelAnimationFrame(this.frame);
      this.frame = null;
      this.observer?.disconnect();
      this.mutations?.disconnect();
      this.resizes?.disconnect();
      this.viewport.removeEventListener("scroll", this.onScroll);
      this.window.removeEventListener("resize", this.onChange);
      this.window.removeEventListener("online", this.onOnline);
      this.document?.removeEventListener("visibilitychange", this.onChange);
      this.setState("destroyed");
    }
  }

  globalThis.LDScroll = { ...globalThis.LDScroll, Pager };
})();
