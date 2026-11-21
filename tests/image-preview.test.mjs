import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const previewSource = readFileSync(new URL("../image-preview.js", import.meta.url), "utf8");
const forumSource = readFileSync(new URL("../forum.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../image-preview.css", import.meta.url), "utf8");

// A deliberately small DOM fixture keeps the tests dependency-free. cooked()
// still executes the production copier; only template parsing/DOM APIs are fake.
class Style {
  constructor() { this.values = new Map(); }
  setProperty(key, value, priority = "") { this.values.set(key, { value, priority }); }
  getPropertyValue(key) { return this.values.get(key)?.value || ""; }
  getPropertyPriority(key) { return this.values.get(key)?.priority || ""; }
  removeProperty(key) { this.values.delete(key); }
}
class Node {
  static TEXT_NODE = 3;
  static ELEMENT_NODE = 1;
  constructor(document, type = 1, tag = "div") {
    this.ownerDocument = document;
    this.nodeType = type;
    this.tagName = type === 1 ? tag.toUpperCase() : undefined;
    this.namespaceURI = "http://www.w3.org/1999/xhtml";
    this.childNodes = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.style = new Style();
    this.hidden = false;
    this.disabled = false;
    this.dataset = new Proxy({}, {
      get: (_, key) => this.getAttribute(`data-${String(key).replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`) ?? undefined,
      set: (_, key, value) => { this.setAttribute(`data-${String(key).replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`, value); return true; }
    });
    this.classList = { contains: name => this.className.split(/\s+/).includes(name) };
    if (tag === "template") this.content = new Node(document, 11);
  }
  get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
  get isConnected() { return this.connected || !!this.parentNode?.isConnected; }
  get children() { return this.childNodes.filter(node => node.nodeType === 1); }
  get className() { return this.getAttribute("class") || ""; }
  set className(value) { this.setAttribute("class", value); }
  get textContent() { return this.nodeType === 3 ? this.text || "" : this.childNodes.map(node => node.textContent).join(""); }
  set textContent(value) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    if (this.nodeType === 3) this.text = String(value);
    else if (value) this.append(this.ownerDocument.createTextNode(String(value)));
  }
  get open() { return this.hasAttribute("open"); }
  set open(value) { if (value) this.setAttribute("open", ""); else this.removeAttribute("open"); }
  set innerHTML(html) { parseHTML(html, this.content || this); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  append(...nodes) {
    for (const node of nodes) {
      if (node.nodeType === 11) { this.append(...[...node.childNodes]); continue; }
      node.remove(); node.parentNode = this; this.childNodes.push(node);
    }
  }
  remove() {
    if (this.parentNode) this.parentNode.childNodes = this.parentNode.childNodes.filter(node => node !== this);
    this.parentNode = null;
  }
  contains(node) { return this === node || this.childNodes.some(child => child.contains(node)); }
  matches(selectors) {
    return selectors.split(",").some(selector => {
      selector = selector.trim();
      const tag = selector.match(/^[a-z]+/i)?.[0];
      if (tag && this.tagName !== tag.toUpperCase()) return false;
      for (const [, name] of selector.matchAll(/\.([\w-]+)/g)) if (!this.classList.contains(name)) return false;
      for (const [, name] of selector.matchAll(/\[([\w-]+)\]/g)) if (!this.hasAttribute(name)) return false;
      return !!tag || selector.startsWith(".") || selector.startsWith("[");
    });
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  querySelectorAll(selector) {
    const result = [];
    for (const child of this.childNodes) {
      if (child.nodeType === 1 && child.matches(selector)) result.push(child);
      result.push(...child.querySelectorAll(selector));
    }
    return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  emit(type, event = {}) {
    event.type = type; event.target ||= this;
    for (const listener of [...this.listeners.get(type) || []]) listener(event);
    return event;
  }
  setPointerCapture(id) { (this.captured ||= new Set()).add(id); }
  hasPointerCapture(id) { return this.captured?.has(id) || false; }
  releasePointerCapture(id) { this.captured?.delete(id); }
  getBoundingClientRect() {
    let { left = 0, top = 0, width = 0, height = 0 } = this.rect || {};
    if (this.matches('.ld-image-preview-image') && this.parentElement) {
      const stage = this.parentElement.getBoundingClientRect();
      const match = this.style.getPropertyValue('transform').match(/translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/);
      const x = Number(match?.[1] || 0), y = Number(match?.[2] || 0), scale = Number(match?.[3] || 1);
      width = parseFloat(this.style.getPropertyValue('width') || this.naturalWidth) * scale;
      height = parseFloat(this.style.getPropertyValue('height') || this.naturalHeight) * scale;
      left = stage.left + (stage.width - width) / 2 + x;
      top = stage.top + (stage.height - height) / 2 + y;
    }
    return { x: left, y: top, left, top, width, height, right: left + width, bottom: top + height };
  }
  focus(options) { this.ownerDocument.activeElement = this; this.ownerDocument.root.activeElement = this; this.focusOptions = options; }
  showModal() { if (this.ownerDocument.failModal) throw new Error("unmounted dialog"); this.open = true; }
  close() { this.open = false; this.emit("close"); }
}
for (const prop of ["href", "src", "alt", "title", "target", "rel", "type", "referrerPolicy", "loading", "decoding"]) {
  const attr = prop === "referrerPolicy" ? "referrerpolicy" : prop;
  Object.defineProperty(Node.prototype, prop, { get() { return this.getAttribute(attr) || ""; }, set(value) { this.setAttribute(attr, value); } });
}
function parseHTML(html, root) {
  const stack = [root];
  for (const token of html.match(/<[^>]*>|[^<]+/g) || []) {
    if (token.startsWith("</")) { stack.pop(); continue; }
    if (!token.startsWith("<")) { stack.at(-1).append(root.ownerDocument.createTextNode(token)); continue; }
    const tag = token.match(/^<([\w-]+)/)?.[1]?.toLowerCase();
    if (!tag) continue;
    const node = root.ownerDocument.createElement(tag);
    const attrs = token.slice(tag.length + 1, -1);
    for (const [, name, double, single, bare] of attrs.matchAll(/([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s/>]+)))?/g)) node.setAttribute(name, double ?? single ?? bare ?? "");
    stack.at(-1).append(node);
    if (!["img", "br", "hr", "input", "source"].includes(tag) && !token.endsWith("/>")) stack.push(node);
  }
}
function fixture(html = '<p><img src="/uploads/first.png" alt="第一张"><img src="https://cdn.example/second.jpg" alt="第二张"></p>') {
  const clock = { now: 10000 };
  const observers = [];
  class ClockDate extends Date { static now() { return clock.now; } }
  class ResizeObserver {
    constructor(callback) { this.callback = callback; this.observed = new Set(); observers.push(this); }
    observe(node) { this.observed.add(node); }
    disconnect() { this.observed.clear(); }
    fire() { if (this.observed.size) this.callback([]); }
  }
  const view = new Node(null, 11);
  view.ResizeObserver = ResizeObserver;
  const document = {
    defaultView: view,
    createElement(tag) {
      const node = new Node(this, 1, tag);
      if (tag === 'img') { node.naturalWidth = 1600; node.naturalHeight = 1200; }
      return node;
    },
    createDocumentFragment() { return new Node(this, 11); },
    createTextNode(text) { const node = new Node(this, 3); node.text = text; return node; }
  };
  const root = new Node(document, 11); root.connected = true; document.root = root;
  const readScroll = document.createElement("div"); readScroll.className = "read-scroll";
  const listScroll = document.createElement("div"); listScroll.className = "list-scroll";
  let content = document.createElement("div"); readScroll.append(content); root.append(readScroll, listScroll);
  const context = vm.createContext({ document, Node, URL, Intl, AbortController, DOMException, console, Date: ClockDate });
  vm.runInContext(forumSource, context);
  vm.runInContext(previewSource, context);
  content.append(context.LDForum.cooked(html));
  const controller = context.LDImagePreview.create({ root, content: () => content });
  const dialog = root.querySelector("dialog");
  const stage = dialog.querySelector('.ld-image-preview-stage');
  stage.rect = { left: 100, top: 80, width: 800, height: 600 };
  const action = name => dialog.querySelectorAll("button").find(node => node.dataset.ldImageAction === name);
  return {
    document, root, readScroll, listScroll, content, context, controller, dialog, action, stage, view, observers,
    advance(ms) { clock.now += ms; },
    images: () => content.querySelectorAll("img[data-ld-image-src]"),
    displayed: () => dialog.querySelector("img"),
    status: () => dialog.querySelector(".ld-image-preview-status"),
    original: () => dialog.querySelector("a"),
    replace(html) { content.remove(); content = document.createElement("div"); content.append(context.LDForum.cooked(html)); readScroll.append(content); this.content = content; }
  };
}
function click(target, extra = {}) { return { target, button: 0, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra }; }
function key(key, extra = {}) { return { key, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra }; }
function opened(f = fixture(), dimensions) {
  f.controller.handleClick(click(f.images()[0]));
  if (dimensions) Object.assign(f.displayed(), dimensions);
  f.displayed().emit('load');
  return f;
}
function transform(f) {
  const match = f.displayed().style.getPropertyValue('transform').match(/translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/);
  assert.ok(match, 'A measured image has an explicit transform');
  return { x: Number(match[1]), y: Number(match[2]), scale: Number(match[3]) };
}
function pointer(f, type, id, x, y, extra = {}) {
  const event = click(f.stage, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, ...extra });
  f.dialog.emit(type, event);
  return event;
}
function wheel(f, deltaY, x = 500, y = 380, extra = {}) {
  const event = click(f.stage, { deltaY, deltaMode: 0, clientX: x, clientY: y, ...extra });
  f.dialog.emit('wheel', event);
  return event;
}
function near(actual, expected, label) { assert.ok(Math.abs(actual - expected) < .00001, `${label || 'value'} ${actual} ~= ${expected}`); }

