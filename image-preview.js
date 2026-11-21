(() => {
  const siteURL = "https://linux.do";
  const excluded = ".emoji, .emoji-custom, .avatar, .avatar-wrapper, .onebox, .onebox-body, .onebox-header, .onebox-avatar, .onebox-icon, .site-icon, .favicon, .logo";
  const minScale = 1, maxScale = 8, zoomStep = 1.25;

  // An image loader, never a general navigation endpoint.
  function safeImageURL(value) {
    if (typeof value !== "string" || !value.trim()) return null;
    try {
      const url = new URL(value, siteURL);
      return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
    } catch { return null; }
  }

  function create({ root, content, scrollContainers } = {}) {
    if (!root?.ownerDocument || !root.append) throw new TypeError("图片预览需要阅读器根节点。");
    const document = root.ownerDocument;
    const view = document.defaultView;
    const getContent = () => typeof content === "function" ? content() : content;
    const getScrollContainers = () => typeof scrollContainers === "function" ? scrollContainers()
      : scrollContainers || root.querySelectorAll(".read-scroll, .list-scroll");
    const make = (tag, className, text) => {
      const node = document.createElement(tag);
      node.className = className;
      if (text) node.textContent = text;
      return node;
    };
    const dialog = make("dialog", "ld-image-preview");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", "图片预览");
    dialog.tabIndex = -1;
    dialog.hidden = true;
    const panel = make("div", "ld-image-preview-panel");
    const toolbar = make("div", "ld-image-preview-toolbar");
    const title = make("span", "ld-image-preview-title", "图片预览");
    const ratio = make("span", "ld-image-preview-ratio", "100%");
    ratio.setAttribute("aria-label", "图片缩放比例");
    ratio.title = "100% 为适配预览区域的大小";
    const original = make("a", "ld-image-preview-original", "打开原图 ↗");
    original.target = "_blank";
    original.rel = "noopener noreferrer";
    const control = (label, action, text = label) => {
      const node = make("button", "ld-image-preview-control", text);
      node.type = "button";
      node.dataset.ldImageAction = action;
      node.setAttribute("aria-label", label);
      node.title = label;
      return node;
    };
    const zoomOut = control("缩小图片", "zoom-out", "−");
    const zoomIn = control("放大图片", "zoom-in", "+");
    const reset = control("重置图片大小和位置", "reset", "重置");
    const closeButton = control("关闭预览", "close");
    toolbar.append(title, zoomOut, ratio, zoomIn, reset, original, closeButton);
    const stage = make("div", "ld-image-preview-stage");
    const status = make("p", "ld-image-preview-status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const caption = make("p", "ld-image-preview-caption");
    panel.append(toolbar, stage, status, caption);
    dialog.append(panel);
    root.append(dialog);

    let opened = false, destroyed = false, ready = false;
    let returnFocus = null, image = null, disposeImage = null, locked = [];
    let scale = minScale, x = 0, y = 0, baseWidth = 0, baseHeight = 0;
    let gesture = null, gestureUsed = false, suppressClickUntil = 0, resizeObserver = null;
    const pointers = new Map();
    const activeElement = () => root.activeElement || document.activeElement;
    const focus = node => {
      if (node?.isConnected !== false && typeof node?.focus === "function") node.focus({ preventScroll: true });
    };
    const bounds = () => stage.getBoundingClientRect();
    const clamp = (number, low, high) => Math.max(low, Math.min(high, number));
    const updateControls = () => {
      ratio.textContent = `${Math.round(scale * 100)}%`;
      zoomOut.disabled = !ready || scale <= minScale;
      zoomIn.disabled = !ready || scale >= maxScale;
      reset.disabled = !ready || (scale === minScale && x === 0 && y === 0);
      stage.dataset.zoomed = String(ready && scale > minScale);
      stage.dataset.panning = String(!!pointers.size && scale > minScale);
    };
    const renderTransform = () => {
      if (!ready || !image) { updateControls(); return; }
      const rect = bounds();
      const maxX = Math.max(0, (baseWidth * scale - rect.width) / 2);
      const maxY = Math.max(0, (baseHeight * scale - rect.height) / 2);
      x = clamp(x, -maxX, maxX);
      y = clamp(y, -maxY, maxY);
      image.style.setProperty("width", `${baseWidth}px`);
      image.style.setProperty("height", `${baseHeight}px`);
      image.style.setProperty("transform", `translate(${x}px, ${y}px) scale(${scale})`);
      updateControls();
    };
    const release = id => {
      try { if (stage.hasPointerCapture?.(id)) stage.releasePointerCapture(id); } catch { /* A cancelled pointer may already be released. */ }
    };
    const clearPointers = () => {
      const ids = [...pointers.keys()];
      pointers.clear();
      gesture = null;
      gestureUsed = false;
      for (const id of ids) release(id);
      updateControls();
    };
    function measure() {
      if (!opened || !ready || !image) return;
      const rect = bounds();
      const width = Number(image.naturalWidth), height = Number(image.naturalHeight);
      if (!(rect.width > 0 && rect.height > 0 && width > 0 && height > 0)) return;
      const fit = Math.min(1, rect.width / width, rect.height / height);
      baseWidth = width * fit;
      baseHeight = height * fit;
      renderTransform();
    }
    const resized = () => {
      if (pointers.size) { suppressClickUntil = Date.now() + 700; clearPointers(); }
      measure();
    };
    const watchResize = () => {
      const Observer = view?.ResizeObserver || globalThis.ResizeObserver;
      if (typeof Observer === "function") {
        resizeObserver = new Observer(resized);
        resizeObserver.observe(stage);
      }
      view?.addEventListener?.("resize", resized);
    };
    const unwatchResize = () => {
      resizeObserver?.disconnect();
      resizeObserver = null;
      view?.removeEventListener?.("resize", resized);
    };
    function zoomTo(value, anchor) {
      if (!ready) return;
      const next = clamp(value, minScale, maxScale);
      if (!Number.isFinite(next)) return;
      const rect = bounds();
      const localX = (anchor?.x ?? rect.left + rect.width / 2) - rect.left - rect.width / 2;
      const localY = (anchor?.y ?? rect.top + rect.height / 2) - rect.top - rect.height / 2;
      const factor = next / scale;
      x = localX - (localX - x) * factor;
      y = localY - (localY - y) * factor;
      scale = next;
      renderTransform();
    }
    const resetTransform = () => {
      clearPointers();
      scale = minScale;
      x = y = 0;
      renderTransform();
    };
    const dispose = () => {
      disposeImage?.();
      disposeImage = null;
      if (image) { image.removeAttribute("src"); image.remove(); image = null; }
      ready = false;
      baseWidth = baseHeight = 0;
    };
    const lockScroll = () => {
      locked = [...new Set([...(getScrollContainers() || [])])].filter(node => node?.style).map(node => {
        const properties = ["overflow", "overflow-x", "overflow-y"].map(key => ({
          key, value: node.style.getPropertyValue(key), priority: node.style.getPropertyPriority(key)
        }));
        node.style.setProperty("overflow", "hidden", "important");
        return { node, properties };
      });
    };
    const unlockScroll = () => {
      for (const { node, properties } of locked) {
        node.style.removeProperty("overflow");
        for (const { key, value, priority } of properties) {
          if (value) node.style.setProperty(key, value, priority);
          else node.style.removeProperty(key);
        }
      }
      locked = [];
    };
    function close({ restoreFocus = true } = {}) {
      if (!opened) return;
      opened = false;
      unwatchResize();
      clearPointers();
      suppressClickUntil = 0;
      dispose();
      resetTransform();
      if (dialog.open && typeof dialog.close === "function") dialog.close();
      dialog.removeAttribute("open");
      dialog.hidden = true;
      unlockScroll();
      const target = returnFocus;
      returnFocus = null;
      if (restoreFocus) focus(target);
    }
    function showImage(item) {
      original.href = item.src;
      caption.textContent = item.caption;
      caption.hidden = !item.caption;
      status.textContent = "正在加载图片…";
      status.dataset.state = "loading";
      status.hidden = false;
      dispose();
      resetTransform();
      const current = make("img", "ld-image-preview-image");
      image = current;
      current.alt = item.caption || "预览图片";
      current.referrerPolicy = "no-referrer";
      current.decoding = "async";
      current.draggable = false;
      current.hidden = true;
      const loaded = () => {
        if (!opened || image !== current) return;
        ready = true;
        current.hidden = false;
        status.textContent = "";
        status.hidden = true;
        status.dataset.state = "loaded";
        measure();
      };
      const failed = () => {
        if (!opened || image !== current) return;
        clearPointers();
        ready = false;
        updateControls();
        current.hidden = true;
        status.textContent = "图片加载失败。可打开原图查看。";
        status.dataset.state = "error";
        status.hidden = false;
      };
      current.addEventListener("load", loaded);
      current.addEventListener("error", failed);
      disposeImage = () => {
        current.removeEventListener("load", loaded);
        current.removeEventListener("error", failed);
      };
      stage.append(current);
      current.src = item.src;
      updateControls();
    }
    function imageItem(node, holder) {
      if (!node?.matches?.("img[data-ld-image-src]") || node.closest(excluded)) return null;
      const link = node.closest("a");
      if (link && !link.hasAttribute("data-ld-image-link")) return null;
      const src = safeImageURL(node.getAttribute("data-ld-image-src"));
      if (!src || !holder.contains(node)) return null;
      if (link && (!safeImageURL(link.getAttribute("href")) ||
        safeImageURL(link.getAttribute("data-ld-image-link")) !== src)) return null;
      return { node, link, src, caption: (node.alt || link?.title || "").trim() };
    }
    function overImage(event) {
      if (!ready || !image || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return false;
      const within = rect => event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
      // Captured taps target the stage; use the *visible* transformed image area.
      return within(bounds()) && within(image.getBoundingClientRect());
    }
    function handleClick(event) {
      if (destroyed || event.defaultPrevented || event.button != null && event.button !== 0 ||
        event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
      const target = event.target?.nodeType === 3 ? event.target.parentElement : event.target;
      if (!target?.closest) return false;
      if (opened && dialog.contains(target)) {
        if (original.contains(target)) return false;
        const button = target.closest("[data-ld-image-action]");
        const action = button?.dataset.ldImageAction;
        if (action) {
          if (!button.disabled) {
            if (action === "close") close();
            else if (action === "zoom-in") zoomTo(scale * zoomStep);
            else if (action === "zoom-out") zoomTo(scale / zoomStep);
            else if (action === "reset") resetTransform();
            else return false;
          }
        } else {
          if (title.contains(target) || ratio.contains(target) || caption.contains(target) || status.contains(target)) return false;
          if (pointers.size || Date.now() < suppressClickUntil) { event.preventDefault(); return true; }
          if (image?.contains(target) || overImage(event)) return false;
          // All structural whitespace is dismissible, including panel gaps,
          // stage letterboxing and dialog padding; actual content above is not.
          close();
        }
        event.preventDefault();
        return true;
      }
      if (opened) return false;
      const holder = getContent();
      if (!holder || !holder.contains(target) || target.closest(excluded)) return false;
      const node = target.closest("img[data-ld-image-src]") ||
        target.closest("a[data-ld-image-link]")?.querySelector("img[data-ld-image-src]");
      const item = imageItem(node, holder);
      if (!item) return false;
      returnFocus = item.link || activeElement() || holder;
      opened = true;
      dialog.hidden = false;
      try {
        if (typeof dialog.showModal === "function") dialog.showModal();
        else dialog.setAttribute("open", "");
      } catch {
        opened = false;
        dialog.hidden = true;
        returnFocus = null;
        return false;
      }
      lockScroll();
      showImage(item);
      watchResize();
      focus(closeButton);
      event.preventDefault();
      return true;
    }
    function handleKeydown(event) {
      if (destroyed || !opened || event.defaultPrevented) return false;
      if (event.key === "Escape") close();
      else if (event.key === "Tab") {
        const controls = [zoomOut, zoomIn, reset, original, closeButton].filter(node => !node.disabled);
        const current = controls.indexOf(activeElement());
        const step = event.shiftKey ? -1 : 1;
        const position = current < 0 ? event.shiftKey ? controls.length - 1 : 0
          : (current + step + controls.length) % controls.length;
        focus(controls[position]);
      } else if (!event.ctrlKey && !event.metaKey && !event.altKey && ["+", "=", "-", "_", "0"].includes(event.key)) {
        if (event.key === "0") resetTransform();
        else zoomTo(scale * (["+", "="].includes(event.key) ? zoomStep : 1 / zoomStep));
      } else return false;
      event.preventDefault();
      return true;
    }
    const rebaseGesture = () => {
      const points = [...pointers.values()];
      if (points.length > 1) {
        const [a, b] = points;
        gesture = { mode: "pinch", distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
          midX: (a.x + b.x) / 2, midY: (a.y + b.y) / 2, scale, x, y };
        gestureUsed = true;
      } else if (points.length) {
        gesture = { mode: "pan", startX: points[0].x, startY: points[0].y, x, y };
      } else gesture = null;
      updateControls();
    };
    const moveGesture = () => {
      const points = [...pointers.values()];
      if (!gesture || !points.length) return;
      if (points.length > 1 && gesture.mode === "pinch") {
        const [a, b] = points;
        const next = clamp(gesture.scale * Math.hypot(a.x - b.x, a.y - b.y) / gesture.distance, minScale, maxScale);
        const rect = bounds();
        const centerX = rect.left + rect.width / 2, centerY = rect.top + rect.height / 2;
        const factor = next / gesture.scale;
        x = (a.x + b.x) / 2 - centerX - (gesture.midX - centerX - gesture.x) * factor;
        y = (a.y + b.y) / 2 - centerY - (gesture.midY - centerY - gesture.y) * factor;
        scale = next;
      } else if (gesture.mode === "pan") {
        const dx = points[0].x - gesture.startX, dy = points[0].y - gesture.startY;
        if (Math.hypot(dx, dy) > 4) gestureUsed = true;
        if (scale > minScale) { x = gesture.x + dx; y = gesture.y + dy; }
      }
      renderTransform();
    };
    function pointer(event) {
      if (!opened || !ready) return;
      const id = event.pointerId;
      if (event.type === "pointerdown") {
        if (!stage.contains(event.target) || (event.button != null && event.button !== 0) ||
          event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || pointers.size >= 2 ||
          !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
        if (!pointers.size) { suppressClickUntil = 0; gestureUsed = false; }
        pointers.set(id, { x: event.clientX, y: event.clientY });
        try { stage.setPointerCapture?.(id); } catch { /* Detached or already cancelled pointer. */ }
        rebaseGesture();
      } else {
        const point = pointers.get(id);
        if (!point) return;
        if (event.type === "pointermove" || event.type === "pointerup") {
          if (Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) {
            point.x = event.clientX; point.y = event.clientY;
          }
          moveGesture();
        }
        if (["pointerup", "pointercancel", "lostpointercapture"].includes(event.type)) {
          if (gestureUsed || event.type !== "pointerup") suppressClickUntil = Date.now() + 700;
          pointers.delete(id);
          release(id);
          rebaseGesture();
          if (!pointers.size) gestureUsed = false;
        }
      }
      event.preventDefault?.();
    }
    const wheel = event => {
      if (!opened) return;
      event.preventDefault();
      if (!ready || !stage.contains(event.target) || !Number.isFinite(event.deltaY)) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? bounds().height : 1;
      const delta = clamp(event.deltaY * unit, -1000, 1000);
      zoomTo(scale * Math.exp(-delta * .002), { x: event.clientX, y: event.clientY });
      // Wheel/trackpad input must not turn a following synthetic click into close.
      suppressClickUntil = Date.now() + 200;
    };
    const cancel = event => { event.preventDefault(); close(); };
    const nativeClose = () => { if (opened && !dialog.open) close(); };
    const stopScroll = event => { if (opened) event.preventDefault(); };
    const pointerTypes = ["pointerdown", "pointermove", "pointerup", "pointercancel", "lostpointercapture"];
    dialog.addEventListener("cancel", cancel);
    dialog.addEventListener("close", nativeClose);
    dialog.addEventListener("wheel", wheel, { passive: false });
    dialog.addEventListener("touchmove", stopScroll, { passive: false });
    for (const type of pointerTypes) dialog.addEventListener(type, pointer);
    updateControls();
    function destroy() {
      if (destroyed) return;
      close({ restoreFocus: false });
      destroyed = true;
      unwatchResize();
      dialog.removeEventListener("cancel", cancel);
      dialog.removeEventListener("close", nativeClose);
      dialog.removeEventListener("wheel", wheel);
      dialog.removeEventListener("touchmove", stopScroll);
      for (const type of pointerTypes) dialog.removeEventListener(type, pointer);
      dialog.remove();
    }
    return { handleClick, handleKeydown, close, destroy, isOpen: () => opened };
  }

  globalThis.LDImagePreview = { create, safeImageURL };
})();
