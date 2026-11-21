import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = name => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const context = vm.createContext({});
vm.runInContext(source("discussions.js"), context);
const { replyTree, isDeleted, postState, likeCount, missingParent, reactionSummary, boosts, relatedLinks, referenceKey } = context.LDDiscussion;
const plain = value => JSON.parse(JSON.stringify(value));
const floors = nodes => Array.from(nodes, node => node.post.post_number);
const post = (floor, parent, likes = 0) => ({
  id: 100 + floor, post_number: floor, reply_to_post_number: parent,
  like_count: likes, created_at: `2026-11-17T00:${String(floor).padStart(2, "0")}:00Z`
});

test("empty input and original post never become reply nodes", () => {
  assert.deepEqual(floors(replyTree()), []);
  assert.deepEqual(floors(replyTree([post(1), null, { post_number: "2" }, { post_number: -1 }])), []);
});

test("two-pass construction preserves ancestry regardless of input order", () => {
  const tree = replyTree([post(8, 5), post(5, 2), post(2, 1), post(4, 1)]);
  assert.deepEqual(floors(tree), [2, 4]);
  assert.deepEqual(floors(tree[0].children), [5]);
  assert.deepEqual(floors(tree[0].children[0].children), [8]);
});

test("missing parent is a shared unavailable placeholder, not a deletion claim", () => {
  const tree = replyTree([post(5, 2), post(7, 2)]);
  assert.deepEqual(floors(tree), [2]);
  assert.equal(tree[0].state, "unavailable");
  assert.deepEqual(plain(tree[0].post), { post_number: 2, unavailable: true, placeholder: "missing-parent" });
  assert.equal(isDeleted(tree[0].post), false);
  assert.deepEqual(floors(tree[0].children), [5, 7]);
  for (const field of ["cooked", "username", "deleted", "deleted_at", "reply_to_post_number"]) assert.equal(field in tree[0].post, false, field);
});

test("loading a formerly absent parent replaces placeholder and restores its real ancestry", () => {
  const posts = [post(9, 5), post(2, 1)];
  assert.equal(replyTree(posts).find(node => node.post.post_number === 5).state, "unavailable");
  posts.push(post(5, 2));
  const tree = replyTree(posts);
  assert.deepEqual(floors(tree), [2]);
  assert.equal(tree[0].children[0].state, "available");
  assert.deepEqual(floors(tree[0].children[0].children), [9]);
});

test("explicitly deleted parents and their loaded descendants remain in the tree", () => {
  const removed = { ...post(2, 1), deleted_at: "2026-11-17T02:00:00Z", cooked: "OLD SECRET", username: "former-user" };
  const tree = replyTree([post(6, 4), post(4, 2), removed]);
  assert.equal(tree[0].state, "deleted");
  assert.equal(tree[0].post, removed);
  assert.deepEqual(floors(tree[0].children), [4]);
  assert.deepEqual(floors(tree[0].children[0].children), [6]);
});

test("only explicit deletion flags justify the deleted state", () => {
  for (const value of [{ deleted: true }, { user_deleted: true }, { deleted_at: "2026-01-01T00:00:00Z" }]) {
    assert.equal(isDeleted(value), true);
    assert.equal(postState(value), "deleted");
  }
  for (const value of [{ cooked: "" }, { username: null }, { deleted: false }, { deleted: "false" }, { deleted_at: null }, { deleted_at: " " }, { hidden: true }, { unavailable: true }, {}]) {
    assert.equal(isDeleted(value), false, JSON.stringify(value));
  }
  assert.equal(postState({ hidden: true }), "unavailable");
  assert.equal(postState({ hidden: true, deleted: true }), "deleted");
  assert.equal(postState({ username: null, cooked: "" }), "available");
});

