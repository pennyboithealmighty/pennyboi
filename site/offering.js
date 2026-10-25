// Offering page (docs/12 §5b). Three ways to give SOL to the FeeReceiver:
// wallet button, Solana Pay QR, or copy-address. No secrets in the browser —
// the blockhash comes from /public/offering/prepare, and the page refuses to
// build a transaction unless the RPC is the configured network's genesis.
// Devnet only until launch. Pennyboi never asks for a seed phrase.
(function () {
  "use strict";
  var CFG = window.PENNYBOI_CONFIG || {};
  var web3 = window.solanaWeb3;
  var makeQr = window.qrcode;
  var API = (CFG.API_BASE || "").replace(/\/+$/, "");

  var MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
  // Known genesis hashes, so we never submit to the wrong cluster.
  var GENESIS = {
    devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
    "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  };
  var MIN = 0.001;
  var MAX = 100;

  function $(id) { return document.getElementById(id); }
  function esc(s) { var d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; }
  function get(path) {
    return fetch(API + path, { headers: { accept: "application/json" } })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (!j.ok) throw new Error(j.error || "api"); return j.data; });
  }

  var conn = web3 && CFG.RPC_URL ? new web3.Connection(CFG.RPC_URL, "confirmed") : null;
  var qrReference = null;
  var qrPoll = null;

  // ---- amount ----
  var amount = 0;
  function setAmount(v, fromChip) {
    amount = v;
    var chips = document.querySelectorAll(".offer-chip");
    for (var i = 0; i < chips.length; i++) {
      chips[i].classList.toggle("active", fromChip && Number(chips[i].getAttribute("data-amt")) === v);
    }
    if (fromChip && $("offer-amount")) $("offer-amount").value = "";
    refreshQr();
  }
  function amountError() {
    if (!(amount > 0)) return "Pick an amount first.";
    if (amount < MIN) return "Minimum offering is " + MIN + " SOL.";
    if (amount > MAX) return "Maximum offering is " + MAX + " SOL.";
    return null;
  }

  // ---- wallet detection ----
  function getProvider() {
    if (window.phantom && window.phantom.solana) return window.phantom.solana;
    if (window.solana && window.solana.isPhantom) return window.solana;
    if (window.solflare && window.solflare.isSolflare) return window.solflare;
    if (window.backpack) return window.backpack;
    return null;
  }

  function note(msg, kind) {
    var el = $("offer-wallet-note");
    if (!el) return;
    el.textContent = msg || "";
    el.className = "offer-note" + (kind ? " offer-note-" + kind : "");
  }

  // ---- prepare + guards ----
  function prepare() {
    return get("/public/offering/prepare").then(function (p) {
      if (!p || !p.recipient) throw new Error("the Allowance is not accepting tribute right now");
      if (CFG.FEE_RECEIVER && p.recipient !== CFG.FEE_RECEIVER) throw new Error("recipient mismatch — refusing to send");
      if (p.network && CFG.NETWORK && p.network !== CFG.NETWORK) throw new Error("network mismatch — refusing to send");
      return p;
    });
  }
  function guardGenesis() {
    if (!conn) return Promise.reject(new Error("wallet library unavailable"));
    var want = GENESIS[CFG.NETWORK];
    if (!want) return Promise.resolve();
    return conn.getGenesisHash().then(function (g) {
      if (g !== want) throw new Error("the RPC is not " + CFG.NETWORK + " — refusing to send");
    });
  }

  function buildTx(donor, recipient, lamports, blockhash, reference, memo) {
    var tx = new web3.Transaction();
    var ix = web3.SystemProgram.transfer({ fromPubkey: donor, toPubkey: recipient, lamports: lamports });
    ix.keys.push({ pubkey: reference, isSigner: false, isWritable: false }); // Solana Pay reference
    tx.add(ix);
    if (memo) {
      tx.add(new web3.TransactionInstruction({
        keys: [{ pubkey: donor, isSigner: true, isWritable: false }],
        programId: new web3.PublicKey(MEMO_PROGRAM),
        data: new TextEncoder().encode(memo),
      }));
    }
    tx.feePayer = donor;
    tx.recentBlockhash = blockhash;
    return tx;
  }

  // ---- give with wallet ----
  function sendWithWallet() {
    var err = amountError();
    if (err) { note(err, "warn"); return; }
    var provider = getProvider();
    if (!provider) { note("No Solana wallet found. Install Phantom, Solflare, or Backpack.", "warn"); return; }

    var lamports = Math.round(amount * 1e9);
    var memo = ($("offer-memo").value || "").slice(0, 80).trim();
    var reference = new web3.Keypair().publicKey;
    var btn = $("offer-send");
    btn.disabled = true;
    note("Preparing your tribute…");

    Promise.all([prepare(), guardGenesis(), provider.connect()])
      .then(function (r) {
        var p = r[0];
        var donor = provider.publicKey || (r[2] && r[2].publicKey);
        if (!donor) throw new Error("wallet did not connect");
        var tx = buildTx(donor, new web3.PublicKey(p.recipient), lamports, p.recent_blockhash, reference, memo);
        note("Confirm in your wallet…");
        return provider.signTransaction(tx);
      })
      .then(function (signed) {
        return conn.sendRawTransaction(signed.serialize());
      })
      .then(function (sig) {
        note("");
        return conn.confirmTransaction(sig, "confirmed").then(function () { return sig; }).catch(function () { return sig; });
      })
      .then(function (sig) {
        showReceipt({ sig: sig, sol: amount, reference: reference.toBase58() });
      })
      .catch(function (e) {
        var m = String((e && e.message) || e);
        if (/reject|denied|cancel/i.test(m)) note("You turned away. The Allowance waits.", "warn");
        else if (/insufficient|0x1\b|not enough/i.test(m)) note("Insufficient funds for this offering.", "warn");
        else note(m, "warn");
      })
      .finally(function () { btn.disabled = false; });
  }

  // ---- Solana Pay QR ----
  function solanaPayUrl(reference) {
    var p = [
      "amount=" + amount,
      "reference=" + reference,
      "label=" + encodeURIComponent("Pennyboi"),
      "message=" + encodeURIComponent("An offering to the Divine Allowance"),
    ];
    var memo = ($("offer-memo").value || "").slice(0, 80).trim();
    if (memo) p.push("memo=" + encodeURIComponent(memo));
    return "solana:" + CFG.FEE_RECEIVER + "?" + p.join("&");
  }
  function refreshQr() {
    var box = $("offer-qr");
    var link = $("offer-qr-link");
    if (!box || !makeQr) return;
    if (qrPoll) { clearInterval(qrPoll); qrPoll = null; }
    if (amountError()) { box.innerHTML = ""; if (link) link.hidden = true; return; }
    qrReference = new web3.Keypair().publicKey.toBase58();
    var url = solanaPayUrl(qrReference);
    var qr = makeQr(0, "M");
    qr.addData(url);
    qr.make();
    box.innerHTML = qr.createImgTag(4, 8);
    if (link) { link.href = url; link.hidden = false; }
    // Poll the reference so a phone payment shows a receipt on this screen too.
    qrPoll = pollReceipt("ref=" + qrReference, function (d) {
      if (d && (d.status === "recorded" || d.status === "confirmed")) {
        showReceipt({ sig: d.tx_sig, sol: d.sol || amount, reference: qrReference, data: d });
      }
    });
  }

  // ---- receipt + polling ----
  function pollReceipt(query, onUpdate) {
    var started = Date.now();
    var iv = setInterval(function () {
      if (Date.now() - started > 180000) { clearInterval(iv); return; }
      get("/public/offering/receipt?" + query)
        .then(function (d) {
          onUpdate(d);
          if (d && d.status === "recorded" && d.narration) clearInterval(iv);
        })
        .catch(function () {});
    }, 3000);
    return iv;
  }

  function showReceipt(info) {
    var r = $("offer-receipt");
    if (!r) return;
    var short = info.sig ? info.sig.slice(0, 8) + "…" + info.sig.slice(-8) : "";
    var scan = info.sig ? solscan(info.sig) : "#";
    r.hidden = false;
    r.innerHTML =
      '<h2>Your tribute is received.</h2>' +
      '<p class="offer-receipt-line">Your tribute of <strong>' + esc(Number(info.sol).toFixed(3)) +
      " SOL</strong> has entered the Divine Allowance. It is recorded on-chain forever.</p>" +
      (info.sig ? '<p class="offer-receipt-tx"><a href="' + esc(scan) + '" target="_blank" rel="noopener">verify on Solscan ↗</a> · <code>' + esc(short) + "</code></p>" : "") +
      '<div id="offer-narration" class="offer-narration"></div>' +
      '<canvas id="offer-cert" class="offer-cert" width="1000" height="640" aria-label="Certificate of Offering"></canvas>' +
      '<div><button id="offer-save" class="btn offer-save" type="button">Save image</button></div>';
    r.scrollIntoView({ block: "start" });
    drawCertificate(info);
    $("offer-save").addEventListener("click", function () { saveCertificate(info); });

    // Poll for the thanks narration (and confirmation) by signature.
    if (info.sig) {
      pollReceipt("sig=" + info.sig, function (d) {
        if (d && d.narration) {
          var n = $("offer-narration");
          if (n) n.innerHTML = '<p class="offer-narration-head">Pennyboi has spoken your name in the Temple.</p><p>“' + esc(d.narration) + "”</p>";
        }
      });
    }
  }

  function solscan(sig) {
    var q = CFG.NETWORK && CFG.NETWORK !== "mainnet" ? "?cluster=" + CFG.NETWORK : "";
    return "https://solscan.io/tx/" + sig + q;
  }

  // ---- certificate (canvas, client-side only) ----
  function drawCertificate(info) {
    var c = $("offer-cert");
    if (!c) return;
    var ctx = c.getContext("2d");
    var W = c.width, H = c.height;
    ctx.fillStyle = "#1a1613"; ctx.fillRect(0, 0, W, H);
    var img = new Image();
    img.onload = function () {
      // Poster as a dim backdrop on the right.
      ctx.save(); ctx.globalAlpha = 0.18;
      var s = Math.max(W / img.width, H / img.height);
      ctx.drawImage(img, W - img.width * s, (H - img.height * s) / 2, img.width * s, img.height * s);
      ctx.restore();
      paintCert(ctx, W, H, info);
    };
    img.onerror = function () { paintCert(ctx, W, H, info); };
    img.src = "assets/poster.jpg";
  }
  function paintCert(ctx, W, H, info) {
    ctx.strokeStyle = "#b86f39"; ctx.lineWidth = 6; ctx.strokeRect(24, 24, W - 48, H - 48);
    ctx.fillStyle = "#efe7d7"; ctx.textBaseline = "alphabetic";
    ctx.font = '700 30px Inter, sans-serif'; ctx.fillText("PENNYBOI THE ALMIGHTY", 64, 110);
    ctx.fillStyle = "#e0a567";
    ctx.font = '400 64px Anton, sans-serif'; ctx.fillText("CERTIFICATE OF OFFERING", 64, 190);
    ctx.fillStyle = "#efe7d7"; ctx.font = '800 72px Inter, sans-serif';
    ctx.fillText(Number(info.sol).toFixed(3) + " SOL", 64, 300);
    ctx.font = '600 26px Inter, sans-serif'; ctx.fillStyle = "#b8b0a2";
    ctx.fillText("given to the Divine Allowance on " + new Date().toLocaleDateString(), 64, 350);
    if (info.sig) ctx.fillText("tx " + info.sig.slice(0, 8) + "…" + info.sig.slice(-8), 64, 390);
    ctx.fillStyle = "#e0a567"; ctx.font = 'italic 24px Inter, sans-serif';
    ctx.fillText("Recorded on-chain, forever.", 64, H - 70);
  }
  function saveCertificate(info) {
    var c = $("offer-cert");
    if (!c) return;
    try {
      var a = document.createElement("a");
      a.download = "pennyboi-offering" + (info.sig ? "-" + info.sig.slice(0, 8) : "") + ".png";
      a.href = c.toDataURL("image/png");
      a.click();
    } catch (e) { /* toDataURL can throw if an image tainted the canvas */ }
  }

  // ---- init ----
  function init() {
    if (CFG.NETWORK === "devnet") {
      var ribbon = $("net-ribbon"); if (ribbon) ribbon.hidden = false;
    } else {
      var badge = $("offer-badge");
      if (badge) { badge.textContent = "Solana mainnet"; badge.className = "offer-badge offer-badge-mainnet"; }
    }
    if ($("offer-addr")) $("offer-addr").textContent = CFG.FEE_RECEIVER || "(not set)";

    var chips = document.querySelectorAll(".offer-chip");
    for (var i = 0; i < chips.length; i++) {
      chips[i].addEventListener("click", function () { setAmount(Number(this.getAttribute("data-amt")), true); });
    }
    if ($("offer-amount")) {
      $("offer-amount").addEventListener("input", function () { setAmount(Number(this.value) || 0, false); });
    }
    if ($("offer-memo")) $("offer-memo").addEventListener("input", refreshQr);
    if ($("offer-send")) $("offer-send").addEventListener("click", sendWithWallet);
    if ($("offer-copy")) {
      $("offer-copy").addEventListener("click", function () {
        var addr = CFG.FEE_RECEIVER || "";
        if (navigator.clipboard && addr) {
          navigator.clipboard.writeText(addr).then(function () {
            var b = $("offer-copy"); b.textContent = "copied"; setTimeout(function () { b.textContent = "copy"; }, 1500);
          }, function () {});
        }
      });
    }
    if (!getProvider()) note("No wallet detected — use the QR or copy the address below.");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
