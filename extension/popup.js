// Parent controls + recent alerts. Reads/writes chrome.storage.local.

var DEFAULTS = {
  enabled: true,
  strictness: "strict",
  apiUrl: "http://localhost:3000/api/safety",
  responseSelector:
    "message-content.model-response-text, model-response, .model-response-text",
};

var $ = function (id) { return document.getElementById(id); };

function load() {
  chrome.storage.local.get({ config: DEFAULTS, alerts: [] }, function (data) {
    var c = Object.assign({}, DEFAULTS, data.config);
    $("enabled").checked = c.enabled;
    $("strictness").value = c.strictness;
    $("apiUrl").value = c.apiUrl;
    $("responseSelector").value = c.responseSelector;
    renderAlerts(data.alerts);
  });
}

function save() {
  var config = {
    enabled: $("enabled").checked,
    strictness: $("strictness").value,
    apiUrl: $("apiUrl").value.trim(),
    responseSelector: $("responseSelector").value.trim() || DEFAULTS.responseSelector,
  };
  chrome.storage.local.set({ config: config }, function () {
    $("status").textContent = "Saved ✓ — reload the Gemini tab to apply.";
    setTimeout(function () { $("status").textContent = ""; }, 2500);
  });
}

function renderAlerts(alerts) {
  $("alertCount").textContent = String(alerts.length);
  var ul = $("alerts");
  ul.innerHTML = "";
  alerts.slice(0, 50).forEach(function (a) {
    var li = document.createElement("li");
    var when = new Date(a.at).toLocaleString();
    li.innerHTML =
      "<strong>" + (a.category || "flagged") + "</strong> — " +
      (a.reason || "") + "<time>" + when + " · from " + a.origin + "</time>";
    ul.appendChild(li);
  });
}

$("save").addEventListener("click", save);
$("clear").addEventListener("click", function () {
  chrome.storage.local.set({ alerts: [] }, function () {
    chrome.action.setBadgeText({ text: "" });
    renderAlerts([]);
  });
});

load();
