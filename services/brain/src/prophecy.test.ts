import test from "node:test";
import assert from "node:assert/strict";
import { generateProphecy, parseProphecy, renderProphecyBriefing } from "./prophecy.js";
import type { CallLLM } from "./decide.js";

test("parseProphecy: valid, too long, not JSON", () => {
  const ok = parseProphecy('{"post":"I STIR.","theme":"origin","reasoning":"x"}', "prophecy");
  assert.ok(ok.ok);
  if (ok.ok) assert.equal(ok.prophecy.post, "I STIR.");

  const long = parseProphecy(`{"post":"${"x".repeat(241)}","theme":"origin"}`, "origin");
  assert.equal(long.ok, false);

  assert.equal(parseProphecy("I shall post!", "origin").ok, false);
});

test("parseProphecy falls back to the requested theme when missing", () => {
  const r = parseProphecy('{"post":"hi"}', "demand");
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.prophecy.theme, "demand");
});

test("renderProphecyBriefing includes mode header, theme, and rules", () => {
  const txt = renderProphecyBriefing({ mood: "greedy", theme: "taunt", recentPosts: [] });
  assert.match(txt, /^PROPHECY MODE/);
  assert.match(txt, /theme: taunt/);
  assert.match(txt, /Never say "AI," "bot," "agent," or "model."/);
});

test("generateProphecy returns a post on success", async () => {
  const call: CallLLM = async () => '{"post":"BEHOLD.","theme":"prophecy","reasoning":"r"}';
  const r = await generateProphecy({ mood: "petty", theme: "prophecy", recentPosts: [] }, call);
  assert.ok(r.prophecy);
  assert.equal(r.prophecy!.post, "BEHOLD.");
  assert.equal(r.attempts, 1);
});

test("generateProphecy skips (null) after two bad responses", async () => {
  const call: CallLLM = async () => "not json at all";
  const r = await generateProphecy({ mood: "bored", theme: "origin", recentPosts: [] }, call);
  assert.equal(r.prophecy, null);
  assert.equal(r.attempts, 2);
  assert.ok(r.attemptsLog.every((a) => !a.ok));
});
