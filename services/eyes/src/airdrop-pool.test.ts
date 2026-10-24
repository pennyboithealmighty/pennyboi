import test from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import type { LoadedVault, PoolMember, VaultConfig } from "@pennyboi/shared";
import { buildFavoredCandidates, staticExclusions } from "./airdrop-pool.js";

function member(wallet: string, heldHours: number, balance = 500_000): PoolMember {
  return { wallet, balanceTokens: balance, qualifiedSince: 0, heldHours };
}

test("favored candidates: loyal first (by duration), then longest-held non-loyal", () => {
  const members = [
    member("w-short", 5),
    member("w-loyalB", 20),
    member("w-mid", 40),
    member("w-loyalA", 100),
    member("w-long", 80),
  ];
  const loyal = [
    { wallet: "w-loyalA", nickname: "THE FAITHFUL", reason: "blessed twice" },
    { wallet: "w-loyalB", nickname: null, reason: "early buyer" },
  ];
  const out = buildFavoredCandidates(members, loyal);
  // Loyal first, longest-held among them first.
  assert.deepEqual(out.slice(0, 2).map((c) => c.wallet), ["w-loyalA", "w-loyalB"]);
  assert.equal(out[0]!.nickname, "THE FAITHFUL");
  assert.equal(out[0]!.reason, "blessed twice");
  assert.equal(out[1]!.nickname, undefined); // null nickname -> omitted
  // Then non-loyal by duration desc.
  assert.deepEqual(out.slice(2).map((c) => c.wallet), ["w-long", "w-mid", "w-short"]);
  // Non-loyal carry no nickname/reason.
  assert.equal(out[2]!.reason, undefined);
  assert.equal(out[2]!.held_hours, 80);
  assert.equal(out[2]!.balance_tokens, 500_000);
});

test("favored candidates respect the total cap and the duration cap", () => {
  const members = Array.from({ length: 30 }, (_, i) => member(`w${String(i).padStart(2, "0")}`, i));
  const none: Array<{ wallet: string; nickname: string | null; reason: string }> = [];
  assert.equal(buildFavoredCandidates(members, none).length, 10); // durationCap defaults to 10
  assert.equal(buildFavoredCandidates(members, none, 15, 12).length, 12);
  // With many loyal, the total cap (15) governs.
  const loyal = members.map((m) => ({ wallet: m.wallet, nickname: null, reason: "r" }));
  assert.equal(buildFavoredCandidates(members, loyal, 15).length, 15);
});

test("static exclusions cover the protocol's own accounts", () => {
  const cfg = { admin: "ADMIN_ADDR", agent: "AGENT_ADDR", tokenMint: "MINT_ADDR" } as VaultConfig;
  const k = (seed: number) => PublicKey.findProgramAddressSync([Buffer.from([seed])], PublicKey.default)[0];
  const vault = {
    programId: k(1),
    configPda: k(2),
    treasuryPda: k(3),
    feesPda: k(4),
  } as unknown as LoadedVault;
  const ex = staticExclusions(cfg, vault);
  for (const a of ["ADMIN_ADDR", "AGENT_ADDR", "MINT_ADDR"]) assert.ok(ex.has(a));
  for (const pda of [vault.programId, vault.configPda, vault.treasuryPda, vault.feesPda]) {
    assert.ok(ex.has(pda.toBase58()));
  }
});
