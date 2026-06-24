// KidGemini Guard — service worker.
// 1) Proxies LLM safety checks to the app backend (host permission bypasses page CORS).
// 2) Persists parent alerts to chrome.storage and shows a badge count.

chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
  if (msg && msg.type === "classify") {
    classify(msg).then(sendResponse);
    return true; // keep the channel open for the async response
  }
  if (msg && msg.type === "alert") {
    recordAlert(msg);
    sendResponse({ ok: true });
  }
});

async function classify(msg) {
  try {
    const res = await fetch(msg.apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: msg.text, origin: msg.origin }),
    });
    if (!res.ok) return null;
    return await res.json(); // { action, category, severity, reason }
  } catch (e) {
    console.warn("[KidGemini Guard] safety API unreachable; using local rules only.", e);
    return null; // content script falls back to local-rules verdict
  }
}

function recordAlert(msg) {
  chrome.storage.local.get({ alerts: [] }, function (data) {
    const alerts = data.alerts;
    alerts.unshift({
      origin: msg.origin,
      category: msg.category,
      reason: msg.reason,
      action: msg.action,
      at: msg.at || Date.now(),
    });
    if (alerts.length > 200) alerts.length = 200;
    chrome.storage.local.set({ alerts: alerts });
    chrome.action.setBadgeText({ text: String(Math.min(alerts.length, 99)) });
    chrome.action.setBadgeBackgroundColor({ color: "#dc2626" });
  });
}
