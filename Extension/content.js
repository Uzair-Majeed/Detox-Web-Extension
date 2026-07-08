/**
 * DetoxWeb — Content Script v2.1 (content.js)
 *
 * Toggle detection: chrome.storage.onChanged (reliable on both Chrome & Firefox)
 * No message relay through background.js needed for toggle.
 * background.js only used for service worker lifecycle — not for messaging.
 */

// ─── Configuration ────────────────────────────────────────────────────────────
const BATCH_SIZE = 200;
const MIN_LENGTH = 8;   // minimum chars to bother classifying
const DEBOUNCE_MS = 1500;
const PROCESSED_ATTR = "data-detoxweb-done";

const SKIP_TAGS = new Set([
  "SCRIPT", "STYLE", "NOSCRIPT", "IFRAME", "OBJECT",
  "CODE", "PRE", "KBD", "SAMP", "VAR",
  "NAV", "HEADER", "FOOTER", "ASIDE", "BUTTON", "INPUT",
  "SELECT", "TEXTAREA", "LABEL", "META", "LINK", "HEAD",
  "H1", "H2", "H3", "H4", "H5", "H6",
]);

// ─── Module State ─────────────────────────────────────────────────────────────
const sentenceCache = new Map(); // sentence → { isToxic, probability }
let isEnabled = false;
let isProcessing = false;
let domObserver = null;
let debounceTimer = null;
const pendingNodes = new Set();
const stats = { scanned: 0, toxic: 0 };

const HOSTNAME = window.location.hostname;

// ─── Direct Message Listener (GET_STATS, UNBLUR_ALL from popup) ───────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "TOGGLE") {
    console.log(`[DetoxWeb] TOGGLE message received: enabled=${message.enabled}`);
    if (message.enabled !== isEnabled) {
      isEnabled = message.enabled;
      if (isEnabled) startScanning();
      else stopScanning();
    }
    sendResponse({ ok: true });
    return true;
  }
  if (message.type === "GET_STATS") {
    sendResponse({ stats: { ...stats } });
    return true;
  }
  if (message.type === "UNBLUR_ALL") {
    unblurAll();
    stats.scanned = 0;
    stats.toxic = 0;
    sendResponse({ ok: true });
    return true;
  }
});

const GLOBAL_KEY = "detoxweb_enabled"; // single global toggle, default ON

// ─── Storage Change Listener ──────────────────────────────────────────────────
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !(GLOBAL_KEY in changes)) return;
  const newEnabled = changes[GLOBAL_KEY].newValue ?? true;
  console.log(`[DetoxWeb] Global toggle: enabled=${newEnabled}`);
  if (newEnabled === isEnabled) return;
  isEnabled = newEnabled;
  if (isEnabled) startScanning();
  else stopScanning();
});

// ─── Enabled State Check ──────────────────────────────────────────────────────
async function checkEnabled() {
  return new Promise((resolve) => {
    chrome.storage.local.get(GLOBAL_KEY, (result) => {
      resolve(result[GLOBAL_KEY] ?? true); // default: ON
    });
  });
}

// ─── Scanner Lifecycle ────────────────────────────────────────────────────────
function startScanning() {
  console.log("[DetoxWeb] startScanning() — waiting 4s dwell delay…");

  if (!domObserver) {
    domObserver = new MutationObserver(handleMutations);
  }
  domObserver.observe(document.body, { childList: true, subtree: true });

  // 3-second dwell delay: only scan if user stays on this page
  // If they navigate away, this content script is destroyed and the timeout never fires
  setTimeout(() => {
    console.log("[DetoxWeb] Dwell delay passed — starting page scan.");
    if (!isEnabled) return; // check again in case toggle flipped during delay
    if ("requestIdleCallback" in window) {
      requestIdleCallback(() => processRoot(document.body), { timeout: 5000 });
    } else {
      processRoot(document.body);
    }
  }, 4000);
}

function stopScanning() {
  console.log("[DetoxWeb] stopScanning() called.");
  if (domObserver) domObserver.disconnect();
  clearTimeout(debounceTimer);
  pendingNodes.clear();
  unblurAll();
  document.querySelectorAll(`[${PROCESSED_ATTR}]`).forEach((el) => {
    el.removeAttribute(PROCESSED_ATTR);
  });
  sentenceCache.clear();
  stats.scanned = 0;
  stats.toxic = 0;
}

// ─── Mutation Observer ────────────────────────────────────────────────────────
function handleMutations(mutations) {
  if (!isEnabled) return;
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      if (node.classList?.contains("detoxweb-wrapper")) continue;
      if (node.classList?.contains("detoxweb-candidate")) continue;
      if (node.textContent.trim().length >= MIN_LENGTH) {
        pendingNodes.add(node);
      }
    }
  }

  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    if (pendingNodes.size === 0 || isProcessing) return;
    const roots = [...pendingNodes];
    pendingNodes.clear();
    if ("requestIdleCallback" in window) {
      requestIdleCallback(() => processRoots(roots), { timeout: 3000 });
    } else {
      processRoots(roots);
    }
  }, DEBOUNCE_MS);
}

// ─── Core Processing ──────────────────────────────────────────────────────────
async function processRoots(roots) {
  if (!isEnabled || isProcessing) return;
  isProcessing = true;
  try {
    const allPairs = [];
    for (const root of roots) {
      for (const node of collectTextNodes(root)) {
        allPairs.push(...wrapTextNode(node));
      }
    }
    await classifyAndApply(allPairs);
  } finally {
    isProcessing = false;
  }
}

