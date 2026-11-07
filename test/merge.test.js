import test from "node:test";
import assert from "node:assert/strict";
import { chooseMethod, mergeBlocker, mergeArgs, queueDecision } from "../mods/pr-panel/merge.js";
import { DEFAULTS } from "../mods/pr-panel/config.js";

const cfg = (merge = {}, over = {}) => ({ ...structuredClone(DEFAULTS), ...over, merge: { ...structuredClone(DEFAULTS.merge), ...merge } });
const pr = (over = {}) => ({
  id: "1", repo: "o/r", number: 87, title: "t", url: "u", isDraft: false,
  createdAt: "2026-11-07T00:00:00Z", head: "feat/x", headOid: "abc123", base: "main", defaultBranch: "main",
  additions: 1, deletions: 1, mergeable: "MERGEABLE", checks: "passed",
  author: { login: "human", isBotType: false },
  allowed: { merge: true, squash: true, rebase: true }, autoMergeAllowed: false,
  account: { login: "me", host: "github.com" }, ...over,
});

test("ordinary PR into the default branch squashes", () => {
  const r = chooseMethod(pr(), cfg());
  assert.equal(r.method, "squash");
  assert.equal(r.reason, "squash → main");
  assert.equal(r.handOff, null);
});

test("non-default base keeps history", () => {
  const r = chooseMethod(pr({ base: "production" }), cfg());
  assert.equal(r.method, "merge");
  assert.match(r.reason, /merge commit/);
  assert.match(r.reason, /production/);
  assert.match(r.reason, /base isn't main/);
});

test("release and hotfix heads keep history, even into the default branch", () => {
  const a = chooseMethod(pr({ head: "release/2026.11.05" }), cfg());
  assert.equal(a.method, "merge");
  assert.match(a.reason, /head starts with release\//);
  const h = chooseMethod(pr({ head: "hotfix/x" }), cfg());
  assert.equal(h.method, "merge");
  assert.match(h.reason, /head starts with hotfix\//);
});

test("keep_history can be turned off", () => {
  const c = cfg({ keepHistory: { nonDefaultBase: false, headPrefixes: [] } });
  assert.equal(chooseMethod(pr({ base: "production", head: "release/1" }), c).method, "squash");
});

test("per-repo default overrides keep-history and the global default", () => {
  const c = cfg({ repos: { "a/b": { default: "merge" } } });
  assert.equal(chooseMethod(pr({ repo: "a/b" }), c).method, "merge");
  const c2 = cfg({ repos: { "a/b": { default: "squash" } } });
  assert.equal(chooseMethod(pr({ repo: "a/b", base: "production" }), c2).method, "squash");
  assert.equal(chooseMethod(pr({ repo: "o/r", base: "production" }), c2).method, "merge");
});

test("per-repo keepHistory override applies without losing other keys", () => {
  const c = cfg({ repos: { "o/r": { keepHistory: { nonDefaultBase: false } } } });
  assert.equal(chooseMethod(pr({ base: "production" }), c).method, "squash");
  assert.equal(chooseMethod(pr({ head: "release/1" }), c).method, "merge");
});

test("falls back to first allowed method when the chosen one is not allowed", () => {
  const p = pr({ allowed: { merge: true, squash: false, rebase: true } });
  const r = chooseMethod(p, cfg());
  assert.equal(r.method, "merge");
  assert.match(r.reason, /isn't allowed/);
  const p2 = pr({ allowed: { merge: false, squash: false, rebase: true } });
  assert.equal(chooseMethod(p2, cfg()).method, "rebase");
});

test("options lists only allowed methods with the chosen one first", () => {
  assert.deepEqual(chooseMethod(pr(), cfg()).options, ["squash", "merge", "rebase"]);
  assert.deepEqual(chooseMethod(pr({ base: "production" }), cfg()).options, ["merge", "squash", "rebase"]);
  const p = pr({ allowed: { merge: false, squash: true, rebase: true } });
  assert.deepEqual(chooseMethod(p, cfg({ default: "rebase" })).options, ["rebase", "squash"]);
});

test("nothing allowed gives no method", () => {
  const r = chooseMethod(pr({ allowed: { merge: false, squash: false, rebase: false } }), cfg());
  assert.equal(r.method, null);
  assert.deepEqual(r.options, []);
});

test("hand-off PR gets no method", () => {
  const rule = { repo: "o/r", base: "develop", label: "Hand off", url: "x" };
  const r = chooseMethod(pr({ base: "develop" }), cfg({}, { handOff: [rule] }));
  assert.equal(r.method, null);
  assert.deepEqual(r.handOff, rule);
  assert.deepEqual(r.options, []);
});

test("mergeBlocker", () => {
  assert.equal(mergeBlocker(pr({ isDraft: true })), "draft");
  assert.equal(mergeBlocker(pr({ mergeable: "CONFLICTING" })), "conflicts");
  assert.equal(mergeBlocker(pr({ mergeable: "UNKNOWN" })), "checking");
  assert.equal(mergeBlocker(pr()), null);
  assert.equal(mergeBlocker(pr({ isDraft: true, mergeable: "CONFLICTING" })), "draft");
});

test("mergeArgs always pins the head commit and never turns on auto-merge", () => {
  const p = pr();
  assert.deepEqual(mergeArgs(p, "squash", { deleteBranch: true }),
    ["pr", "merge", "87", "-R", "o/r", "--squash", "--delete-branch", "--match-head-commit", "abc123"]);
  assert.deepEqual(mergeArgs(p, "merge", { deleteBranch: false }),
    ["pr", "merge", "87", "-R", "o/r", "--merge", "--match-head-commit", "abc123"]);
  assert.ok(mergeArgs(p, "rebase", { deleteBranch: false }).includes("--rebase"));
  assert.ok(!mergeArgs(p, "squash", { deleteBranch: true, auto: true }).includes("--auto"));
});

test("queueDecision", () => {
  const e = { headOid: "abc123", base: "main" };
  assert.equal(queueDecision(e, pr()), "merge");
  assert.equal(queueDecision(e, pr({ checks: "none" })), "merge");
  assert.equal(queueDecision(e, pr({ checks: "running" })), "wait");
  assert.equal(queueDecision(e, pr({ checks: "failed" })), "drop:failed");
  assert.equal(queueDecision(e, pr({ headOid: "zzz" })), "drop:moved");
  assert.equal(queueDecision(e, undefined), "drop:gone");
});

test("queueDecision: a missing PR waits when the list was cut at 100", () => {
  const e = { headOid: "abc123", base: "main" };
  assert.equal(queueDecision(e, null, { truncated: true }), "wait");
  assert.equal(queueDecision(e, null, { truncated: false }), "drop:gone");
});

test("queueDecision: a retargeted PR drops, after gone and moved, before draft", () => {
  const e = { headOid: "abc123", base: "main" };
  assert.equal(queueDecision(e, pr({ base: "production" })), "drop:retargeted");
  assert.equal(queueDecision(e, pr({ base: "production", headOid: "zzz" })), "drop:moved");
  assert.equal(queueDecision(e, pr({ base: "production", isDraft: true })), "drop:retargeted");
  assert.equal(queueDecision(e, pr({ base: "production", checks: "running" })), "drop:retargeted");
  // An entry saved before bases were kept has none: it never merges on a guess.
  assert.equal(queueDecision({ headOid: "abc123" }, pr()), "drop:retargeted");
});

test("queueDecision: moved beats failed and running", () => {
  const e = { headOid: "abc123", base: "main" };
  assert.equal(queueDecision(e, pr({ headOid: "zzz", checks: "failed" })), "drop:moved");
  assert.equal(queueDecision(e, pr({ headOid: "zzz", checks: "running" })), "drop:moved");
});

test("queueDecision: draft and conflicts drop, UNKNOWN waits", () => {
  const e = { headOid: "abc123", base: "main" };
  assert.equal(queueDecision(e, pr({ mergeable: "CONFLICTING" })), "drop:conflicts");
  assert.equal(queueDecision(e, pr({ isDraft: true })), "drop:draft");
  assert.equal(queueDecision(e, pr({ mergeable: "UNKNOWN" })), "wait");
  assert.equal(queueDecision(e, pr({ headOid: "zzz", isDraft: true })), "drop:moved");
});

test("keep-history with merge commits disallowed does not fall back to squash", () => {
  const p = pr({ base: "production", allowed: { merge: false, squash: true, rebase: true } });
  const r = chooseMethod(p, cfg());
  assert.equal(r.method, null);
  assert.deepEqual(r.options, ["squash", "rebase"]);
  assert.match(r.reason, /pick a method/);
  assert.equal(r.handOff, null);
  assert.equal(chooseMethod(pr({ head: "release/1", allowed: p.allowed }), cfg()).method, null);
});

test("mergeArgs rejects an unknown method", () => {
  assert.throws(() => mergeArgs(pr(), "fast-forward", { deleteBranch: false }));
  assert.throws(() => mergeArgs(pr(), null, { deleteBranch: false }));
  assert.throws(() => mergeArgs(pr(), "toString", { deleteBranch: false }));
  assert.throws(() => mergeArgs(pr(), "__proto__", { deleteBranch: false }));
});

test("per-repo merge overrides match the repo name case-insensitively", () => {
  const c = cfg({ repos: { "O/R": { default: "rebase" } } });
  assert.equal(chooseMethod(pr(), c).method, "rebase");
});

test("hand-off rules match the repo name case-insensitively", () => {
  const rule = { repo: "O/R", base: "develop", label: "Hand off", url: "x" };
  assert.deepEqual(chooseMethod(pr({ base: "develop" }), cfg({}, { handOff: [rule] })).handOff, rule);
});