test("safe URLs allow HTTPS relatives but reject executable, insecure, credentialed and malformed schemes", () => {
  const f = fixture();
  for (const value of ["javascript:alert(1)", "data:image/svg+xml,bad", "blob:https://linux.do/id", "http://linux.do/x.png", "https://user:secret@example/x.png", "https://user@example/x.png", "https://[", "", null, 4]) {
    assert.equal(f.context.LDImagePreview.safeImageURL(value), null, String(value));
  }
  assert.equal(f.context.LDImagePreview.safeImageURL("/upload.png"), "https://linux.do/upload.png");
  assert.equal(f.context.LDImagePreview.safeImageURL("//cdn.example/image.png"), "https://cdn.example/image.png");
});

test("cooked wraps ordinary images in original anchors, recreates metadata and strips active attributes", () => {
  const f = fixture('<img src="/safe.png" onerror="bad()" data-ld-image-src="javascript:bad()" data-ld-image-link="bad" alt="示例">');
  const image = f.images()[0], link = image.closest("a");
  assert.equal(image.dataset.ldImageSrc, "https://linux.do/safe.png");
  assert.equal(image.hasAttribute("onerror"), false);
  assert.equal(image.hasAttribute("data-ld-image-link"), false);
  assert.equal(link.href, "https://linux.do/safe.png");
  assert.equal(link.dataset.ldImageLink, link.href);
  assert.equal(link.target, "_blank");
  assert.equal(link.rel, "noopener noreferrer");
  assert.equal(image.referrerPolicy, "no-referrer");
});

