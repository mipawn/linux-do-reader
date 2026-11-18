(() => {
  // Only the homepage may enable the reader. Route parsers below are helpers,
  // not permission to replace any native list, topic, category, tag or user page.
  function readerRoute(pathname) {
    return pathname === "/";
  }

  function topicRoute(path) {
    return path.match(/^\/t\/(?:([^/]+)\/)?(\d+)(?:\/(\d+))?\/?$/);
  }

  function feedRoute(pathname, search = "") {
    const parts = pathname.split("/").filter(Boolean);
    const view = ["latest", "new", "unseen", "hot", "top", "posted", "read", "bookmarks"].includes(parts[0]) ? parts[0] : "latest";
    const params = new URLSearchParams(search);
    params.delete("ld-reader");
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

  globalThis.LDNavigation = { readerRoute, topicRoute, feedRoute };
})();
