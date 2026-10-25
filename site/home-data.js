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

  // The destination that proves a feed entry: a decree's Solscan tx, or a
  // prophecy's X post (built from the configured handle + the public status id).
  function verifyUrl(r) {
    if (r.kind === "prophecy") {
      var base = (CFG.X_URL || "").replace(/\/+$/, "");
      return base && r.xPostId ? base + "/status/" + encodeURIComponent(r.xPostId) : null;
    }
    return r.solscanUrl || null; // decree tx; absent for no-op ("none") narrations
  }

  function renderDecrees(rows) {
    var b = el("decrees-body");
    if (!b) return;
    if (!rows.length) { silent("decrees-body", "No decrees yet. The silence is part of the ritual."); return; }
    var items = rows.map(function (r) {
      var tag = '<span class="decree-tag">' + (r.kind === "prophecy" ? "prophecy" : "decree") + "</span>";
      var href = verifyUrl(r);
      var verify = href ? ' · <span class="decree-verify">verify ↗</span>' : "";
      var meta = '<div class="decree-meta">' + tag + "<span>" + esc(when(r.ts)) + "</span>" + verify + "</div>";
      // The whole decree text is the link (SERMON and "none" entries stay plain).
      var body = href
        ? '<a class="decree-link" href="' + esc(href) + '" target="_blank" rel="noopener"><p>' + esc(r.text) + "</p></a>"
        : "<p>" + esc(r.text) + "</p>";
      return '<article class="decree">' + meta + body + "</article>";
    });
    items.push(moreLine());
    b.innerHTML = items.join("");
  }

  // "more decrees → Telegram / X" under the list; each link shown only if set.
  function moreLine() {
    var parts = [];
    if (CFG.TELEGRAM_URL) parts.push('<a href="' + esc(CFG.TELEGRAM_URL) + '" target="_blank" rel="noopener">Telegram</a>');
    if (CFG.X_URL) parts.push('<a href="' + esc(CFG.X_URL) + '" target="_blank" rel="noopener">X</a>');
    if (!parts.length) return "";
    return '<p class="decrees-more">more decrees → ' + parts.join(" / ") + "</p>";
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

  function timeAgo(ts) {
    var s = Math.max(0, Math.floor(Date.now() / 1000) - (ts || 0));
    if (s < 60) return s + "s ago";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    return Math.floor(s / 86400) + "d ago";
  }

  function renderOfferStats(d) {
    var e = el("offer-totals");
    if (!e) return;
    var sol = Number(d && d.total_sol ? d.total_sol : 0);
    var n = Number(d && d.donors ? d.donors : 0);
    e.innerHTML =
      "<strong>" + esc(sol.toFixed(2)) + " SOL</strong> offered by <strong>" + esc(n) + "</strong> " +
      (n === 1 ? "mortal" : "mortals");
  }

  function renderOfferList(rows) {
    var b = el("offer-list");
    if (!b) return;
    if (!rows.length) { silent("offer-list", "No offerings yet. Be the first to feed the Allowance."); return; }
    b.innerHTML = rows.slice(0, 5).map(function (r) {
      var who = r.is_creator ? "The Creator" : esc(r.donor_display);
      var memo = r.memo_clean ? '<span class="offer-memo">“' + esc(r.memo_clean) + '”</span>' : "";
      var link = r.solscan_url
        ? '<a href="' + esc(r.solscan_url) + '" target="_blank" rel="noopener">verify ↗</a>'
        : "";
      return '<div class="offer-row"><span class="offer-who">' + who + "</span>" +
        '<span class="offer-amt">' + esc(Number(r.sol).toFixed(3)) + " SOL</span>" +
        '<span class="offer-when">' + esc(timeAgo(r.ts)) + "</span>" +
        memo + '<span class="offer-verify">' + link + "</span></div>";
    }).join("");
  }

  // "Make an Offering" button is hidden until OFFERING_PAGE_PUBLIC (devnet §0).
  (function () {
    var cta = el("offer-cta");
    if (cta && CFG.OFFERING_PAGE_PUBLIC === true) cta.hidden = false;
  })();

  get("/public/offering/stats").then(renderOfferStats).catch(function () {});
  get("/public/offering/list?limit=5").then(renderOfferList).catch(function () { silent("offer-list"); });

  get("/public/decrees?limit=4").then(renderDecrees).catch(function () { silent("decrees-body"); });
  get("/public/offerings?limit=10").then(renderOfferings).catch(function () { silent("offerings-body"); });
  get("/public/grudges").then(function (d) { renderHall("grudges-body", d, "He holds no grudges yet. Give it time."); })
    .catch(function () { silent("grudges-body"); });
  get("/public/loyal").then(function (d) { renderHall("loyal-body", d, "He has blessed no one yet."); })
    .catch(function () { silent("loyal-body"); });
})();
