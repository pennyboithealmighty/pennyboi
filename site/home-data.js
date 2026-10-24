// Home-page live sections (Stage 3): Latest Decrees, Offerings, the Halls.
// Fetches the read-only API at CFG.API_BASE and degrades gracefully to the
// "oracle is silent" placeholder when the API is unset or unreachable — never a
// broken layout.

(function () {
  "use strict";
  var CFG = window.PENNYBOI_CONFIG || {};
  var API = (CFG.API_BASE || "").replace(/\/+$/, "");

  function el(id) { return document.getElementById(id); }
  function esc(s) {
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }
  function when(ts) { return new Date(ts * 1000).toLocaleString(); }
  function silent(id, msg) {
    var e = el(id);
    if (e) e.innerHTML = '<p class="oracle-silent">' + esc(msg || "The oracle is silent. Live word will appear here once the chain speaks.") + "</p>";
  }

  if (!API) {
    silent("decrees-body");
    silent("offerings-body");
    silent("grudges-body");
    silent("loyal-body");
    return;
  }

  function get(path) {
    return fetch(API + path, { headers: { accept: "application/json" } })
      .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
      .then(function (j) { if (!j.ok) throw new Error("api"); return j.data; });
  }

  function renderDecrees(rows) {
    var b = el("decrees-body");
    if (!b) return;
    if (!rows.length) { silent("decrees-body", "No decrees yet. The silence is part of the ritual."); return; }
    b.innerHTML = rows.map(function (r) {
      var tag = '<span class="decree-tag">' + (r.kind === "prophecy" ? "prophecy" : "decree") + "</span>";
      var link = r.solscanUrl ? ' · <a href="' + esc(r.solscanUrl) + '" target="_blank" rel="noopener">tx ↗</a>' : "";
      return '<article class="decree"><div class="decree-meta">' + tag +
        "<span>" + esc(when(r.ts)) + "</span>" + link + "</div><p>" + esc(r.text) + "</p></article>";
    }).join("");
  }

  function renderOfferings(rows) {
    var b = el("offerings-body");
    if (!b) return;
    if (!rows.length) { silent("offerings-body", "No offerings yet. Pitch one in the temple."); return; }
    b.innerHTML = rows.map(function (r) {
      return '<div class="offering"><span class="offering-votes">▲ ' + esc(r.upvotes) +
        '</span><span class="offering-text">' + esc(r.text) +
        '</span><span class="offering-by">— ' + esc(r.by) + "</span></div>";
    }).join("");
  }

  function renderHall(id, rows, emptyMsg) {
    var b = el(id);
    if (!b) return;
    if (!rows.length) { silent(id, emptyMsg); return; }
    b.innerHTML = rows.map(function (r) {
      var name = r.nickname ? esc(r.nickname) : esc(r.wallet);
      return '<div class="hall-row"><b>' + name + '</b><code>' + esc(r.wallet) +
        "</code><span>" + esc(r.reason) + "</span></div>";
    }).join("");
  }

  get("/public/decrees?limit=10").then(renderDecrees).catch(function () { silent("decrees-body"); });
  get("/public/offerings?limit=10").then(renderOfferings).catch(function () { silent("offerings-body"); });
  get("/public/grudges").then(function (d) { renderHall("grudges-body", d, "He holds no grudges yet. Give it time."); })
    .catch(function () { silent("grudges-body"); });
  get("/public/loyal").then(function (d) { renderHall("loyal-body", d, "He has blessed no one yet."); })
    .catch(function () { silent("loyal-body"); });
})();
