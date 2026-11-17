// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mipawn
(() => {
  class Pager {
    constructor({ viewport, canLoad, getKey, load, threshold = 300 } = {}) {
      if (!viewport?.addEventListener || !viewport?.getBoundingClientRect ||
          [canLoad, getKey, load].some(callback => typeof callback !== "function")) {
        throw new TypeError("Pager requires a viewport and canLoad/getKey/load callbacks.");
      }
      if (!Number.isFinite(threshold) || threshold < 0) {
        throw new TypeError("Pager threshold must be a nonnegative finite number.");
      }
      Object.assign(this, { viewport, canLoad, getKey, load, threshold });
      this.window = viewport.ownerDocument?.defaultView || globalThis.window;
      this.document = viewport.ownerDocument || this.window.document;
      this.frame = null;
      this.pending = null;
      this.attempted = new Set();
      this.epoch = 0;
      this.destroyed = false;
      this.paused = false;
      this.autoPages = 0;
      this.onChange = () => this.check();
      // scroll events are also emitted by our anchor restoration and DOM
      // replacement. Only actual input intent may reset the prefetch budget.
      this.onIntent = () => { this.paused = false; this.autoPages = 0; this.check(); };
      this.onKey = event => {
        if (["ArrowDown", "ArrowUp", "PageDown", "PageUp", "End", "Home", " "].includes(event.key)) this.onIntent();
      };
      this.onDrag = event => { if (event.buttons) this.onIntent(); };
      viewport.addEventListener("scroll", this.onChange, { passive: true });
      for (const type of ["wheel", "touchmove", "pointerdown"]) viewport.addEventListener(type, this.onIntent, { passive: true });
      viewport.addEventListener("keydown", this.onKey);
      viewport.addEventListener("pointermove", this.onDrag, { passive: true });
      this.window.addEventListener("resize", this.onChange);
      this.document?.addEventListener("visibilitychange", this.onChange);
      this.check();
    }

    // Coalesce scroll, resize and explicit render notifications into one frame.
    check() {
      if (this.destroyed || this.frame !== null) return;
      this.frame = this.window.requestAnimationFrame(() => {
        this.frame = null;
        this.run();
      });
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
      // A geometrically nonempty container can still be entirely offscreen.
      if (this.window.innerHeight > 0 && (rect.bottom <= 0 || rect.top >= this.window.innerHeight)) return false;
      if (this.window.innerWidth > 0 && (rect.right <= 0 || rect.left >= this.window.innerWidth)) return false;
      return true;
    }

    run() {
      if (this.destroyed || this.paused || this.pending || !this.visible() || !this.canLoad()) return;
      const remaining = this.viewport.scrollHeight - this.viewport.clientHeight - this.viewport.scrollTop;
      if (!Number.isFinite(remaining) || remaining > this.threshold) return;
      const key = this.getKey();
      // Keys must be stable primitives, not a fresh object per inspection.
      if (key == null || key === "" || typeof key === "object" || typeof key === "function" ||
          typeof key === "number" && !Number.isFinite(key) || this.attempted.has(key)) return;
      this.attempted.add(key);
      const token = { key, epoch: this.epoch, height: this.viewport.scrollHeight };
      this.pending = token;
      try {
        // Invoke now: the caller can capture the current topic before it changes.
        Promise.resolve(this.load()).then(
          () => this.finish(token, true),
          () => this.finish(token, false)
        );
      } catch {
        this.finish(token, false);
      }
    }

    finish(token, success) {
      if (this.destroyed || this.pending !== token) return;
      this.pending = null;
      // A reset/topic transition cannot make an old completion retry its cursor.
      if (token.epoch !== this.epoch) {
        this.check();
        return;
      }
      // Failed cursors remain attempted; neither scroll nor resize retries them.
      // A successful changed cursor can fill another page while still near bottom.
      if (success) {
        this.autoPages++;
        // Advancing cursors alone do not justify fetching an entire collapsed
        // thread or pages of duplicates. Require height progress and cap bursts.
        this.paused = this.viewport.scrollHeight <= token.height || this.autoPages >= 2;
        if (!this.paused) this.check();
      }
    }

    // Explicit recovery after a failed/no-progress page or a dataset transition.
    // An in-flight load still owns its slot and cursor until it settles.
    reset() {
      if (this.destroyed) return;
      this.epoch++;
      this.attempted.clear();
      this.paused = false;
      this.autoPages = 0;
      if (this.pending) this.attempted.add(this.pending.key);
      this.check();
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.epoch++;
      if (this.frame !== null) this.window.cancelAnimationFrame(this.frame);
      this.frame = null;
      this.viewport.removeEventListener("scroll", this.onChange);
      for (const type of ["wheel", "touchmove", "pointerdown"]) this.viewport.removeEventListener(type, this.onIntent);
      this.viewport.removeEventListener("keydown", this.onKey);
      this.viewport.removeEventListener("pointermove", this.onDrag);
      this.window.removeEventListener("resize", this.onChange);
      this.document?.removeEventListener("visibilitychange", this.onChange);
    }
  }

  globalThis.LDScroll = { ...globalThis.LDScroll, Pager };
})();
