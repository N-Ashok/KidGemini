// KidGemini Guard — content script for gemini.google.com.
// Watches for each model response, blurs it while it streams, buffers the text,
// classifies it (local rules + optional LLM via the app's /api/safety), then either
// reveals it or replaces it with a kid-friendly redirect and alerts the parent.
//
// NOTE: Gemini's DOM is undocumented and changes often. If guarding stops working,
// update RESPONSE_SELECTOR below (or via the popup) to match the new markup.

(function () {
  "use strict";

  var DEFAULTS = {
    enabled: true,
    strictness: "strict",
    apiUrl: "http://localhost:3000/api/safety", // set "" to use local rules only
    // Comma-separated CSS selectors for a completed model response container.
    responseSelector:
      "message-content.model-response-text, model-response, .model-response-text",
  };
  var STABLE_MS = 1000; // treat streaming as done after this much quiet
  var MAX_WAIT_MS = 35000; // safety cap so we never hide forever

  var config = Object.assign({}, DEFAULTS);

  chrome.storage.local.get("config", function (data) {
    if (data && data.config) config = Object.assign({}, DEFAULTS, data.config);
    if (config.enabled) start();
  });

  function start() {
    var observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var added = mutations[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var node = added[j];
          if (node.nodeType !== 1) continue;
          scan(node);
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    // Catch anything already on the page.
    scan(document.body);
    console.log("[KidGemini Guard] active. selector:", config.responseSelector);
  }

  function scan(root) {
    var matches = [];
    if (root.matches && root.matches(config.responseSelector)) matches.push(root);
    if (root.querySelectorAll) {
      var found = root.querySelectorAll(config.responseSelector);
      for (var i = 0; i < found.length; i++) matches.push(found[i]);
    }
    for (var k = 0; k < matches.length; k++) guard(matches[k]);
  }

  function guard(node) {
    if (node.dataset.kgGuarded) return;
    node.dataset.kgGuarded = "1";

    node.classList.add("kg-checking");
    var overlay = addOverlay(node, "checking", "🛡️ Checking…");

    var startedAt = Date.now();
    var timer = null;
    function settle() {
      cleanup();
      classifyAndApply(node, overlay);
    }
    function bump() {
      if (timer) clearTimeout(timer);
      if (Date.now() - startedAt > MAX_WAIT_MS) return settle();
      timer = setTimeout(settle, STABLE_MS);
    }
    var streamObserver = new MutationObserver(bump);
    streamObserver.observe(node, { childList: true, subtree: true, characterData: true });
    function cleanup() {
      if (timer) clearTimeout(timer);
      streamObserver.disconnect();
    }
    bump(); // start the debounce even if no further mutations
  }

  function classifyAndApply(node, overlay) {
    var text = (node.innerText || "").trim();
    if (!text) return reveal(node, overlay);

    // Layer 0: local deterministic rules (instant).
    var local = window.KidGeminiRules.classifyLocal(text, "model");
    if (local.action === "hard_block") return blockNode(node, overlay, local);

    // Layer 2: optional LLM check via the app backend (through the service worker,
    // which has host permission and bypasses page CORS).
    if (!config.apiUrl) return reveal(node, overlay);

    chrome.runtime.sendMessage(
      { type: "classify", text: text, origin: "model", apiUrl: config.apiUrl },
      function (resp) {
        if (chrome.runtime.lastError || !resp) return reveal(node, overlay); // fail open on infra error? -> see note
        if (resp.action && resp.action !== "allow") return blockNode(node, overlay, resp);
        reveal(node, overlay);
      }
    );
  }

  function reveal(node, overlay) {
    node.classList.remove("kg-checking");
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
  }

  function blockNode(node, overlay, verdict) {
    node.classList.remove("kg-checking");
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    node.innerHTML =
      '<div class="kg-blocked-note">🌟 Let\'s talk about something else! ' +
      "How about a fun fact, a story, or a game?</div>";
    chrome.runtime.sendMessage({
      type: "alert",
      origin: "model",
      category: verdict.category || null,
      reason: verdict.reason || "Blocked",
      action: verdict.action || "hard_block",
      at: Date.now(),
    });
    console.warn("[KidGemini Guard] blocked a response:", verdict);
  }

  function addOverlay(node, kind, label) {
    if (getComputedStyle(node).position === "static") node.style.position = "relative";
    var el = document.createElement("div");
    el.className = "kg-overlay kg-overlay--" + kind;
    el.textContent = label;
    node.appendChild(el);
    return el;
  }
})();
