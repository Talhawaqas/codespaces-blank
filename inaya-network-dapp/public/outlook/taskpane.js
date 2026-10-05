/* Inaya Secure Link for Outlook: task pane logic (Competitive Expansion SOW J2).
 * Same-origin calls to the Inaya API with the person's existing sign-in. The password, if any, is sent to Inaya to protect the link and is NEVER written into the e-mail.
 * Insertion uses Office.js body.setSelectedDataAsync; the block text comes from the server, which escapes everything it adds. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var state = { orgId: null, doc: null, timer: null };
  var say = function (t, cls) { var m = $("msg"); m.textContent = t || ""; m.className = cls || "muted"; };
  function api(path, opts) {
    opts = opts || {};
    return fetch(path, { method: opts.method || "GET", credentials: "include", headers: { "Content-Type": "application/json" }, body: opts.body ? JSON.stringify(opts.body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) { var e = new Error(d.error || "Something went wrong."); e.status = r.status; throw e; } return d; }); });
  }
  function text(el, t) { el.textContent = t; return el; }

  function boot() {
    $("signinLink").href = location.origin + "/business";
    api("/api/orgs/session").then(function (s) {
      if (!s.authenticated || !s.orgs || !s.orgs.length) { $("signin").hidden = false; $("app").hidden = true; return; }
      $("signin").hidden = true; $("app").hidden = false;
      var sel = $("org"); sel.textContent = "";
      s.orgs.forEach(function (o) { var op = document.createElement("option"); op.value = o.orgId; op.textContent = o.orgName; sel.appendChild(op); });
      state.orgId = sel.value; loadMine();
    }).catch(function () { $("signin").hidden = false; });
  }
  function search() {
    var q = $("q").value.trim(); var ul = $("results"); ul.textContent = "";
    if (q.length < 2) return;
    api("/api/orgs/search?orgId=" + encodeURIComponent(state.orgId) + "&q=" + encodeURIComponent(q)).then(function (d) {
      (d.results || []).filter(function (r) { return r.entityType === "document"; }).slice(0, 8).forEach(function (r) {
        var li = document.createElement("li"); var b = document.createElement("button"); b.className = "sec"; b.type = "button"; b.textContent = r.title;
        b.addEventListener("click", function () { state.doc = r; $("chosen").hidden = false; text($("chosenName"), r.title); });
        li.appendChild(b); ul.appendChild(li);
      });
      if (!ul.children.length) { var li = document.createElement("li"); li.className = "muted"; li.textContent = "No files match."; ul.appendChild(li); }
    }).catch(function (e) { say(e.message, "err"); });
  }
  function insert() {
    if (!state.doc) return; $("insert").disabled = true; say("Creating the link…");
    var domains = $("dom").value.split(",").map(function (x) { return x.trim(); }).filter(Boolean);
    var options = { permission: "view" }; if ($("pw").value) options.password = $("pw").value; if (domains.length) options.domainAllow = domains;
    api("/api/orgs/office/outlook/links", { method: "POST", body: { orgId: state.orgId, documentId: state.doc.id, expirationPreset: $("exp").value, options: options, note: $("note").value } }).then(function (r) {
      return new Promise(function (resolve, reject) {
        Office.context.mailbox.item.body.setSelectedDataAsync(r.block.html, { coercionType: Office.CoercionType.Html }, function (res) { res.status === Office.AsyncResultStatus.Succeeded ? resolve(r) : reject(new Error("Outlook could not insert the link.")); });
      });
    }).then(function () { say("Inserted. The password, if you set one, was not added to the message.", "ok"); $("pw").value = ""; loadMine(); })
      .catch(function (e) { say(e.message, "err"); }).then(function () { $("insert").disabled = false; });
  }
  function loadMine() {
    var ul = $("mine"); ul.textContent = "";
    api("/api/orgs/office/outlook/links?orgId=" + encodeURIComponent(state.orgId)).then(function (d) {
      if (!d.links.length) { var li = document.createElement("li"); li.className = "muted"; li.textContent = "None yet."; ul.appendChild(li); return; }
      d.links.slice(0, 10).forEach(function (l) {
        var li = document.createElement("li"); li.appendChild(text(document.createElement("div"), (l.filename || "File") + " (" + l.status + ")"));
        li.appendChild(text(document.createElement("div"), "Expires " + new Date(l.expiresAt).toLocaleString() + ", opened " + l.opened + " time(s)")).className = "muted";
        if (l.status === "active") { var b = document.createElement("button"); b.className = "sec"; b.type = "button"; b.textContent = "Revoke"; b.addEventListener("click", function () { api("/api/orgs/office/outlook/links/" + l.shareId + "?orgId=" + encodeURIComponent(state.orgId), { method: "DELETE" }).then(loadMine).catch(function (e) { say(e.message, "err"); }); }); li.appendChild(b); }
        ul.appendChild(li);
      });
    }).catch(function (e) { say(e.message, "err"); });
  }
  function inspect() {
    api("/api/orgs/office/outlook/inspect", { method: "POST", body: { orgId: state.orgId, url: $("inspectUrl").value.trim() } }).then(function (r) {
      $("inspectOut").textContent = !r.recognized ? "Not found." : "Status: " + r.status + (r.expiresAt ? ", expires " + new Date(r.expiresAt).toLocaleString() : "") + (r.passwordProtected ? ", password protected" : "") + (r.oneTime ? ", one-time" : "");
    }).catch(function (e) { $("inspectOut").textContent = e.message; });
  }
  function ready() {
    $("org").addEventListener("change", function () { state.orgId = $("org").value; state.doc = null; $("chosen").hidden = true; loadMine(); });
    $("q").addEventListener("input", function () { clearTimeout(state.timer); state.timer = setTimeout(search, 250); });
    $("insert").addEventListener("click", insert); $("inspect").addEventListener("click", inspect); $("reload").addEventListener("click", boot);
    boot();
  }
  if (window.Office && Office.onReady) Office.onReady(ready); else document.addEventListener("DOMContentLoaded", ready);
})();
