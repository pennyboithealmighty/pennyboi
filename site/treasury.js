// Stage 1 — live treasury panel. Reads the Config + Treasury PDAs straight from
// a Solana RPC in the browser (no backend, no Anchor framework): the Config
// account layout is derived from site/vault-idl.json, so it tracks the program.
// Refreshes every 30s; on RPC failure it keeps the last good value and marks it
// stale. If it never succeeds, the panel degrades to "the oracle is silent".

(function () {
  "use strict";
  var CFG = window.PENNYBOI_CONFIG || {};
  var web3 = window.solanaWeb3;
  if (!web3 || !CFG.PROGRAM_ID) return;

  var Connection = web3.Connection;
  var PublicKey = web3.PublicKey;
  var conn = new Connection(CFG.RPC_URL, "confirmed");
  var programId = new PublicKey(CFG.PROGRAM_ID);

  var PRIM = { bool: 1, u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, u64: 8, i64: 8, u128: 16, i128: 16, pubkey: 32 };

  function enc(s) { return new TextEncoder().encode(s); }
  function pda(seed) { return PublicKey.findProgramAddressSync([enc(seed)], programId)[0]; }

  var configPda = pda("config");
  var treasuryPda = pda("treasury");

  // Build an offset map of the primitive fields that precede the first Option.
  function buildLayout(idl) {
    var t = (idl.types || []).find(function (x) { return x.name === "Config"; });
    var fields = t && t.type && t.type.fields ? t.type.fields : [];
    var layout = {};
    var off = 8; // 8-byte account discriminator
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      if (typeof f.type !== "string" || !(f.type in PRIM)) break; // Option/complex -> stop
      layout[f.name] = { offset: off, type: f.type };
      off += PRIM[f.type];
    }
    return layout;
  }

  function read(view, layout, name) {
    var f = layout[name];
    if (!f) return null;
    var o = f.offset;
    switch (f.type) {
      case "bool": return view.getUint8(o) !== 0;
      case "u8": return view.getUint8(o);
      case "u16": return view.getUint16(o, true);
      case "u32": return view.getUint32(o, true);
      case "u64": return Number(view.getBigUint64(o, true));
      case "i64": return Number(view.getBigInt64(o, true));
      default: return null;
    }
  }

  var LAMPORTS = 1e9;
  function sol(n) { return (n / LAMPORTS).toFixed(4); }

  function solscanAccount(addr) {
    var q = CFG.NETWORK === "mainnet" ? "" : "?cluster=devnet";
    return "https://solscan.io/account/" + addr + q;
  }

  function cooldownLabel(lastTs, cooldown, nowSecs) {
    var readyAt = lastTs + cooldown;
    if (nowSecs >= readyAt) return "ready";
    var s = readyAt - nowSecs;
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    return "ready in " + (h > 0 ? h + "h " : "") + m + "m";
  }

  var $ = function (id) { return document.getElementById(id); };
  var lastGood = null;
  var idlLayout = null;

  function setChip(id, label, capLamports, lastTs, cooldown, nowSecs) {
    var el = $(id);
    if (!el) return;
    el.innerHTML = "<b>" + label + "</b><span>" + sol(capLamports) + " SOL · " +
      cooldownLabel(lastTs, cooldown, nowSecs) + "</span>";
  }

  function render(d) {
    var nowSecs = Math.floor(Date.now() / 1000);
    $("tp-balance").textContent = sol(d.balance);
    $("tp-step").textContent = String(d.step);

    var thr = d.thresholdLamports;
    var inStep = Math.max(0, d.balance - d.lastThreshold);
    var pct = thr > 0 ? Math.max(0, Math.min(1, inStep / thr)) : 0;
    var until = Math.max(0, (d.lastThreshold + thr - d.balance));
    $("tp-progress").style.width = (pct * 100).toFixed(1) + "%";
    var banked = d.banked || 0;
    var bankedEl = $("tp-banked");
    if (bankedEl) bankedEl.textContent = String(banked);
    $("tp-until").textContent = banked > 0
      ? banked + " decree" + (banked === 1 ? "" : "s") + " banked — a deed is owed"
      : sol(until) + " SOL until the next decree";

    setChip("tp-burn", "Burn", d.burnCap, d.lastBurn, d.burnCd, nowSecs);
    setChip("tp-airdrop", "Airdrop", d.airdropCap, d.lastAirdrop, d.airdropCd, nowSecs);
    setChip("tp-bounty", "Bounty", d.bountyCap, d.lastBounty, d.bountyCd, nowSecs);

    var link = $("tp-solscan");
    link.href = solscanAccount(CFG.PROGRAM_ID);
  }

  function setUpdated(text, stale) {
    var el = $("tp-updated");
    if (!el) return;
    el.textContent = text;
    el.className = "tp-meta" + (stale ? " tp-stale" : "");
  }

  async function refresh() {
    try {
      if (!idlLayout) {
        var idl = await (await fetch("vault-idl.json")).json();
        idlLayout = buildLayout(idl);
      }
      var info = await conn.getAccountInfo(configPda);
      if (!info || !info.data) throw new Error("config account not found");
      var data = info.data;
      var view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      var balance = await conn.getBalance(treasuryPda);

      var d = {
        balance: balance,
        step: read(view, idlLayout, "threshold_step"),
        thresholdLamports: read(view, idlLayout, "threshold_lamports"),
        lastThreshold: read(view, idlLayout, "last_threshold_balance"),
        banked: read(view, idlLayout, "actions_available"),
        burnCap: read(view, idlLayout, "burn_cap_lamports"),
        airdropCap: read(view, idlLayout, "airdrop_cap_lamports"),
        bountyCap: read(view, idlLayout, "bounty_cap_lamports"),
        burnCd: read(view, idlLayout, "burn_cooldown_secs"),
        airdropCd: read(view, idlLayout, "airdrop_cooldown_secs"),
        bountyCd: read(view, idlLayout, "bounty_cooldown_secs"),
        lastBurn: read(view, idlLayout, "last_burn_ts"),
        lastAirdrop: read(view, idlLayout, "last_airdrop_ts"),
        lastBounty: read(view, idlLayout, "last_bounty_ts"),
      };
      lastGood = d;
      render(d);
      setUpdated("updated " + new Date().toLocaleTimeString(), false);
    } catch (e) {
      if (lastGood) {
        render(lastGood);
        setUpdated("the chain did not answer — showing last known (stale)", true);
      } else {
        setUpdated("the oracle is silent — the chain did not answer", true);
      }
    }
  }

  function init() {
    if (CFG.NETWORK === "devnet") {
      var r = document.getElementById("net-ribbon");
      if (r) r.hidden = false;
    }
    refresh();
    setInterval(refresh, 30000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