test("ordinary click opens an accessible modal without changing the original link", () => {
  const f = fixture(), image = f.images()[0], event = click(image);
  assert.equal(f.controller.handleClick(event), true);
  assert.equal(event.defaultPrevented, true);
  assert.equal(f.controller.isOpen(), true);
  assert.equal(f.dialog.open, true);
  assert.equal(f.dialog.getAttribute("role"), "dialog");
  assert.equal(f.dialog.getAttribute("aria-modal"), "true");
  assert.equal(f.displayed().src, "https://linux.do/uploads/first.png");
  assert.equal(f.original().href, image.closest("a").href);
  assert.equal(f.root.activeElement, f.action("close"));
});

test("lightbox image and caption clicks preview the validated full-size original", () => {
  const f = fixture('<div class="lightbox-wrapper"><a class="lightbox" href="/original.jpg"><img src="/thumbnail.jpg" alt="图片标题"><span>640×480 点击查看原图</span></a></div>');
  const image = f.images()[0], link = image.closest("a");
  assert.equal(image.src, "https://linux.do/thumbnail.jpg");
  assert.equal(image.dataset.ldImageSrc, "https://linux.do/original.jpg");
  assert.equal(f.controller.handleClick(click(link.querySelector("span"))), true);
  assert.equal(f.displayed().src, "https://linux.do/original.jpg");
  assert.equal(f.dialog.querySelector(".ld-image-preview-caption").textContent, "图片标题");
  f.controller.close();
  assert.equal(f.controller.handleClick(click(link)), true);
});

test("modifier clicks and middle/right mouse buttons keep original-link behavior", () => {
  const f = fixture();
  for (const extra of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { button: 2 }, { defaultPrevented: true }]) {
    const event = click(f.images()[0], extra);
    assert.equal(f.controller.handleClick(event), false);
    assert.equal(f.controller.isOpen(), false);
    assert.equal(event.defaultPrevented, !!extra.defaultPrevented);
  }
});

test("emoji, avatars, onebox icons and logo images are not tagged or intercepted", () => {
  const f = fixture('<p><img class="emoji" src="/emoji.png"><img class="emoji-custom" src="/custom.png"><a href="/u/user"><img class="avatar" src="/avatar.png"></a><aside class="onebox"><a class="lightbox" href="/icon.png"><img src="/icon.png"></a></aside><img class="logo" src="/logo.png"><img class="favicon" src="/favicon.png"><img src="/normal.png"></p>');
  assert.equal(f.images().length, 1);
  assert.equal(f.content.querySelectorAll(".emoji").length, 2);
  const all = f.content.querySelectorAll("img");
  for (const image of all.slice(0, -1)) assert.equal(f.controller.handleClick(click(image)), false);
  assert.equal(f.controller.handleClick(click(all.at(-1))), true);
  assert.equal(f.dialog.querySelector(".ld-image-preview-count"), null);
});

test("non-image links are not hijacked, while existing direct image links preview", () => {
  const f = fixture('<a href="https://example.test/article"><img src="/article.png"></a><a href="/full.webp"><img src="/thumb.webp"></a>');
  assert.equal(f.controller.handleClick(click(f.content.querySelectorAll("img")[0])), false);
  assert.equal(f.images().length, 1);
  assert.equal(f.controller.handleClick(click(f.images()[0])), true);
  assert.equal(f.original().href, "https://linux.do/full.webp");
});

test("unsafe source media and lightbox originals cannot execute or load", () => {
  const f = fixture('<img src="javascript:bad()"><img src="http://linux.do/insecure.png"><img src="https://u:p@example/x.png"><a class="lightbox" href="javascript:bad()"><img src="/safe.png"></a>');
  assert.equal(f.images().length, 0);
  assert.equal(f.content.querySelectorAll("img").length, 1);
  assert.equal(f.content.querySelector("a").hasAttribute("href"), false);
  assert.equal(f.controller.handleClick(click(f.content.querySelector("img"))), false);
});

