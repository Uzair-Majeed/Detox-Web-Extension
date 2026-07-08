/**
 * DetoxWeb — Popup Script v3 (popup.js)
 *
 * Single global ON/OFF toggle. Default: ON.
 * Persisted in chrome.storage.local under "detoxweb_enabled".
 * Works across all sites, all tabs, forever until the user turns it off.
 */

const GLOBAL_KEY = "detoxweb_enabled";

// ─── DOM refs ────────────────────────────────────────────────────────────────
const apiBadgeEl  = document.getElementById("api-badge");
const apiLabelEl  = document.getElementById("api-label");
const toggleCard  = document.getElementById("toggle-card");
const toggleInput = document.getElementById("toggle-input");
const toggleSub   = document.getElementById("toggle-sub");
const statScanned = document.getElementById("stat-scanned");
const statToxic   = document.getElementById("stat-toxic");
const cardScanned = document.getElementById("card-scanned");
const cardToxic   = document.getElementById("card-toxic");
const resetBtn    = document.getElementById("reset-btn");

// ─── State ───────────────────────────────────────────────────────────────────
let currentTabId  = null;
let isEnabled     = true; // default ON
let statsInterval = null;

// ─── Init ────────────────────────────────────────────────────────────────────
(async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) currentTabId = tab.id;

  // Read global enabled state
  chrome.storage.local.get(GLOBAL_KEY, (result) => {
    isEnabled = result[GLOBAL_KEY] ?? true;
    renderToggle();
  });

  pingApi();
  fetchStats();
  statsInterval = setInterval(fetchStats, 2000);
})();

// ─── Toggle ──────────────────────────────────────────────────────────────────
toggleInput.addEventListener("change", async () => {
  isEnabled = toggleInput.checked;
  renderToggle();

  // Write global state — all content scripts pick it up via storage.onChanged
  chrome.storage.local.set({ [GLOBAL_KEY]: isEnabled });

  // Also message the current tab's content script directly as a fallback
  if (currentTabId) {
    try {
      await chrome.tabs.sendMessage(currentTabId, { type: "TOGGLE", enabled: isEnabled });
    } catch { /* content script not on this page */ }
  }

  if (!isEnabled) updateStats({ scanned: 0, toxic: 0 });
});

toggleCard.addEventListener("click", (e) => {
  if (e.target === toggleInput) return;
  toggleInput.checked = !toggleInput.checked;
  toggleInput.dispatchEvent(new Event("change"));
});

function renderToggle() {
  toggleInput.checked = isEnabled;
  toggleCard.classList.toggle("active", isEnabled);
  toggleSub.textContent = isEnabled
    ? "ON — filtering all websites"
    : "OFF — click to re-enable";
  resetBtn.disabled = !isEnabled;
  cardScanned.classList.toggle("dimmed", !isEnabled);
  cardToxic.classList.toggle("dimmed", !isEnabled);
}

// ─── Stats ────────────────────────────────────────────────────────────────────
async function fetchStats() {
  if (!isEnabled || !currentTabId) return;
  try {
    const response = await chrome.tabs.sendMessage(currentTabId, { type: "GET_STATS" });
    if (response?.stats) updateStats(response.stats);
  } catch { /* tab has no content script */ }
}

function updateStats({ scanned, toxic }) {
  statScanned.textContent = formatCount(scanned);
  statToxic.textContent   = formatCount(toxic);
}

function formatCount(n) {
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

// ─── Reset ────────────────────────────────────────────────────────────────────
resetBtn.addEventListener("click", async () => {
  if (!currentTabId) return;
  try {
    await chrome.tabs.sendMessage(currentTabId, { type: "UNBLUR_ALL" });
  } catch { /* ignore */ }
  updateStats({ scanned: 0, toxic: 0 });
});

// ─── API Health ───────────────────────────────────────────────────────────────
async function pingApi() {
  try {
    // Dynamically load the '.env' file
    const envRes = await fetch(chrome.runtime.getURL(".env"));
    const envText = await envRes.text();
    const env = {};
    envText.split('\n').forEach(line => {
      const [key, ...rest] = line.split('=');
      if (key && rest.length > 0) env[key.trim()] = rest.join('=').trim();
    });

    const HEALTH_URL = env.ENDPOINT_BASE_URL + "/health";
    const res = await fetch(HEALTH_URL, {
      method: "GET",
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      apiBadgeEl.className  = "api-badge online";
      apiLabelEl.textContent = "API Online";
    } else throw new Error();
  } catch {
    apiBadgeEl.className  = "api-badge offline";
    apiLabelEl.textContent = "API Offline";
  }
}

window.addEventListener("unload", () => clearInterval(statsInterval));
