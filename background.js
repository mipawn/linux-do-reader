const openReader = { type: "linux-do-reader:open" };
const startURL = "https://linux.do/?ld-reader=1";

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id != null) {
    const response = await chrome.tabs.sendMessage(tab.id, openReader).catch(() => null);
    if (response?.open) return;
  }
  await chrome.tabs.create({ url: startURL });
});