test("metadata URLs and original hrefs are revalidated before opening", () => {
  for (const change of [node => { node.dataset.ldImageSrc = "javascript:alert(1)"; }, node => { node.closest("a").href = "javascript:alert(1)"; }, node => { node.closest("a").dataset.ldImageLink = "https://example.test/other.png"; }]) {
    const f = fixture(), image = f.images()[0]; change(image);
    assert.equal(f.controller.handleClick(click(image)), false);
    assert.equal(f.controller.isOpen(), false);
  }
});

test("unmarked or outside-content images are not intercepted", () => {
  const f = fixture(), outside = f.document.createElement("img");
  outside.dataset.ldImageSrc = "https://linux.do/outside.png"; f.root.append(outside);
  assert.equal(f.controller.handleClick(click(outside)), false);
  f.images()[0].removeAttribute("data-ld-image-src");
  assert.equal(f.controller.handleClick(click(f.content.querySelector("img"))), false);
});

test("only the clicked image is shown, without gallery buttons, count or arrow navigation", () => {
  const f = fixture(); f.controller.handleClick(click(f.images()[1]));
  assert.equal(f.action("previous"), undefined);
  assert.equal(f.action("next"), undefined);
  assert.equal(f.dialog.querySelector('.ld-image-preview-count'), null);
  for (const name of ['ArrowLeft', 'ArrowRight']) {
    const event = key(name);
    assert.equal(f.controller.handleKeydown(event), false);
    assert.equal(event.defaultPrevented, false);
  }
  assert.equal(f.displayed().src, "https://cdn.example/second.jpg");
  assert.equal(f.controller.handleClick(click(f.images()[0])), false);
  assert.equal(f.displayed().src, "https://cdn.example/second.jpg");
  f.controller.close(); f.controller.handleClick(click(f.images()[0]));
  assert.equal(f.displayed().src, "https://linux.do/uploads/first.png");
});

test("load and error feedback use text and stale image events cannot update the current item", () => {
  const f = fixture(); f.controller.handleClick(click(f.images()[0]));
  const first = f.displayed();
  assert.equal(f.status().dataset.state, "loading");
  first.emit("load");
  assert.equal(first.hidden, false);
  assert.equal(f.status().hidden, true);
  f.controller.close();
  f.controller.handleClick(click(f.images()[1]));
  const second = f.displayed();
  first.emit("error");
  assert.equal(f.status().dataset.state, "loading");
  second.emit("error");
  assert.equal(f.status().dataset.state, "error");
  assert.match(f.status().textContent, /图片加载失败.*打开原图/);
  assert.equal(second.hidden, true);
  assert.equal(f.original().href, "https://cdn.example/second.jpg");
  f.controller.close(); second.emit("load");
  assert.equal(f.controller.isOpen(), false);
});

test("original-image action remains a secure native link even while preview is open", () => {
  const f = fixture(); f.controller.handleClick(click(f.images()[0]));
  const event = click(f.original());
  assert.equal(f.controller.handleClick(event), false);
  assert.equal(event.defaultPrevented, false);
  assert.equal(f.original().target, "_blank");
  assert.equal(f.original().rel, "noopener noreferrer");
});

test("close button, Escape, backdrop and native cancel restore focus without scrolling", () => {
  for (const mode of ["button", "escape", "backdrop", "cancel", "native"]) {
    const f = fixture(), image = f.images()[0], trigger = image.closest("a");
    f.controller.handleClick(click(image));
    if (mode === "button") f.controller.handleClick(click(f.action("close")));
    else if (mode === "escape") assert.equal(f.controller.handleKeydown(key("Escape")), true);
    else if (mode === "backdrop") f.controller.handleClick(click(f.dialog));
    else if (mode === "native") f.dialog.close();
    else { const event = key("Escape"); f.dialog.emit("cancel", event); assert.equal(event.defaultPrevented, true); }
    assert.equal(f.controller.isOpen(), false, mode);
    assert.equal(f.dialog.hidden, true, mode);
    assert.equal(f.root.activeElement, trigger, mode);
    assert.equal(trigger.focusOptions.preventScroll, true, mode);
    assert.equal(f.displayed(), null, mode);
  }
});

test("Tab and Shift-Tab stay within enabled modal controls", () => {
  const f = fixture(); f.controller.handleClick(click(f.images()[0]));
  assert.equal(f.root.activeElement, f.action("close"));
  assert.equal(f.controller.handleKeydown(key("Tab")), true);
  assert.equal(f.root.activeElement, f.original()); // Zoom controls disabled during load.
  f.displayed().emit('load');
  f.action('close').focus();
  f.controller.handleKeydown(key('Tab'));
  assert.equal(f.root.activeElement, f.action('zoom-in'));
  f.controller.handleKeydown(key("Tab", { shiftKey: true }));
  assert.equal(f.root.activeElement, f.action("close"));
  f.controller.handleKeydown(key("Tab", { shiftKey: true }));
  assert.equal(f.root.activeElement, f.original());
});

