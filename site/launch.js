// Stage 4 — launch slots + anti-fake-CA. Config-driven CTAs/links (hidden when
// their config value is null), the contract-address block (shown only once
// CONTRACT_ADDRESS is set), and the hero countdown (when LAUNCH_DATE is future).
// Uses style.display so it beats class display rules.

(function () {
  "use strict";
  var CFG = window.PENNYBOI_CONFIG || {};

  function solscanAccount(addr) {
    var q = CFG.NETWORK === "mainnet" ? "" : "?cluster=devnet";
    return "https://solscan.io/account/" + addr + q;
  }

  var urlFor = {
    pumpfun: CFG.PUMPFUN_URL,
    telegram: CFG.TELEGRAM_URL,
    x: CFG.X_URL,
    github: CFG.GITHUB_URL,
    solscan: CFG.PROGRAM_ID ? solscanAccount(CFG.PROGRAM_ID) : null,
  };

  // CTAs + footer links: wire href, or hide when the config value is null.
  var links = document.querySelectorAll("[data-link]");
  for (var i = 0; i < links.length; i++) {
    var a = links[i];
    var url = urlFor[a.getAttribute("data-link")];
    if (url) {
      a.href = url;
      a.style.display = "";
    } else {
      a.style.display = "none";
    }
  }

  // Contract-address block (shown only when CONTRACT_ADDRESS is set).
  var ca = CFG.CONTRACT_ADDRESS;
  var caBlock = document.getElementById("contract-block");
  if (caBlock) {
    if (ca) {
      var addrEl = document.getElementById("contract-addr");
      if (addrEl) addrEl.textContent = ca;
      var scanEl = document.getElementById("contract-scan");
      if (scanEl) scanEl.href = solscanAccount(ca);
      var copyBtn = document.getElementById("contract-copy");
      if (copyBtn) {
        copyBtn.addEventListener("click", function () {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(ca).then(function () {
              copyBtn.textContent = "copied";
              setTimeout(function () { copyBtn.textContent = "copy"; }, 1500);
            }, function () {});
          }
        });
      }
      caBlock.style.display = "";
    } else {
      caBlock.style.display = "none";
    }
  }

  // Hero countdown (when LAUNCH_DATE is set and in the future).
  var cd = document.getElementById("countdown");
  var launch = CFG.LAUNCH_DATE ? Date.parse(CFG.LAUNCH_DATE) : NaN;
  if (cd) {
    if (!isNaN(launch) && launch > Date.now()) {
      var numEl = document.getElementById("countdown-num");
      var pad = function (n) { return (n < 10 ? "0" : "") + n; };
      var tick = function () {
        var ms = launch - Date.now();
        if (ms <= 0) { cd.style.display = "none"; return; }
        var s = Math.floor(ms / 1000);
        var d = Math.floor(s / 86400); s -= d * 86400;
        var h = Math.floor(s / 3600); s -= h * 3600;
        var m = Math.floor(s / 60); s -= m * 60;
        if (numEl) numEl.textContent = (d > 0 ? d + "d " : "") + pad(h) + ":" + pad(m) + ":" + pad(s);
      };
      tick();
      setInterval(tick, 1000);
      cd.style.display = "";
    } else {
      cd.style.display = "none";
    }
  }
})();
