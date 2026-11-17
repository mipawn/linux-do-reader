(() => {
  // Missing data, moderated/hidden content and an explicit deletion are different
  // states. In particular, an absent author or empty cooked HTML proves nothing.
  function isDeleted(post) {
    return post?.deleted === true || post?.user_deleted === true ||
      (typeof post?.deleted_at === "string" && post.deleted_at.trim() !== "");
  }

  function postState(post) {
    if (isDeleted(post)) return "deleted";
    if (!post || post.unavailable === true || post.hidden === true) return "unavailable";
    return "available";
  }

  function likeCount(post) {
    const count = post?.like_count;
    if (typeof count === "number" && Number.isFinite(count) && count >= 0) return count;
    const action = Array.isArray(post?.actions_summary) ? post.actions_summary.find(item => Number(item?.id) === 2) : null;
    return typeof action?.count === "number" && Number.isFinite(action.count) && action.count >= 0 ? action.count : 0;
  }

  function missingParent(floor) {
    if (!Number.isSafeInteger(floor) || floor <= 1) return null;
    // No username, cooked HTML, deletion marker or invented ancestry.
    return { post_number: floor, unavailable: true, placeholder: "missing-parent" };
  }

  function replyTree(posts, sort = "oldest") {
    const nodes = new Map();
    const roots = [];
    const input = typeof posts?.values === "function" ? posts.values() : posts || [];
    for (const post of input) {
      const floor = post?.post_number;
      if (!Number.isSafeInteger(floor) || floor <= 1 || nodes.has(floor)) continue;
      nodes.set(floor, { post, children: [], state: postState(post) });
    }
    // Discourse replies point to an earlier floor. Requiring that invariant
    // prevents cycles/self links and does not invent a parent for malformed data.
    const parentFloor = post => Number.isSafeInteger(post.reply_to_post_number) &&
      post.reply_to_post_number > 1 && post.reply_to_post_number < post.post_number
      ? post.reply_to_post_number : null;
    for (const node of [...nodes.values()]) {
      const floor = parentFloor(node.post);
      if (floor && !nodes.has(floor)) {
        const post = missingParent(floor);
        nodes.set(floor, { post, children: [], state: "unavailable" });
      }
    }
    for (const node of nodes.values()) {
      const parent = nodes.get(parentFloor(node.post));
      if (parent) parent.children.push(node);
      else roots.push(node);
    }

    const mode = ["oldest", "newest", "top"].includes(sort) ? sort : "oldest";
    const groups = [roots];
    while (groups.length) {
      const siblings = groups.pop();
      // If any timestamp is missing (e.g. a placeholder), use floor order for
      // this whole sibling group. A mixed timestamp/floor comparator is not
      // transitive and can produce unstable ordering.
      const dated = siblings.every(node => typeof node.post.created_at === "string" &&
        Number.isFinite(Date.parse(node.post.created_at)));
      siblings.sort((a, b) => {
        const tie = a.post.post_number - b.post.post_number;
        if (mode === "top") return likeCount(b.post) - likeCount(a.post) || tie;
        const order = dated
          ? Date.parse(a.post.created_at) - Date.parse(b.post.created_at)
          : tie;
        return (mode === "newest" ? -order : order) || tie;
      });
      for (const node of siblings) if (node.children.length) groups.push(node.children);
    }
    return roots;
  }

  globalThis.LDDiscussion = Object.freeze({ replyTree, isDeleted, postState, likeCount, missingParent });
})();