test("modal locks both pane scroll styles and prevents wheel/touch chaining, then restores exactly", () => {
  const f = fixture(); f.readScroll.style.setProperty("overflow", "auto", "important");
  f.controller.handleClick(click(f.images()[0]));
  assert.equal(f.readScroll.style.getPropertyValue("overflow"), "hidden");
  assert.equal(f.listScroll.style.getPropertyValue("overflow"), "hidden");
  for (const type of ["wheel", "touchmove"]) {
    const event = click(f.dialog); f.dialog.emit(type, event); assert.equal(event.defaultPrevented, true);
  }
  f.controller.close();
  assert.equal(f.readScroll.style.getPropertyValue("overflow"), "auto");
  assert.equal(f.readScroll.style.getPropertyPriority("overflow"), "important");
  assert.equal(f.listScroll.style.getPropertyValue("overflow"), "");
});

test("programmatic topic/hide close can suppress focus restoration and detached triggers are ignored", () => {
  const f = fixture(), trigger = f.images()[0].closest("a");
  f.controller.handleClick(click(f.images()[0]));
  f.controller.close({ restoreFocus: false });
  assert.equal(f.root.activeElement, f.action("close"));
  f.controller.handleClick(click(f.images()[0]));
  trigger.remove();
  assert.doesNotThrow(() => f.controller.close());
  assert.notEqual(f.root.activeElement, trigger);
});

test("content resolver refreshes gallery after topic replacement, with no stale cached nodes", () => {
  const f = fixture(); f.controller.handleClick(click(f.images()[0])); f.controller.close({ restoreFocus: false });
  f.replace('<img src="/new-topic.png" alt="新话题">');
  assert.equal(f.controller.handleClick(click(f.images()[0])), true);
  assert.equal(f.original().href, "https://linux.do/new-topic.png");
  assert.equal(f.dialog.querySelector(".ld-image-preview-count"), null);
});

test("failed modal mount leaves native navigation intact and does not lock scrolling", () => {
  const f = fixture(); f.document.failModal = true;
  const event = click(f.images()[0]);
  assert.equal(f.controller.handleClick(event), false);
  assert.equal(event.defaultPrevented, false);
  assert.equal(f.controller.isOpen(), false);
  assert.equal(f.readScroll.style.getPropertyValue("overflow"), "");
});

test("destroy is idempotent, removes listeners and image work, and disables event handling", () => {
  const f = fixture(); f.controller.handleClick(click(f.images()[0]));
  const image = f.displayed(); f.controller.destroy(); f.controller.destroy();
  assert.equal(f.dialog.isConnected, false);
  assert.equal(f.readScroll.style.getPropertyValue("overflow"), "");
  assert.equal(image.hasAttribute("src"), false);
  for (const type of ["cancel", "close", "wheel", "touchmove"]) assert.equal(f.dialog.listeners.get(type)?.size || 0, 0);
  for (const type of ["load", "error"]) assert.equal(image.listeners.get(type)?.size || 0, 0);
  assert.equal(f.controller.handleClick(click(f.images()[0])), false);
  assert.equal(f.controller.handleKeydown(key("Escape")), false);
});

test("closed preview leaves ordinary reader keyboard shortcuts untouched", () => {
  const f = fixture();
  for (const name of ["Escape", "Tab", "ArrowLeft", "ArrowRight", "/", "j"]) {
    const event = key(name); assert.equal(f.controller.handleKeydown(event), false); assert.equal(event.defaultPrevented, false);
  }
});

test("image-link recognition uses pathname, never an image-like query parameter", () => {
  const f = fixture('<a href="https://example.test/article?filename=picture.png"><img src="/thumb.png"></a>');
  assert.equal(f.images().length, 0);
  assert.equal(f.controller.handleClick(click(f.content.querySelector("img"))), false);
});

test("lightbox caption text-node clicks are resolved to their image link", () => {
  const f = fixture('<a class="lightbox" href="/full.png"><img src="/small.png"><span>点击查看原图</span></a>');
  const text = f.content.querySelector("span").childNodes[0];
  assert.equal(f.controller.handleClick(click(text)), true);
  assert.equal(f.original().href, "https://linux.do/full.png");
});

test("modal restores separate overflow axis values and their priorities", () => {
  const f = fixture();
  f.readScroll.style.setProperty("overflow-x", "clip");
  f.readScroll.style.setProperty("overflow-y", "scroll", "important");
  f.controller.handleClick(click(f.images()[0]));
  f.controller.close();
  assert.equal(f.readScroll.style.getPropertyValue("overflow-x"), "clip");
  assert.equal(f.readScroll.style.getPropertyValue("overflow-y"), "scroll");
  assert.equal(f.readScroll.style.getPropertyPriority("overflow-y"), "important");
});