test("oldest and newest reorder sibling groups recursively without flattening", () => {
  const posts = [post(8, 2), post(3, 1), post(6, 2), post(2, 1), post(9, 6), post(7, 6)];
  const oldest = replyTree(posts, "oldest"), newest = replyTree(posts, "newest");
  assert.deepEqual(floors(oldest), [2, 3]);
  assert.deepEqual(floors(oldest[0].children), [6, 8]);
  assert.deepEqual(floors(oldest[0].children[0].children), [7, 9]);
  assert.deepEqual(floors(newest), [3, 2]);
  assert.deepEqual(floors(newest[1].children), [8, 6]);
  assert.deepEqual(floors(newest[1].children[1].children), [9, 7]);
});

test("oldest follows native floor order while newest follows dates with stable floor ties", () => {
  const a = { ...post(2), created_at: "2026-11-17T02:00:00Z" };
  const b = { ...post(3), created_at: "2026-11-17T01:00:00Z" };
  const c = { ...post(4), created_at: b.created_at };
  assert.deepEqual(floors(replyTree([c, b, a], "oldest")), [2, 3, 4]);
  assert.deepEqual(floors(replyTree([c, b, a], "newest")), [2, 3, 4]);
});

test("incomplete dates use a transitive floor ordering for the entire sibling group", () => {
  const posts = [{ ...post(2), created_at: "2026-11-17T02:00:00Z" }, { ...post(3), created_at: "invalid" }, { ...post(4), created_at: "2026-11-17T01:00:00Z" }];
  assert.deepEqual(floors(replyTree(posts, "oldest")), [2, 3, 4]);
  assert.deepEqual(floors(replyTree(posts, "newest")), [4, 3, 2]);
});

test("top uses post likes, not descendant popularity, with recursive stable floor ties", () => {
  const tree = replyTree([post(5, 2, 8), post(3, 1, 10), post(2, 1, 2), post(7, 2, 9), post(4, 2, 9), post(6, 3, 100)], "top");
  assert.deepEqual(floors(tree), [3, 2]);
  assert.deepEqual(floors(tree[1].children), [4, 7, 5]);
  assert.deepEqual(floors(tree[0].children), [6]);
});

test("likes prefer explicit like_count including zero, then Discourse action id 2", () => {
  assert.equal(likeCount({ like_count: 0, actions_summary: [{ id: 2, count: 99 }] }), 0);
  assert.equal(likeCount({ like_count: 3, actions_summary: [{ id: 2, count: 99 }] }), 3);
  assert.equal(likeCount({ actions_summary: [{ id: 3, count: 99 }, { id: 2, count: 8 }] }), 8);
  assert.equal(likeCount({ actions_summary: [{ id: "2", count: 6 }] }), 6);
  assert.equal(likeCount({ like_count: -1, actions_summary: [{ id: 2, count: 4 }] }), 4);
  for (const value of [null, {}, { like_count: Infinity }, { actions_summary: {} }, { actions_summary: [null] }, { actions_summary: [{ id: 2, count: -5 }] }]) assert.equal(likeCount(value), 0);
});

test("top action-summary fallback works at roots and nested siblings", () => {
  const tree = replyTree([{ ...post(3), like_count: undefined, actions_summary: [{ id: 2, count: 8 }] }, post(2, 1, 6), post(7, 2, 1), { ...post(5, 2), like_count: undefined, actions_summary: [{ id: 2, count: 4 }] }], "top");
  assert.deepEqual(floors(tree), [3, 2]);
  assert.deepEqual(floors(tree[1].children), [5, 7]);
});

test("unknown sort defaults to oldest, duplicates do not create duplicate floors", () => {
  assert.deepEqual(floors(replyTree([post(3), post(2), post(2)], "unexpected")), [2, 3]);
});

test("self, forward, fractional and invalid parent references cannot introduce cycles", () => {
  const tree = replyTree([post(2, 2), post(3, 8), post(4, 3.5), post(5, -1), post(6, "2"), post(7, 1)]);
  assert.deepEqual(floors(tree), [2, 3, 4, 5, 6, 7]);
  assert.ok(tree.every(node => node.children.length === 0));
  for (const floor of [1, 0, -1, "2", Infinity, 2.5]) assert.equal(missingParent(floor), null);
});

