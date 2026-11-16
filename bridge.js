(() => {
  // Runs in the site's MAIN world: the content script cannot directly access
  // Discourse's application owner. This bridge only refreshes frontend state;
  // the authenticated /topics/timings request is made by the isolated script.
  document.addEventListener("linux-do-reader:read", event => {
    try {
      const { topicId, lastRead } = JSON.parse(event.detail);
      if (!Number.isSafeInteger(topicId) || topicId <= 0 || !Number.isSafeInteger(lastRead) || lastRead <= 0) return;
      const owner = window.Discourse;
      const lookup = name => owner?.lookup?.(name) || owner?.__container__?.lookup(name);
      const tracking = lookup("service:topic-tracking-state");
      // updateSeen notifies Discourse's state subscribers; its native topic
      // list component then calls updateTopics on its own cached models.
      tracking?.updateSeen(topicId, lastRead);
    } catch {
      // Native internals may differ across Discourse versions. Server-side
      // progress remains authoritative and will be shown after a refresh.
    }
  });
})();