test("zoom controls, relative ratio, loading guard and 1–8x bounds", () => {
  const f = fixture(); f.controller.handleClick(click(f.images()[0]));
  for (const name of ['zoom-in', 'zoom-out', 'reset']) assert.equal(f.action(name).disabled, true);
  assert.equal(f.dialog.querySelector('.ld-image-preview-ratio').textContent, '100%');
  wheel(f, -1000); // Cannot transform a not-yet-loaded image.
  assert.equal(f.displayed().style.getPropertyValue('transform'), '');
  f.displayed().emit('load');
  assert.equal(f.action('zoom-in').disabled, false);
  assert.equal(f.action('zoom-out').disabled, true);
  assert.equal(f.displayed().style.getPropertyValue('width'), '800px');
  assert.equal(f.displayed().style.getPropertyValue('height'), '600px');
  f.controller.handleClick(click(f.action('zoom-in')));
  near(transform(f).scale, 1.25);
  assert.equal(f.dialog.querySelector('.ld-image-preview-ratio').textContent, '125%');
  f.controller.handleClick(click(f.action('zoom-out')));
  near(transform(f).scale, 1);
  for (let i = 0; i < 25; i++) f.controller.handleClick(click(f.action('zoom-in')));
  assert.equal(transform(f).scale, 8);
  assert.equal(f.action('zoom-in').disabled, true);
  assert.equal(f.dialog.querySelector('.ld-image-preview-ratio').textContent, '800%');
  f.controller.handleClick(click(f.action('reset')));
  assert.deepEqual(transform(f), { x: 0, y: 0, scale: 1 });
  assert.equal(f.action('reset').disabled, true);
});

test("small images are not upscaled by the baseline fit", () => {
  const f = opened(fixture(), { naturalWidth: 120, naturalHeight: 60 });
  assert.equal(f.displayed().style.getPropertyValue('width'), '120px');
  assert.equal(f.displayed().style.getPropertyValue('height'), '60px');
  f.controller.handleClick(click(f.action('zoom-in')));
  assert.deepEqual(transform(f), { x: 0, y: 0, scale: 1.25 });
});

test("wheel zoom keeps the image point under the cursor anchored and clamps extremes", () => {
  const f = opened();
  const event = wheel(f, -Math.log(2) / .002, 650, 430);
  assert.equal(event.defaultPrevented, true);
  let t = transform(f);
  near(t.scale, 2); near(t.x, -150); near(t.y, -50);
  near(500 + t.x + 150 * t.scale, 650, 'horizontal anchor');
  near(380 + t.y + 50 * t.scale, 430, 'vertical anchor');
  wheel(f, -10000); wheel(f, -10000);
  assert.equal(transform(f).scale, 8);
  wheel(f, 10000); wheel(f, 10000);
  assert.deepEqual(transform(f), { x: 0, y: 0, scale: 1 });
  const before = transform(f);
  wheel(f, -500, 500, 380, { target: f.original() });
  assert.deepEqual(transform(f), before);
});

test("wheel line/page delta modes scale locally and invalid delta is ignored", () => {
  const f = opened();
  wheel(f, -10, 500, 380, { deltaMode: 1 });
  near(transform(f).scale, Math.exp(.32));
  f.controller.handleClick(click(f.action('reset')));
  wheel(f, -1, 500, 380, { deltaMode: 2 });
  near(transform(f).scale, Math.exp(1.2));
  const before = transform(f);
  wheel(f, NaN); assert.deepEqual(transform(f), before);
});

test("mouse drag pans only when zoomed, clamps to image edges, and suppresses its trailing blank click", () => {
  const f = opened(); wheel(f, -Math.log(2) / .002);
  pointer(f, 'pointerdown', 1, 500, 380, { pointerType: 'mouse', target: f.displayed() });
  assert.equal(f.stage.hasPointerCapture(1), true);
  pointer(f, 'pointermove', 1, 1500, -1000, { pointerType: 'mouse' });
  assert.deepEqual(transform(f), { x: 400, y: -300, scale: 2 });
  pointer(f, 'pointerup', 1, 1500, -1000, { pointerType: 'mouse' });
  assert.equal(f.stage.hasPointerCapture(1), false);
  const clickAfterDrag = click(f.stage, { clientX: 110, clientY: 90 });
  assert.equal(f.controller.handleClick(clickAfterDrag), true);
  assert.equal(clickAfterDrag.defaultPrevented, true);
  assert.equal(f.controller.isOpen(), true);
  f.controller.handleClick(click(f.action('reset')));
  assert.deepEqual(transform(f), { x: 0, y: 0, scale: 1 });
});

test("unzoomed one-finger motion cannot pan or accidentally close on release", () => {
  const f = opened(fixture(), { naturalWidth: 1600, naturalHeight: 800 });
  pointer(f, 'pointerdown', 7, 200, 100);
  pointer(f, 'pointermove', 7, 300, 150);
  pointer(f, 'pointerup', 7, 300, 150);
  assert.deepEqual(transform(f), { x: 0, y: 0, scale: 1 });
  f.controller.handleClick(click(f.stage, { clientX: 300, clientY: 150 }));
  assert.equal(f.controller.isOpen(), true);
  f.advance(800);
  assert.equal(f.controller.handleClick(click(f.stage, { clientX: 200, clientY: 100 })), true);
  assert.equal(f.controller.isOpen(), false);
});