test("array, Map, Set and values iterator input work without mutating source posts", () => {
  const posts = [Object.freeze(post(3, 2)), Object.freeze(post(2, 1))];
  const before = JSON.stringify(posts);
  for (const input of [posts, new Map(posts.map(p => [p.id, p])), new Set(posts), new Map(posts.map(p => [p.id, p])).values()]) {
    assert.deepEqual(floors(replyTree(input, "newest")), [2]);
  }
  assert.equal(JSON.stringify(posts), before);
  assert.deepEqual(posts.map(p => p.post_number), [3, 2]);
});

test("deep trees are built and sorted iteratively without call-stack overflow", () => {
  const posts = Array.from({ length: 12000 }, (_, i) => ({ post_number: i + 2, reply_to_post_number: i + 1 }));
  let nodes = replyTree(posts, "top"), count = 0;
  while (nodes.length) { assert.equal(nodes.length, 1); count++; nodes = nodes[0].children; }
  assert.equal(count, posts.length);
});

test("reaction summaries keep positive counts, dedupe ids and use one honest total", () => {
  assert.deepEqual(plain(reactionSummary({ reactions: [
    { id: "heart", type: "emoji", count: 59 }, { id: "+1", type: "emoji", count: 2 },
    { id: "tieba_087", type: "emoji", count: 1 }, { id: "heart", type: "emoji", count: 60 }
  ], reaction_users_count: 62 })), { reactions: [
    { id: "heart", count: 59 }, { id: "+1", count: 2 }, { id: "tieba_087", count: 1 }
  ], total: 62 });
  // Missing/zero reaction_users_count falls back to the sum of the reactions.
  assert.deepEqual(plain(reactionSummary({ reactions: [{ id: "heart", count: 4 }, { id: "clap", count: 2 }], reaction_users_count: 0 })),
    { reactions: [{ id: "heart", count: 4 }, { id: "clap", count: 2 }], total: 6 });
  // A like-only post without reaction data still surfaces its like count.
  assert.deepEqual(plain(reactionSummary({ actions_summary: [{ id: 2, count: 8 }] })),
    { reactions: [{ id: "heart", count: 8 }], total: 8 });
  for (const value of [null, {}, { reactions: "x" }, { reactions: [null, { id: "", count: 3 }, { id: "x", count: -1 }] }]) {
    assert.deepEqual(plain(reactionSummary(value)), { reactions: [], total: 0 });
  }
  // The caller's order is not trusted: the server sorts by count, equal counts stay stable by id.
  const sorted = reactionSummary({ reactions: [{ id: "b", count: 1 }, { id: "a", count: 5 }, { id: "c", count: 1 }], reaction_users_count: 7 });
  assert.deepEqual(plain(sorted.reactions.map(item => item.id)), ["a", "b", "c"]);
});

test("boost bubbles keep cooked HTML and a renderable user, dropping malformed entries", () => {
  const list = boosts({ boosts: [
    { id: 1, cooked: "<p>前排</p>", can_delete: true, user: { id: 7, username: "neo", name: "Neo", avatar_template: "/a/{size}.png" } },
    { id: 1, cooked: "<p>dup</p>", user: { username: "dup" } },
    { id: 2, cooked: "  ", user: { username: "empty" } },
    { id: 3, cooked: "<p>x</p>" },
    { id: 4, cooked: "<p>y</p>", user: { id: "9", username: "rel", avatar_template: 7 } }
  ] });
  assert.deepEqual(plain(list), [
    { id: 1, cooked: "<p>前排</p>", can_delete: true, user: { id: 7, username: "neo", name: "Neo", avatar_template: "/a/{size}.png" } },
    { id: 4, cooked: "<p>y</p>", can_delete: false, user: { id: null, username: "rel", name: "", avatar_template: null } }
  ]);
  assert.deepEqual(plain(boosts({ boosts: "x" })), []);
});

