// Scripture page: config-driven "How to verify" block. Derives the program's
// PDAs client-side from PROGRAM_ID, fills in copyable addresses + Solscan links,
// wires the GitHub link, and shows the devnet ribbon. No backend.

(function () {
  "use strict";
  var CFG = window.PENNYBOI_CONFIG || {};

  if (CFG.NETWORK === "devnet") {
    var ribbon = document.getElementById("net-ribbon");
    if (ribbon) ribbon.hidden = false;
  }

  function solscan(addr) {
    var q = CFG.NETWORK === "mainnet" ? "" : "?cluster=devnet";
    return "https://solscan.io/account/" + addr + q;
  }

  function setAddr(key, addr) {
    var code = document.querySelector('[data-addr="' + key + '"]');
    if (code) code.textContent = addr;
    var link = document.querySelector('[data-scan="' + key + '"]');
    if (link) link.href = solscan(addr);
  }

  var pid = CFG.PROGRAM_ID || "";
  var addrs = { program: pid };

  var web3 = window.solanaWeb3;
  if (web3 && pid) {
    try {
      var PublicKey = web3.PublicKey;
      var programId = new PublicKey(pid);
      function pda(seed) {
        return PublicKey.findProgramAddressSync([new TextEncoder().encode(seed)], programId)[0].toBase58();
      }
      addrs.config = pda("config");
      addrs.treasury = pda("treasury");
      addrs.fees = pda("fees");
    } catch (e) {
      /* leave PDA rows as placeholder */
    }
  }

  Object.keys(addrs).forEach(function (k) {
    setAddr(k, addrs[k]);
  });

  // Copy button for the program id.
  var copyBtn = document.getElementById("sv-copy");
  if (copyBtn) {
    copyBtn.addEventListener("click", function () {
      var done = function () {
        copyBtn.textContent = "copied";
        setTimeout(function () { copyBtn.textContent = "copy"; }, 1500);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(pid).then(done, function () {});
      }
    });
  }

  // GitHub source row (hidden until a repo URL is configured).
  var ghRow = document.getElementById("sv-github");
  if (ghRow) {
    if (CFG.GITHUB_URL) {
      var a = ghRow.querySelector(".verify-github");
      if (a) a.href = CFG.GITHUB_URL;
      ghRow.hidden = false;
    } else {
      ghRow.hidden = true;
    }
  }
})();
