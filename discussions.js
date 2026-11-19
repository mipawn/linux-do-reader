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

  function positiveCount(value) {
    const count = Number(value);
    return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  }

  // Reactions are the original site's emoji summary under a post. The server
  // already orders them by count; re-sorting keeps a stable tie order and the
  // total falls back to the sum when reaction_users_count is absent, so a
  // partially serialized post still shows one honest number.
  function reactionSummary(post) {
    const reactions = [];
    const seen = new Set();
    for (const raw of Array.isArray(post?.reactions) ? post.reactions : []) {
      const id = typeof raw?.id === "string" ? raw.id.trim() : "";
      const count = positiveCount(raw?.count);
      if (!id || !count || seen.has(id)) continue;
      seen.add(id);
      reactions.push({ id, count });
    }
    reactions.sort((a, b) => b.count - a.count || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const total = positiveCount(post?.reaction_users_count) ||
      reactions.reduce((sum, reaction) => sum + reaction.count, 0) || likeCount(post);
    if (!reactions.length && total) reactions.push({ id: "heart", count: total });
    return { reactions, total };
  }

  // Boosts are the original site's short "表情评论" bubbles: a user avatar plus
  // sanitized cooked HTML. Keep only entries that can be rendered honestly.
  function boosts(post) {
    const result = [];
    const seen = new Set();
    for (const raw of Array.isArray(post?.boosts) ? post.boosts : []) {
      const user = raw?.user;
      const cooked = typeof raw?.cooked === "string" ? raw.cooked.trim() : "";
      if (!cooked || !user || typeof user !== "object") continue;
      const key = Number.isSafeInteger(raw?.id) ? raw.id : null;
      if (key != null && seen.has(key)) continue;
      if (key != null) seen.add(key);
      result.push({
        id: Number.isSafeInteger(raw?.id) ? raw.id : null,
        cooked,
        can_delete: raw?.can_delete === true,
        user: {
          id: Number.isSafeInteger(user.id) ? user.id : null,
          username: typeof user.username === "string" ? user.username : "",
          name: typeof user.name === "string" ? user.name : "",
          avatar_template: typeof user.avatar_template === "string" ? user.avatar_template : null
        }
      });
    }
    return result;
  }

  // A topic link and its floor variants are the same reference. Comparing the
  // first numeric segment after /t/ folds /t/slug/123/4 into /t/123.
  function referenceKey(url) {
    const raw = typeof url === "string" ? url : "";
    const path = raw.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "").replace(/[?#].*$/, "");
    const segments = path.split("/").filter(Boolean);
    const index = segments.indexOf("t");
    if (index < 0) return "url:" + raw;
    for (let cursor = index + 1; cursor < segments.length; cursor++) {
      if (/^\d+$/.test(segments[cursor])) return "topic:" + segments[cursor];
    }
    return "url:" + raw;
  }

  // Related links are the original site's inbound references ("被以下帖子引用").
  // Outbound links stay inline in the cooked post, exactly like the original.
  function relatedLinks(post) {
    const links = (Array.isArray(post?.link_counts) ? post.link_counts : [])
      .filter(link => link && link.reflection === true && typeof link.url === "string" && link.url.trim())
      .map(link => ({
        url: link.url,
        clicks: positiveCount(link.clicks),
        title: typeof link.title === "string" && link.title.trim() ? link.title.trim() : link.url
      }))
      .sort((a, b) => b.clicks - a.clicks || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
    const seen = new Set();
    const result = [];
    for (const link of links) {
      const key = referenceKey(link.url);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(link);
    }
    return result;
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

  globalThis.LDDiscussion = Object.freeze({
    replyTree, isDeleted, postState, likeCount, missingParent, reactionSummary, boosts, relatedLinks, referenceKey
  });
})();