test("related links keep only inbound references, fold floor variants and sort by clicks", () => {
  const post = { link_counts: [
    { url: "https://github.com/x", internal: false, reflection: false, clicks: 300, title: "outbound" },
    { url: "https://linux.do/t/topic/11", internal: true, reflection: true, clicks: 5, title: "十一" },
    { url: "https://linux.do/t/some-slug/22/3", internal: true, reflection: true, clicks: 40, title: "二十二" },
    { url: "https://linux.do/t/topic/22", internal: true, reflection: true, clicks: 7, title: "二十二" },
    { url: "https://linux.do/t/topic/33", internal: true, reflection: true, clicks: 0, title: "" }
  ] };
  assert.deepEqual(plain(relatedLinks(post)), [
    { url: "https://linux.do/t/some-slug/22/3", clicks: 40, title: "二十二" },
    { url: "https://linux.do/t/topic/11", clicks: 5, title: "十一" },
    { url: "https://linux.do/t/topic/33", clicks: 0, title: "https://linux.do/t/topic/33" }
  ]);
  assert.deepEqual(plain(relatedLinks({ link_counts: [] })), []);
  assert.deepEqual(plain(relatedLinks(null)), []);
  assert.equal(referenceKey("https://linux.do/t/topic/22"), "topic:22");
  assert.equal(referenceKey("https://linux.do/t/some-slug/22/3"), "topic:22");
  assert.equal(referenceKey("/t/22/3"), "topic:22");
  // Topic-id folding is path based so it also covers /t/ URLs without a slug.
  assert.equal(referenceKey("https://example.com/t/x/22"), "topic:22");
  assert.equal(referenceKey("https://example.com/a"), "url:https://example.com/a");
});

// Exercise only the delegated functions, without booting the extension or a
// browser. A deleted post must never reach cooked(), author anchors or avatars.
function renderFixture() {
  class FakeNode {
    constructor(tag, className = "", text) { this.tag = tag; this.className = className; this.children = []; this.textContent = text || ""; this.classList = { add: (...names) => { this.className += " " + names.join(" "); } }; }
    append(...nodes) { this.children.push(...nodes); }
  }
  const calls = [];
  const context = vm.createContext({
    polls: null,
    LDDiscussion: globalThisDiscussions(),
    element: (tag, className, text) => new FakeNode(tag, className, text),
    add: (node, ...children) => { node.append(...children.filter(child => child != null)); return node; },
    forum: { cooked: value => { calls.push(["cooked", value]); return "SANITIZED"; } },
    anchor: (...args) => { calls.push(["anchor", ...args]); return new FakeNode("a"); },
    avatar: (...args) => { calls.push(["avatar", ...args]); return new FakeNode("span"); }
  });
  const reader = source("reader.js");
  const start = reader.indexOf("  function replyPerson("), end = reader.indexOf("  function renderReading(", start);
  vm.runInContext(reader.slice(start, end), context);
  return { context, calls };
}
function globalThisDiscussions() { return context.LDDiscussion; }

test("deleted authors and bodies never expose old usernames, avatars or cooked content", () => {
  const { context, calls } = renderFixture();
  const removed = { ...post(2), user_deleted: true, username: "OLD USER", display_username: "OLD NAME", avatar_template: "/secret", cooked: "OLD SECRET", trust_level: 4 };
  const author = context.replyPerson(removed, true), content = context.postContent(removed);
  assert.equal(author.children[0].textContent, "[已删除]");
  assert.equal(content.textContent, "[此楼层已删除]");
  assert.deepEqual(calls, []);
});

test("missing or hidden content avoids deletion claims and bypasses stale cooked rendering", () => {
  const { context, calls } = renderFixture();
  const missing = context.postContent(missingParent(2));
  assert.match(missing.textContent, /未加载或不可用/);
  assert.match(missing.textContent, /无法判断是否已删除/);
  const hidden = context.postContent({ hidden: true, cooked: "OLD SECRET" });
  assert.equal(hidden.textContent, "此楼层内容暂不可用。");
  assert.deepEqual(calls, []);
  context.postContent({ cooked: "VISIBLE" });
  assert.deepEqual(calls, [["cooked", "VISIBLE"]]);
});
