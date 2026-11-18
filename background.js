const openReader = { type: "linux-do-reader:open" };
const startURL = "https://linux.do/";

function isReaderHomepage(url) {
  try {
    const target = new URL(url);
    return target.origin === "https://linux.do" && target.pathname === "/";
  } catch {
    return false;
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id != null && isReaderHomepage(tab.url)) {
    const response = await chrome.tabs.sendMessage(tab.id, openReader).catch(() => null);
    if (response?.open) return;
  }
  await chrome.tabs.create({ url: startURL });
});
