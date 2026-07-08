/**
 * DetoxWeb — Background Service Worker (background.js)
 *
 * Background scripts can make HTTP requests to localhost from any page
 * (no mixed-content restrictions). Content script routes API calls here.
 */

chrome.runtime.onInstalled.addListener(() => {
  console.log("[DetoxWeb] Extension installed/updated.");
});

// ─── Message Router ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {

  // API proxy: content script sends sentences, background fetches /predict
  if (message.type === "API_PREDICT") {
    fetch("http://127.0.0.1:8000/predict", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ sentences: message.sentences }),
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => {
        console.error("[DetoxWeb] /predict fetch failed:", err.message);
        sendResponse({ ok: false, error: err.message });
      });
    return true; // keep channel open for async response
  }
});
