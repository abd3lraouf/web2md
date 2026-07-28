/**
 * MarkSnip Lite Popup
 *
 * Clips the current page to Markdown, displays it in an editor,
 * and lets the user copy or send to an AI agent.
 *
 * Reuses the existing service-worker + offscreen clipping pipeline.
 */

(function () {
  "use strict";

  // -------------------------------------------------------------------------
  // Constants
  // -------------------------------------------------------------------------

  var SEND_TO_TARGETS = {
    chatgpt: {
      id: "chatgpt",
      label: "ChatGPT",
      urlTemplate: "https://chatgpt.com/?q={prompt}",
      fallbackUrl: "https://chatgpt.com/"
    },
    claude: {
      id: "claude",
      label: "Claude",
      urlTemplate: "https://claude.ai/new?q={prompt}",
      fallbackUrl: "https://claude.ai/new"
    },
    perplexity: {
      id: "perplexity",
      label: "Perplexity",
      urlTemplate: "https://perplexity.ai/search/new?q={prompt}",
      fallbackUrl: "https://perplexity.ai/search/new"
    }
  };

  var MAX_URL_LENGTH = 8000;

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  var currentOptions = null;
  var clipMode = "selection"; // "selection" or "document"

  // -------------------------------------------------------------------------
  // DOM helpers
  // -------------------------------------------------------------------------

  function el(id) {
    return document.getElementById(id);
  }

  function showSpinner(show) {
    el("spinner").style.display = show ? "" : "none";
    el("container").hidden = show;
  }

  function showError(message) {
    var err = el("error");
    err.textContent = message;
    err.hidden = false;
    el("spinner").style.display = "none";
    el("container").hidden = true;
  }

  function getEditorValue() {
    return el("editor").value;
  }

  function setEditorValue(text) {
    el("editor").value = text;
    updateCharCount();
  }

  function updateCharCount() {
    el("charCount").textContent = getEditorValue().length;
  }

  // -------------------------------------------------------------------------
  // Clipping
  // -------------------------------------------------------------------------

  function isRestrictedUrl(url) {
    if (!url) return true;
    return /^chrome:|chrome-extension:|about:|moz-extension:|edge:/i.test(url);
  }

  function getActiveTab() {
    return browser.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
      return tabs && tabs[0] ? tabs[0] : null;
    });
  }

  function ensureContentScript(tabId) {
    return browser.scripting
      .executeScript({ target: { tabId: tabId }, files: ["/browser-polyfill.min.js"] })
      .then(function () {
        return browser.scripting.executeScript({
          target: { tabId: tabId },
          files: ["/contentScript/contentScript.js"]
        });
      })
      .catch(function () {
        // Content script may already be injected — that's fine.
      });
  }

  function clipTab(tab) {
    var captureOptions = {
      skipHiddenContent: currentOptions ? currentOptions.skipHiddenContent === true : false
    };

    return browser.scripting
      .executeScript({
        target: { tabId: tab.id },
        func: function (opts) {
          if (typeof marksnipPrepareForCapture === "function") {
            marksnipPrepareForCapture();
          }
          if (typeof getSelectionAndDom === "function") {
            return getSelectionAndDom(opts);
          }
          return null;
        },
        args: [captureOptions]
      })
      .then(function (result) {
        if (!result || !result[0] || !result[0].result) return;

        var captured = result[0].result;
        var hasNativeOffscreen =
          typeof chrome !== "undefined" && !!chrome.offscreen;

        var message = {
          type: "clip",
          dom: captured.dom,
          selection: captured.selection,
          pageUrl: captured.pageUrl || tab.url || null,
          offscreenBridgeReady: !hasNativeOffscreen
        };

        var opts = currentOptions || defaultOptions || {};
        return browser.runtime.sendMessage(Object.assign({}, message, opts));
      });
  }

  // -------------------------------------------------------------------------
  // Incoming messages (markdown from service worker)
  // -------------------------------------------------------------------------

  function onMessage(message) {
    if (message.type === "display.md") {
      el("titleInput").value = (message.article && message.article.title) || "";
      setEditorValue(message.markdown);
      showSpinner(false);

      // Store metadata for re-clip
      currentOptions = currentOptions || {};
      if (message.effectiveOptions) {
        currentOptions = Object.assign({}, currentOptions, message.effectiveOptions);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Copy to clipboard
  // -------------------------------------------------------------------------

  function copyToClipboard() {
    var text = getEditorValue();
    if (!text.trim()) return;

    var btn = el("copyBtn");
    var originalHTML = btn.innerHTML;

    navigator.clipboard
      .writeText(text)
      .then(function () {
        btn.innerHTML =
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Copied!';
        btn.classList.add("btn--success");
        setTimeout(function () {
          btn.innerHTML = originalHTML;
          btn.classList.remove("btn--success");
        }, 2000);
      })
      .catch(function () {
        btn.innerHTML = "Failed";
        btn.classList.add("btn--error");
        setTimeout(function () {
          btn.innerHTML = originalHTML;
          btn.classList.remove("btn--error");
        }, 2000);
      });
  }

  // -------------------------------------------------------------------------
  // Send to AI agent
  // -------------------------------------------------------------------------

  function resolveTarget(targetId) {
    if (SEND_TO_TARGETS[targetId]) return SEND_TO_TARGETS[targetId];

    var customs = normalizeCustomTargets(
      currentOptions ? currentOptions.sendToCustomTargets : null
    );
    for (var i = 0; i < customs.length; i++) {
      if (customs[i].id === targetId) return customs[i];
    }
    return null;
  }

  function normalizeCustomTargets(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(function (t) {
        return t && t.urlTemplate && t.name;
      })
      .map(function (t) {
        return {
          id: t.id || t.name,
          label: t.name,
          urlTemplate: t.urlTemplate,
          fallbackUrl: t.urlTemplate.replace("{prompt}", "")
        };
      });
  }

  function sendToAI(targetId) {
    var content = getEditorValue();
    if (!content.trim()) return;

    var target = resolveTarget(targetId);
    if (!target) return;

    var encoded = encodeURIComponent(content);
    var launchUrl = String(target.urlTemplate || "").replace("{prompt}", encoded);
    var fallbackUrl = String(target.fallbackUrl || "").replace("{prompt}", "");
    var needsClipboardFallback = launchUrl.length > MAX_URL_LENGTH;

    function openTab() {
      browser.tabs
        .create({ url: needsClipboardFallback ? fallbackUrl : launchUrl })
        .then(function () {
          window.close();
        });
    }

    if (needsClipboardFallback) {
      navigator.clipboard.writeText(content).then(openTab);
    } else {
      openTab();
    }
  }

  // -------------------------------------------------------------------------
  // Custom targets UI
  // -------------------------------------------------------------------------

  function renderCustomTargets() {
    var container = el("customTargets");
    container.innerHTML = "";
    var customs = normalizeCustomTargets(
      currentOptions ? currentOptions.sendToCustomTargets : null
    );
    customs.forEach(function (t) {
      var btn = document.createElement("button");
      btn.className = "btn btn--ai";
      btn.textContent = t.label;
      btn.addEventListener("click", function () {
        sendToAI(t.id);
      });
      container.appendChild(btn);
    });
  }

  // -------------------------------------------------------------------------
  // Theme
  // -------------------------------------------------------------------------

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    var btn = el("themeToggle");
    btn.innerHTML =
      theme === "dark"
        ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.2" y1="4.2" x2="5.6" y2="5.6"/><line x1="18.4" y1="18.4" x2="19.8" y2="19.8"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.2" y1="19.8" x2="5.6" y2="18.4"/><line x1="18.4" y1="5.6" x2="19.8" y2="4.2"/></svg>'
        : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  }

  function toggleTheme() {
    var current = document.documentElement.getAttribute("data-theme") || "light";
    var next = current === "dark" ? "light" : "dark";
    applyTheme(next);
    browser.storage.sync.set({ popupTheme: next }).catch(function () {});
  }

  // -------------------------------------------------------------------------
  // Mode toggle (Selection / Document)
  // -------------------------------------------------------------------------

  function setMode(mode) {
    clipMode = mode;
    el("modeSelection").classList.toggle("segment--active", mode === "selection");
    el("modeDocument").classList.toggle("segment--active", mode === "document");

    if (!currentOptions) return;
    var newClipSelection = mode === "selection";
    if (currentOptions.clipSelection === newClipSelection) return;

    currentOptions.clipSelection = newClipSelection;
    browser.storage.sync.set({ clipSelection: newClipSelection }).then(function () {
      getActiveTab().then(function (tab) {
        if (tab && tab.id) {
          showSpinner(true);
          ensureContentScript(tab.id).then(function () {
            return clipTab(tab);
          });
        }
      });
    });
  }

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  function init() {
    browser.runtime.onMessage.addListener(onMessage);

    // Event listeners
    el("copyBtn").addEventListener("click", copyToClipboard);
    el("sendChatgpt").addEventListener("click", function () {
      sendToAI("chatgpt");
    });
    el("sendClaude").addEventListener("click", function () {
      sendToAI("claude");
    });
    el("sendPerplexity").addEventListener("click", function () {
      sendToAI("perplexity");
    });
    el("themeToggle").addEventListener("click", toggleTheme);
    el("modeSelection").addEventListener("click", function () {
      setMode("selection");
    });
    el("modeDocument").addEventListener("click", function () {
      setMode("document");
    });
    el("editor").addEventListener("input", updateCharCount);

    // Load options, determine theme, clip the page
    browser.storage.sync
      .get(defaultOptions || {})
      .then(function (options) {
        currentOptions = options;

        // Theme
        var theme = options.popupTheme;
        if (!theme) {
          theme = window.matchMedia("(prefers-color-scheme: dark)").matches
            ? "dark"
            : "light";
        }
        applyTheme(theme);

        // Mode toggle
        clipMode = options.clipSelection === false ? "document" : "selection";
        el("modeSelection").classList.toggle("segment--active", clipMode === "selection");
        el("modeDocument").classList.toggle("segment--active", clipMode === "document");

        // Custom targets
        renderCustomTargets();

        // Clip
        return getActiveTab();
      })
      .then(function (tab) {
        if (!tab || !tab.id) {
          showError("No active tab found");
          return;
        }
        if (isRestrictedUrl(tab.url)) {
          showError("Cannot clip this page (restricted URL)");
          return;
        }
        ensureContentScript(tab.id).then(function () {
          return clipTab(tab);
        });
      })
      .catch(function (err) {
        console.error("Popup init error:", err);
        showError(err.message || "Failed to initialize");
      });
  }

  init();
})();