async function processRoot(root) {
  if (!isEnabled || isProcessing) return;
  console.log("[DetoxWeb] processRoot() starting full page scan…");
  isProcessing = true;
  try {
    const nodes = collectTextNodes(root);
    const allPairs = [];
    for (const node of nodes) {
      allPairs.push(...wrapTextNode(node));
    }
    console.log(`[DetoxWeb] Found ${allPairs.length} sentence spans to classify.`);
    await classifyAndApply(allPairs);
  } finally {
    isProcessing = false;
  }
}

async function classifyAndApply(allPairs) {
  if (allPairs.length === 0) {
    console.log("[DetoxWeb] No sentences to classify.");
    return;
  }

  // Group spans by sentence text (dedup)
  const sentenceToSpans = new Map();
  for (const { sentence, span } of allPairs) {
    if (!sentenceToSpans.has(sentence)) sentenceToSpans.set(sentence, []);
    sentenceToSpans.get(sentence).push(span);
  }

  stats.scanned += allPairs.length;

  // Apply cached results instantly
  for (const [sentence, spans] of sentenceToSpans) {
    if (sentenceCache.has(sentence)) {
      const cached = sentenceCache.get(sentence);
      if (cached.isToxic) {
        spans.forEach((span) => applyToxicBlur(span, cached.probability));
        stats.toxic += spans.length;
      }
    }
  }

  // Only send uncached sentences to API
  const uncached = [...sentenceToSpans.keys()].filter((s) => !sentenceCache.has(s));

  if (uncached.length === 0) {
    console.log("[DetoxWeb] All sentences served from cache.");
    return;
  }

  console.log(`[DetoxWeb] Sending ${uncached.length} sentences to /predict…`);

  for (let i = 0; i < uncached.length; i += BATCH_SIZE) {
    const chunk = uncached.slice(i, i + BATCH_SIZE);
    const results = await fetchClassifications(chunk);
    if (!results) continue;

    for (const result of results) {
      const entry = { isToxic: result.is_toxic, probability: result.probability };
      sentenceCache.set(result.sentence, entry);
      if (result.is_toxic) {
        (sentenceToSpans.get(result.sentence) ?? []).forEach((span) =>
          applyToxicBlur(span, result.probability)
        );
        stats.toxic += (sentenceToSpans.get(result.sentence) ?? []).length;
      }
    }
  }
}

// ─── API Call (proxied through background.js to bypass mixed-content blocks) ──
async function fetchClassifications(sentences) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "API_PREDICT",
      sentences,
    });
    if (!response || !response.ok) {
      console.error("[DetoxWeb] API error:", response?.error ?? "no response");
      return null;
    }
    console.log(`[DetoxWeb] /predict OK — ${response.data.results.length} results, ${response.data.results.filter(r => r.is_toxic).length} toxic.`);
    return response.data.results;
  } catch (err) {
    console.error("[DetoxWeb] Background message failed:", err.message);
    return null;
  }
}


// ─── DOM Helpers ──────────────────────────────────────────────────────────────
function isHidden(el) {
  if (!el) return true;
  const style = window.getComputedStyle(el);
  return (
    style.display === "none" || style.visibility === "hidden" ||
    style.opacity === "0" || el.offsetParent === null
  );
}

function collectTextNodes(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
      if (parent.hasAttribute(PROCESSED_ATTR)) return NodeFilter.FILTER_REJECT;
      if (isHidden(parent)) return NodeFilter.FILTER_SKIP;
      if (node.textContent.trim().length < MIN_LENGTH) return NodeFilter.FILTER_SKIP;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  let cur;
  while ((cur = walker.nextNode())) nodes.push(cur);
  return nodes;
}

/**
 * Wraps an entire text node in ONE candidate span.
 * No sentence splitting — avoids partial blurs.
 * The whole text content is classified as a single unit.
 */
function wrapTextNode(textNode) {
  const parent = textNode.parentElement;
  if (!parent) return [];

  const text = textNode.textContent.replace(/\s+/g, " ").trim();
  if (text.length < MIN_LENGTH) return [];

  parent.setAttribute(PROCESSED_ATTR, "1");

  const span = document.createElement("span");
  span.className = "detoxweb-candidate";
  span.textContent = textNode.textContent; // preserve original spacing
  textNode.replaceWith(span);

  return [{ span, sentence: text }];
}

// ─── Visual Layer ─────────────────────────────────────────────────────────────
function applyToxicBlur(span, probability) {
  if (!span.isConnected || span.closest(".detoxweb-wrapper")) return;

  const wrapper = document.createElement("span");
  wrapper.className = "detoxweb-wrapper";

  const blurSpan = document.createElement("span");
  blurSpan.className = "detoxweb-blurred";
  blurSpan.textContent = span.textContent;
  blurSpan.title = `DetoxWeb: ${(probability * 100).toFixed(1)}% toxic — click to reveal`;

  const revealBtn = document.createElement("button");
  revealBtn.className = "detoxweb-reveal-btn";
  revealBtn.textContent = "👁 Reveal";
  revealBtn.setAttribute("aria-label", "Reveal hidden toxic content");
  revealBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const revealed = blurSpan.classList.toggle("detoxweb-revealed");
    revealBtn.textContent = revealed ? "🙈 Hide" : "👁 Reveal";
  });

  wrapper.appendChild(blurSpan);
  wrapper.appendChild(revealBtn);
  span.replaceWith(wrapper);
}

function unblurAll() {
  document.querySelectorAll(".detoxweb-wrapper").forEach((wrapper) => {
    const blurSpan = wrapper.querySelector(".detoxweb-blurred");
    if (blurSpan) wrapper.replaceWith(document.createTextNode(blurSpan.textContent));
  });
}

// ─── Initialise ───────────────────────────────────────────────────────────────
(async function init() {
  isEnabled = await checkEnabled();
  console.log(`[DetoxWeb] Init on "${HOSTNAME}" — enabled=${isEnabled}`);
  if (isEnabled) startScanning();
})();
