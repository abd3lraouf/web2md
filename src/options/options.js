/**
 * MarkSnip Lite — Options Page
 *
 * Loads settings from storage, renders form controls, saves on change.
 * Three sections: Markdown formatting, Templates, AI Agents.
 */

(function () {
  "use strict";

  var settings = {};
  var SELECT_KEYS = [
    "headingStyle", "bulletListMarker", "codeBlockStyle", "fence",
    "emDelimiter", "strongDelimiter", "linkStyle", "hr",
    "defaultSendToTarget", "popupTheme"
  ];
  var CHECKBOX_KEYS = [
    "preserveCodeFormatting", "autoDetectCodeLanguage",
    "skipHiddenContent", "turndownEscape", "includeTemplate"
  ];
  var TEXT_KEYS = [
    "title", "frontmatter", "backmatter",
    "disallowedChars", "disallowedCharReplacement", "sendToMaxUrlLength"
  ];

  // -------------------------------------------------------------------------
  // Sidebar navigation
  // -------------------------------------------------------------------------

  function initNav() {
    var items = document.querySelectorAll(".sidebar__item");
    items.forEach(function (item) {
      item.addEventListener("click", function () {
        var section = item.getAttribute("data-section");
        items.forEach(function (i) {
          i.classList.toggle("sidebar__item--active", i === item);
        });
        document.querySelectorAll(".section").forEach(function (s) {
          s.classList.toggle("section--active", s.id === "section-" + section);
        });
      });
    });
  }

  // -------------------------------------------------------------------------
  // Load settings into form
  // -------------------------------------------------------------------------

  function populateForm(options) {
    settings = options;

    SELECT_KEYS.forEach(function (key) {
      var el = document.getElementById(key);
      if (el && options[key] !== undefined) el.value = options[key];
    });

    CHECKBOX_KEYS.forEach(function (key) {
      var el = document.getElementById(key);
      if (el) el.checked = options[key] === true;
    });

    TEXT_KEYS.forEach(function (key) {
      var el = document.getElementById(key);
      if (el && options[key] !== undefined) el.value = options[key];
    });

    renderCustomTargets(options.sendToCustomTargets || []);
  }

  // -------------------------------------------------------------------------
  // Save a single setting
  // -------------------------------------------------------------------------

  function save(key, value) {
    settings[key] = value;
    var patch = {};
    patch[key] = value;
    browser.storage.sync.set(patch).catch(function (err) {
      console.error("Failed to save " + key + ":", err);
    });
  }

  // -------------------------------------------------------------------------
  // Custom targets
  // -------------------------------------------------------------------------

  function renderCustomTargets(targets) {
    var container = document.getElementById("customTargetsList");
    container.innerHTML = "";

    (targets || []).forEach(function (target, idx) {
      var row = document.createElement("div");
      row.className = "custom-row";

      var nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.className = "card__input";
      nameInput.placeholder = "Agent name";
      nameInput.value = target.name || "";
      nameInput.addEventListener("input", function () {
        updateCustomTarget(idx, "name", nameInput.value);
      });

      var urlInput = document.createElement("input");
      urlInput.type = "text";
      urlInput.className = "card__input";
      urlInput.placeholder = "https://example.com/?q={prompt}";
      urlInput.value = target.urlTemplate || "";
      urlInput.addEventListener("input", function () {
        updateCustomTarget(idx, "urlTemplate", urlInput.value);
      });

      var removeBtn = document.createElement("button");
      removeBtn.className = "btn btn--danger btn--sm";
      removeBtn.textContent = "Remove";
      removeBtn.addEventListener("click", function () {
        removeCustomTarget(idx);
      });

      row.appendChild(nameInput);
      row.appendChild(urlInput);
      row.appendChild(removeBtn);
      container.appendChild(row);
    });
  }

  function getCustomTargets() {
    return Array.isArray(settings.sendToCustomTargets)
      ? settings.sendToCustomTargets
      : [];
  }

  function updateCustomTarget(idx, field, value) {
    var targets = getCustomTargets();
    if (!targets[idx]) targets[idx] = { id: "custom-" + Date.now() };
    targets[idx][field] = value;
    settings.sendToCustomTargets = targets;
    save("sendToCustomTargets", targets);
  }

  function removeCustomTarget(idx) {
    var targets = getCustomTargets();
    targets.splice(idx, 1);
    settings.sendToCustomTargets = targets;
    save("sendToCustomTargets", targets);
    renderCustomTargets(targets);
  }

  function addCustomTarget() {
    var targets = getCustomTargets();
    targets.push({ id: "custom-" + Date.now(), name: "", urlTemplate: "" });
    settings.sendToCustomTargets = targets;
    save("sendToCustomTargets", targets);
    renderCustomTargets(targets);
  }

  // -------------------------------------------------------------------------
  // Theme
  // -------------------------------------------------------------------------

  function applyTheme(theme) {
    var resolved = theme;
    if (theme === "system" || !theme) {
      resolved = window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
    }
    document.documentElement.setAttribute("data-theme", resolved);
  }

  // -------------------------------------------------------------------------
  // Export / Import
  // -------------------------------------------------------------------------

  function exportSettings() {
    var blob = new Blob([JSON.stringify(settings, null, 2)], {
      type: "application/json"
    });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "marksnip-settings.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  function importSettings(file) {
    var reader = new FileReader();
    reader.onload = function (e) {
      try {
        var imported = JSON.parse(e.target.result);
        browser.storage.sync.set(imported).then(function () {
          populateForm(Object.assign({}, settings, imported));
        });
      } catch (err) {
        alert("Invalid settings file: " + err.message);
      }
    };
    reader.readAsText(file);
  }

  // -------------------------------------------------------------------------
  // Init
  // -------------------------------------------------------------------------

  function init() {
    initNav();

    // Load settings
    browser.storage.sync.get(defaultOptions || {}).then(function (options) {
      populateForm(options);
      applyTheme(options.popupTheme);

      // Version
      var manifest = chrome.runtime.getManifest();
      var vEl = document.getElementById("versionInfo");
      if (vEl) vEl.textContent = "MarkSnip v" + manifest.version;
    });

    // Bind change listeners
    SELECT_KEYS.forEach(function (key) {
      var el = document.getElementById(key);
      if (el) {
        el.addEventListener("change", function () {
          save(key, el.value);
          if (key === "popupTheme") applyTheme(el.value);
        });
      }
    });

    CHECKBOX_KEYS.forEach(function (key) {
      var el = document.getElementById(key);
      if (el) {
        el.addEventListener("change", function () {
          save(key, el.checked);
        });
      }
    });

    TEXT_KEYS.forEach(function (key) {
      var el = document.getElementById(key);
      if (el) {
        el.addEventListener("input", function () {
          var val = key === "sendToMaxUrlLength" ? parseInt(el.value, 10) : el.value;
          save(key, val);
        });
      }
    });

    // Custom targets
    document.getElementById("addCustomTarget").addEventListener("click", addCustomTarget);

    // Export / Import
    document.getElementById("exportSettings").addEventListener("click", exportSettings);
    document.getElementById("importSettings").addEventListener("click", function () {
      document.getElementById("importFile").click();
    });
    document.getElementById("importFile").addEventListener("change", function (e) {
      if (e.target.files[0]) importSettings(e.target.files[0]);
    });
  }

  init();
})();