test("a captured image tap is not mistaken for stage whitespace; genuine letterbox tap closes", () => {
  for (const blank of [false, true]) {
    const f = opened(fixture(), { naturalWidth: 1600, naturalHeight: 800 });
    const [x, y] = blank ? [200, 100] : [500, 380];
    pointer(f, 'pointerdown', 1, x, y);
    pointer(f, 'pointerup', 1, x, y);
    const event = click(f.stage, { clientX: x, clientY: y });
    assert.equal(f.controller.handleClick(event), blank);
    assert.equal(f.controller.isOpen(), !blank);
  }
});

test("two-finger pinch anchors and translates its midpoint, then transitions to one-finger pan", () => {
  const f = opened();
  pointer(f, 'pointerdown', 1, 550, 380);
  pointer(f, 'pointerdown', 2, 750, 380);
  pointer(f, 'pointermove', 2, 950, 380);
  let t = transform(f);
  near(t.scale, 2); near(t.x, -50); near(t.y, 0);
  near(500 + t.x + 150 * t.scale, 750, 'pinch midpoint anchor');
  pointer(f, 'pointerup', 2, 950, 380);
  pointer(f, 'pointermove', 1, 600, 430);
  t = transform(f); near(t.x, 0); near(t.y, 50); near(t.scale, 2);
  pointer(f, 'pointerup', 1, 600, 430);
  assert.equal(f.stage.captured.size, 0);
  f.controller.handleClick(click(f.stage));
  assert.equal(f.controller.isOpen(), true, 'second lift must not close');
});

test("even a motionless two-finger gesture suppresses both lift clicks, while a new tap can close", () => {
  const f = opened(fixture(), { naturalWidth: 1600, naturalHeight: 800 });
  pointer(f, 'pointerdown', 1, 200, 100);
  pointer(f, 'pointerdown', 2, 300, 100);
  pointer(f, 'pointerup', 1, 200, 100);
  f.controller.handleClick(click(f.stage, { clientX: 200, clientY: 100 }));
  assert.equal(f.controller.isOpen(), true);
  pointer(f, 'pointerup', 2, 300, 100);
  f.controller.handleClick(click(f.stage, { clientX: 300, clientY: 100 }));
  assert.equal(f.controller.isOpen(), true);
  pointer(f, 'pointerdown', 3, 200, 100);
  pointer(f, 'pointerup', 3, 200, 100);
  f.controller.handleClick(click(f.stage, { clientX: 200, clientY: 100 }));
  assert.equal(f.controller.isOpen(), false, 'fresh intentional tap clears stale suppression');
});

test("pinch clamps minimum/maximum, handles coincident fingers and ignores a third pointer", () => {
  const f = opened();
  pointer(f, 'pointerdown', 1, 500, 380);
  pointer(f, 'pointerdown', 2, 500, 380);
  pointer(f, 'pointermove', 2, 600, 380);
  assert.equal(transform(f).scale, 8);
  const before = transform(f);
  pointer(f, 'pointerdown', 3, 900, 380);
  pointer(f, 'pointermove', 3, 1000, 380);
  assert.deepEqual(transform(f), before);
  assert.equal(f.stage.hasPointerCapture(3), false);
  pointer(f, 'pointermove', 2, 500, 380);
  assert.deepEqual(transform(f), { x: 0, y: 0, scale: 1 });
  pointer(f, 'pointerup', 2, 500, 380); pointer(f, 'pointerup', 1, 500, 380);
  assert.equal(f.stage.captured.size, 0);
});

test("pointerup displacement without a prior move still counts as a drag", () => {
  const f = opened();
  pointer(f, 'pointerdown', 1, 500, 380);
  pointer(f, 'pointerup', 1, 700, 500);
  f.controller.handleClick(click(f.dialog));
  assert.equal(f.controller.isOpen(), true);
});

test("pointercancel/lost capture release state, suppress stray clicks, and allow later gestures", () => {
  for (const type of ['pointercancel', 'lostpointercapture']) {
    const f = opened();
    pointer(f, 'pointerdown', 1, 500, 380);
    pointer(f, type, 1, 500, 380);
    assert.equal(f.stage.captured.size, 0);
    f.controller.handleClick(click(f.dialog));
    assert.equal(f.controller.isOpen(), true);
    pointer(f, 'pointerdown', 2, 500, 380);
    pointer(f, 'pointerup', 2, 500, 380);
    assert.equal(f.stage.captured.size, 0);
    f.controller.handleClick(click(f.dialog));
    assert.equal(f.controller.isOpen(), false);
  }
});

test("nonprimary/modified pointer input and toolbar pointers are not intercepted", () => {
  for (const extra of [{ button: 2 }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { target: 'toolbar' }]) {
    const f = opened();
    const event = pointer(f, 'pointerdown', 1, 500, 380, { ...extra, target: extra.target ? f.original() : f.stage });
    assert.equal(event.defaultPrevented, false);
    assert.equal(f.stage.hasPointerCapture(1), false);
  }
});

