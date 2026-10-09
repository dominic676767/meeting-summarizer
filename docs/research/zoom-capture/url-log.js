// Paste this file into the extension service worker's DevTools Console.
// See README.md in this directory for the temporary host permissions.
(() => {
  if (!globalThis.chrome?.tabs?.onUpdated) {
    throw new Error("Use the extension service worker Console.");
  }
  if (typeof globalThis.zoomUrlStop === "function") globalThis.zoomUrlStop();

  let listener;
  globalThis.zoomUrlLog = [];

  globalThis.zoomUrlTabs = async () => {
    const tabs = await chrome.tabs.query({
      url: ["https://zoom.us/*", "https://*.zoom.us/*"],
    });
    console.table(tabs.map(({ id, title, url }) => ({ id, title, url })));
  };

  globalThis.zoomUrlStop = () => {
    if (listener) chrome.tabs.onUpdated.removeListener(listener);
    listener = undefined;
  };

  globalThis.zoomUrlStart = async (tabId) => {
    if (!Number.isInteger(tabId)) throw new Error("Enter a tab ID from zoomUrlTabs().");
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url) {
      throw new Error("The tab URL is not available. Check the Zoom host permissions.");
    }

    globalThis.zoomUrlStop();
    globalThis.zoomUrlLog = [
      {
        at: new Date().toISOString(),
        event: "initial",
        tabId,
        observedTabUrl: tab.url,
      },
    ];
    listener = (updatedTabId, change, updatedTab) => {
      if (updatedTabId !== tabId) return;
      if (change.url === undefined && change.status === undefined) return;
      const entry = {
        at: new Date().toISOString(),
        event: "tabs.onUpdated",
        tabId,
        changeUrl: change.url ?? null,
        status: change.status ?? null,
        observedTabUrl: updatedTab.url ?? null,
      };
      globalThis.zoomUrlLog.push(entry);
      console.log(entry);
    };
    chrome.tabs.onUpdated.addListener(listener);
    console.info("URL log started for tab", tabId, "Keep this Console open.");
  };

  console.info("Run await zoomUrlTabs(), then await zoomUrlStart(TAB_ID).");
})();
