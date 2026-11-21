(() => {
  const actions = new Set(["poll-option", "poll-submit", "poll-results", "poll-remove"]);
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);
  const votesFor = (post, name) => own(post.polls_votes, name) && Array.isArray(post.polls_votes[name])
    ? post.polls_votes[name].map(String) : [];
  const count = value => Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0;

  // Host delegates clicks to handle(action, DOM target). render(post) returns
  // sections to append; local selection/result changes repaint those sections.
  // Only a successful native receipt invokes onChange(post); current failures
  // invoke onError(error) unchanged. No timer, background fetch or write replay.
  function create({ forum, document, getContext, onChange = () => {}, onError = () => {} }) {
    let destroyed = false;
    const details = new WeakMap();
    const bindings = new WeakMap();

    function element(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }
    function button(action, text) {
      const node = element("button", "poll-button", text);
      node.type = "button";
      node.dataset.action = action;
      return node;
    }
    function html(tag, className, value) {
      const node = element(tag, className);
      node.append(forum.cooked(typeof value === "string" ? value : String(value ?? "")));
      return node;
    }
    function polls(post) { return Array.isArray(post?.polls) ? post.polls : []; }
    function getPost(detail, id) { return detail?.posts?.get(Number(id)); }
    function getPoll(post, name) { return polls(post).find(poll => String(poll.name) === name); }
    function closed(poll) {
      const deadline = Date.parse(poll.close);
      return poll.status === "closed" || Number.isFinite(deadline) && deadline <= Date.now();
    }
    function groupAllowed(user, poll) {
      if (!poll.groups) return true;
      const permitted = String(poll.groups).split(",").map(name => name.trim().toLowerCase()).filter(Boolean);
      const groups = Array.isArray(user?.visibleGroups) ? user.visibleGroups : Array.isArray(user?.groups) ? user.groups : [];
      return groups.some(group => permitted.includes(String(typeof group === "string" ? group : group?.name || "").toLowerCase()));
    }
    function supported(poll) { return !poll.type || ["regular", "multiple", "number"].includes(poll.type); }
    function voteReason(context, post, poll) {
      if (!supported(poll)) return "此类投票请前往原站参与。";
      if (!context.user?.id) return "登录原站后才能投票。";
      if (closed(poll)) return "此投票已结束。";
      if (context.detail?.data?.archived) return "话题已归档，不能投票或取消投票。";
      if (post.deleted || post.user_deleted || post.hidden || post.unavailable ||
          typeof post.deleted_at === "string" && post.deleted_at.trim()) return "此楼层暂不可操作。";
      if (!groupAllowed(context.user, poll)) return "此投票仅限指定用户组参与。";
      return "";
    }
    function resultsAllowed(context, post, poll) {
      switch (poll.results || "always") {
        case "always": return true;
        case "on_vote": return closed(poll) || !!context.detail?.data?.archived || votesFor(post, String(poll.name)).length > 0 ||
          !!context.user?.id && String(context.user.id) === String(post.user_id);
        case "on_close": return closed(poll);
        case "staff_only": return !!(context.user?.staff || context.user?.admin || context.user?.moderator);
        default: return false;
      }
    }
    function resultsReason(poll) {
      return poll.results === "on_close" ? "投票结束后可查看结果。"
        : poll.results === "staff_only" ? "投票结果仅工作人员可见。"
          : "投票后可查看结果。";
    }
    function stateFor(detail, post, poll) {
      let states = details.get(detail);
      if (!states) { states = new Map(); details.set(detail, states); }
      const key = JSON.stringify([String(post.id), String(poll.name)]);
      let state = states.get(key);
      if (!state) {
        const vote = votesFor(post, String(poll.name));
        state = { selected: new Set(vote), voteSignature: JSON.stringify(vote), results: vote.length > 0,
          busy: false, error: "", roots: new Set() };
        states.set(key, state);
      }
      // Live post replacements must not retain an obsolete personal ballot.
      const vote = votesFor(post, String(poll.name)), signature = JSON.stringify(vote);
      if (!state.busy && state.voteSignature !== signature) {
        state.selected = new Set(vote); state.voteSignature = signature; state.results = vote.length > 0;
      }
      const ids = new Set((poll.options || []).map(option => String(option.id)));
      state.selected = new Set([...state.selected].filter(id => ids.has(id)));
      return state;
    }
    function limits(poll) {
      const size = (poll.options || []).length;
      const min = Number(poll.min), max = Number(poll.max);
      return { min: Number.isInteger(min) && min > 0 ? min : 1,
        max: Number.isInteger(max) && max > 0 ? Math.min(max, size) : size };
    }
    function originalLink(context, post) {
      const link = element("a", "poll-original-link", "前往原站查看和参与投票");
      const topic = context.detail?.data || { id: post.topic_id };
      const path = forum.topicPath ? forum.topicPath(topic, post.post_number) : `/t/topic/${Number(post.topic_id)}/${Number(post.post_number) || 1}`;
      link.href = new URL(path, forum.siteURL || "https://linux.do").href;
      link.target = "_blank"; link.rel = "noopener noreferrer";
      return link;
    }
    function paint(root, context, post, poll, state) {
      root.replaceChildren();
      root.setAttribute("aria-busy", String(state.busy));
      const title = poll.title ? html("div", "poll-title cooked", poll.title) : element("h4", "poll-title", "投票");
      root.append(title);
      if (!supported(poll)) {
        root.append(element("p", "poll-notice", poll.type === "ranked_choice"
          ? "排序投票需使用原站界面，阅读器不会将其当作普通单选投票。" : "此类投票暂不支持，请使用原站界面。"), originalLink(context, post));
        return;
      }
      const allowed = resultsAllowed(context, post, poll);
      const forced = closed(poll) || !!context.detail?.data?.archived;
      const showResults = allowed && (state.results || forced);
      const reason = voteReason(context, post, poll);
      const options = element("div", "poll-options");
      const voters = count(poll.voters);
      for (const option of Array.isArray(poll.options) ? poll.options : []) {
        const id = String(option.id), selected = state.selected.has(id);
        if (showResults) {
          const row = element("div", `poll-result${votesFor(post, String(poll.name)).includes(id) ? " is-voted" : ""}`);
          row.dataset.optionId = id;
          const percent = voters > 0 ? Math.min(100, count(option.votes) / voters * 100) : 0;
          const bar = element("span", "poll-result-bar"); bar.style.setProperty("--poll-percent", `${percent}%`); bar.setAttribute("aria-hidden", "true");
          const stats = element("span", "poll-result-stats", `${count(option.votes)} 票 · ${Math.round(percent)}%`);
          row.append(bar, html("span", "poll-option-label cooked", option.html), stats);
          options.append(row);
        } else {
          const choice = button("poll-option");
          choice.className = `poll-option${selected ? " is-selected" : ""}`;
          choice.dataset.optionId = id;
          choice.setAttribute("role", poll.type === "multiple" ? "checkbox" : "radio");
          choice.setAttribute("aria-checked", String(selected));
          choice.disabled = state.busy || !!reason;
          const marker = element("span", `poll-option-marker${poll.type === "multiple" ? " is-multiple" : ""}`, selected ? "✓" : "");
          marker.setAttribute("aria-hidden", "true");
          choice.append(marker, html("span", "poll-option-label cooked", option.html));
          options.append(choice);
        }
      }
      options.setAttribute("role", showResults ? "list" : poll.type === "multiple" ? "group" : "radiogroup");
      options.setAttribute("aria-label", "投票选项");
      root.append(options);
      if (showResults && poll.type === "number") {
        const weighted = poll.options.reduce((sum, option) => sum + parseInt(option.html, 10) * count(option.votes), 0);
        const average = voters > 0 ? weighted / voters : null;
        if (average !== null && Number.isFinite(average)) {
          root.append(element("p", "poll-average", `平均值：${average.toFixed(2)}`));
        }
      }
      const footer = element("div", "poll-footer");
      footer.append(element("span", "poll-voters", `${voters} 人参与`));
      if (poll.public === true) {
        const visibility = element("span", "poll-notice", "公开投票");
        visibility.title = "原站可能向其他用户展示你的投票身份。";
        footer.append(visibility);
      }
      if (poll.type === "multiple" && !showResults) {
        const { min, max } = limits(poll);
        footer.append(element("span", "poll-limits", min === max ? `请选择 ${min} 项` : `请选择 ${min}–${max} 项`));
        const submit = button("poll-submit", state.busy ? "提交中…" : "提交投票");
        submit.disabled = state.busy || !!reason || state.selected.size < min || state.selected.size > max;
        footer.append(submit);
      }
      if (allowed && voters > 0 && !(showResults && forced)) {
        const toggle = button("poll-results", showResults ? "返回投票" : "查看结果");
        toggle.disabled = state.busy;
        footer.append(toggle);
      }
      if (votesFor(post, String(poll.name)).length > 0 && !reason) {
        const remove = button("poll-remove", state.busy ? "处理中…" : "取消投票");
        remove.disabled = state.busy;
        footer.append(remove);
      }
      root.append(footer);
      if (!allowed) root.append(element("p", "poll-notice", resultsReason(poll)));
      if (reason) root.append(element("p", "poll-notice", reason));
      if (state.busy) root.append(element("p", "poll-notice", "正在向原站提交，请勿重复操作。"));
      if (state.error) {
        const error = element("p", "poll-error", state.error); error.setAttribute("role", "alert"); root.append(error);
      }
    }
    function current(detail) {
      const context = getContext();
      return !destroyed && context?.onScreen && context.detail === detail && !detail.controller?.signal?.aborted ? context : null;
    }
    function repaint(detail, post, poll, state) {
      const context = current(detail);
      if (!context) return;
      for (const root of state.roots) {
        if (!root.isConnected) { state.roots.delete(root); continue; }
        paint(root, context, post, poll, state);
      }
    }
    function render(post) {
      const context = getContext();
      if (destroyed || !context?.detail || !post) return [];
      return polls(post).filter(poll => poll && typeof poll.name === "string" && Array.isArray(poll.options)).map(poll => {
        const root = element("section", "ld-poll");
        root.dataset.pollName = poll.name; root.dataset.postId = post.id;
        const state = stateFor(context.detail, post, poll);
        for (const previous of state.roots) if (!previous.isConnected) state.roots.delete(previous);
        state.roots.add(root);
        bindings.set(root, { detail: context.detail, postId: post.id, name: poll.name, state });
        paint(root, context, post, poll, state);
        return root;
      });
    }
    async function handle(action, target) {
      if (!actions.has(action) || destroyed) return false;
      const root = target?.closest?.("section[data-poll-name][data-post-id]");
      const binding = root && bindings.get(root);
      if (!binding || !root.isConnected) return false;
      const { detail, postId, name, state } = binding;
      const context = current(detail), post = getPost(detail, postId), poll = getPoll(post, name);
      if (!context || !post || !poll) return false;
      if (state.busy) return true;
      stateFor(detail, post, poll);
      if (action === "poll-results") {
        if (resultsAllowed(context, post, poll) && count(poll.voters) > 0 && !closed(poll) && !detail.data?.archived) {
          state.results = !state.results; state.error = ""; repaint(detail, post, poll, state);
        }
        return true;
      }
      const reason = voteReason(context, post, poll);
      if (reason) { state.error = reason; repaint(detail, post, poll, state); return true; }
      if (action === "poll-option") {
        const control = target.closest('[data-action="poll-option"]');
        const id = control?.dataset.optionId;
        if (!control || !root.contains(control) || !(poll.options || []).some(option => String(option.id) === id)) return true;
        state.error = "";
        if (poll.type === "multiple") {
          if (state.selected.has(id)) state.selected.delete(id);
          else if (state.selected.size < limits(poll).max) state.selected.add(id);
          else state.error = `最多只能选择 ${limits(poll).max} 项。`;
          repaint(detail, post, poll, state);
          return true;
        }
        if (votesFor(post, name).length === 1 && votesFor(post, name)[0] === id) return true;
        state.selected = new Set([id]);
      } else if (action === "poll-submit") {
        if (poll.type !== "multiple") return true;
        const { min, max } = limits(poll);
        if (state.selected.size < min || state.selected.size > max) {
          state.error = `请选择 ${min === max ? min : `${min}–${max}`} 项后提交。`;
          repaint(detail, post, poll, state); return true;
        }
      } else if (action === "poll-remove" && !votesFor(post, name).length) return true;
      const remove = action === "poll-remove";
      const body = { post_id: Number(post.id), poll_name: name };
      if (!remove) body.options = [...state.selected];
      state.busy = true; state.error = ""; repaint(detail, post, poll, state);
      try {
        // forum.change owns CSRF, pacing and server failures. Never retry a write.
        const result = await forum.change("/polls/vote", remove ? "DELETE" : "PUT", body, { signal: detail.controller?.signal });
        if (!current(detail)) return true;
        if (!result?.poll || String(result.poll.name) !== name || !Array.isArray(result.poll.options)) {
          throw new Error("原站未返回有效的投票结果；未自动重试，请前往原站确认是否已提交。");
        }
        const latest = getPost(detail, postId), latestPoll = getPoll(latest, name);
        if (!latest || !latestPoll) return true;
        latest.polls = latest.polls.map(item => String(item.name) === name ? { ...item, ...result.poll } : item);
        const ballot = { ...(latest.polls_votes || {}) };
        if (remove) delete ballot[name];
        else Object.defineProperty(ballot, name, { value: body.options, enumerable: true, configurable: true, writable: true });
        latest.polls_votes = ballot;
        state.selected = new Set(remove ? [] : body.options);
        state.voteSignature = JSON.stringify(remove ? [] : body.options);
        state.results = !remove;
        state.busy = false;
        repaint(detail, latest, getPoll(latest, name), state);
        onChange(latest);
      } catch (error) {
        if (!current(detail)) return true;
        const latest = getPost(detail, postId), latestPoll = getPoll(latest, name);
        state.error = error?.message || "投票操作失败；未自动重试，请前往原站确认。";
        if (poll.type !== "multiple") state.selected = new Set(votesFor(latest || post, name));
        state.busy = false;
        if (latest && latestPoll) repaint(detail, latest, latestPoll, state);
        onError(error);
      } finally {
        state.busy = false;
      }
      return true;
    }
    function destroy() { destroyed = true; }
    return { render, handle, destroy };
  }
  globalThis.LDPolls = { create };
})();