test("all structural whitespace closes: dialog padding, panel gaps, stage and toolbar gaps", () => {
  for (const selector of ['dialog', '.ld-image-preview-panel', '.ld-image-preview-stage', '.ld-image-preview-toolbar']) {
    const f = opened();
    const target = selector === 'dialog' ? f.dialog : f.dialog.querySelector(selector);
    assert.equal(f.controller.handleClick(click(target)), true, selector);
    assert.equal(f.controller.isOpen(), false, selector);
    assert.equal(f.readScroll.style.getPropertyValue('overflow'), '', selector);
  }
});

test("image, title, ratio, caption and loading/error text clicks do not dismiss", () => {
  const f = opened();
  const nodes = [f.displayed(), ...['title', 'ratio', 'caption', 'status'].map(name => f.dialog.querySelector(`.ld-image-preview-${name}`))];
  f.displayed().emit('error');
  for (const node of nodes) {
    assert.equal(f.controller.handleClick(click(node)), false);
    if (node.childNodes[0]) assert.equal(f.controller.handleClick(click(node.childNodes[0])), false);
    assert.equal(f.controller.isOpen(), true);
  }
  assert.equal(f.action('zoom-in').disabled, true);
});

test("original links and modifier/middle clicks remain native during and after gestures", () => {
  const f = opened();
  pointer(f, 'pointerdown', 1, 500, 380); pointer(f, 'pointermove', 1, 550, 380); pointer(f, 'pointerup', 1, 550, 380);
  for (const extra of [{}, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { button: 1 }]) {
    const event = click(f.original(), extra);
    assert.equal(f.controller.handleClick(event), false);
    assert.equal(event.defaultPrevented, false);
    assert.equal(f.controller.isOpen(), true);
  }
});

test("resize recomputes fit, clamps offsets, cancels active capture and ignores stale observers after close", () => {
  const f = opened(); wheel(f, -1000); wheel(f, -1000);
  pointer(f, 'pointerdown', 1, 500, 380); pointer(f, 'pointermove', 1, 10000, 10000);
  assert.deepEqual(transform(f), { x: 2800, y: 2100, scale: 8 });
  f.stage.rect = { left: 100, top: 80, width: 400, height: 300 };
  const observer = f.observers[0]; observer.fire();
  assert.deepEqual(transform(f), { x: 1400, y: 1050, scale: 8 });
  assert.equal(f.displayed().style.getPropertyValue('width'), '400px');
  assert.equal(f.stage.captured.size, 0);
  f.stage.rect = { left: 100, top: 80, width: 800, height: 600 };
  f.view.emit('resize');
  assert.equal(f.displayed().style.getPropertyValue('width'), '800px');
  f.controller.close();
  assert.equal(observer.observed.size, 0);
  assert.equal(f.view.listeners.get('resize').size, 0);
  assert.doesNotThrow(() => observer.callback([]));
});

test("close/destroy fully release pointers, observer, image events and reset the next open", () => {
  for (const destroy of [false, true]) {
    const f = opened(); wheel(f, -Math.log(2) / .002);
    pointer(f, 'pointerdown', 1, 500, 380); pointer(f, 'pointerdown', 2, 600, 380);
    const image = f.displayed(), observer = f.observers[0];
    if (destroy) f.controller.destroy(); else f.controller.close();
    assert.equal(f.stage.captured.size, 0);
    assert.equal(observer.observed.size, 0);
    assert.equal(f.view.listeners.get('resize').size, 0);
    assert.equal(image.hasAttribute('src'), false);
    for (const type of ['load', 'error']) assert.equal(image.listeners.get(type).size, 0);
    if (destroy) {
      for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture', 'wheel', 'touchmove']) assert.equal(f.dialog.listeners.get(type).size, 0);
    } else {
      f.controller.handleClick(click(f.images()[1])); f.displayed().emit('load');
      assert.deepEqual(transform(f), { x: 0, y: 0, scale: 1 });
      f.controller.handleClick(click(f.dialog)); assert.equal(f.controller.isOpen(), false);
    }
  }
});

test("keyboard +/−/0 zoom and reset without stealing modified browser shortcuts", () => {
  const f = opened();
  assert.equal(f.controller.handleKeydown(key('+', { shiftKey: true })), true);
  assert.equal(transform(f).scale, 1.25);
  f.controller.handleKeydown(key('-')); assert.equal(transform(f).scale, 1);
  f.controller.handleKeydown(key('='));
  for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
    assert.equal(f.controller.handleKeydown(key('+', modifiers)), false);
    assert.equal(transform(f).scale, 1.25);
  }
  f.controller.handleKeydown(key('0'));
  assert.deepEqual(transform(f), { x: 0, y: 0, scale: 1 });
});

test("CSS contains modal containment and image sizing without site-global selectors", () => {
  assert.match(css, /\.ld-image-preview::backdrop/);
  assert.match(css, /overscroll-behavior:\s*contain/);
  assert.match(css, /touch-action:\s*none/);
  assert.match(css, /object-fit:\s*contain/);
  assert.doesNotMatch(css, /(?:^|\n)(?:body|html|:root)\s*[{,]/);
});
