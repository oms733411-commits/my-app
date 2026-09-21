(() => {
  const BASE_DATA = "base-market.json";
  const originalFetch = window.fetch.bind(window);

  window.fetch = (input, init) => {
    let url = typeof input === "string" ? input : input?.url;
    if (url && /\/data\/market\.json(?:\?|$)/.test(url)) {
      const rewritten = url.replace(/\/data\/market\.json(?=\?|$)/, "/data/" + BASE_DATA);
      if (typeof input === "string") return originalFetch(rewritten, init);
      try {
        return originalFetch(new Request(rewritten, input), init);
      } catch (_) {
        return originalFetch(rewritten, init);
      }
    }
    return originalFetch(input, init);
  };

  const replaceModelText = () => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      if (!node.nodeValue) continue;
      node.nodeValue = node.nodeValue
        .replaceAll("Kronos-small", "Kronos-base")
        .replaceAll("Kronos Small", "Kronos Base")
        .replaceAll("24.7M", "102.3M");
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", replaceModelText, {once:true});
  } else {
    replaceModelText();
  }

  const observer = new MutationObserver(() => replaceModelText());
  observer.observe(document.documentElement, {subtree:true, childList:true, characterData:true});
})();