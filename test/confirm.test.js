import test from "node:test";
import assert from "node:assert/strict";
import {
  chooseMethod, deleteBranchFor, confirmStart, confirmView, confirmKey, acceptRequest, acceptAsk, queueEntry, REQUEST_TTL_MS,
} from "../mods/pr-panel/merge.js";
import { DEFAULTS } from "../mods/pr-panel/config.js";

const cfg = (merge = {}) => ({ ...structuredClone(DEFAULTS), merge: { ...structuredClone(DEFAULTS.merge), ...merge } });
const pr = (over = {}) => ({
  id: "1", repo: "o/r", number: 87, title: "t", url: "u", isDraft: false,
  createdAt: "2026-11-07T00:00:00Z", head: "feat/x", headOid: "abc123", base: "main", defaultBranch: "main",
  additions: 1, deletions: 1, mergeable: "MERGEABLE", checks: "passed",
  author: { login: "human", isBotType: false },
  allowed: { merge: true, squash: true, rebase: true }, autoMergeAllowed: false,
  account: { login: "me", host: "github.com" }, ...over,
});
const start = (p, c = cfg()) => confirmStart(chooseMethod(p, c));

test("confirm line uses the exact copy", () => {
  assert.equal(confirmView(pr(), start(pr())).line, "Squash #87 → main? (y · s switch method · Esc)");
  const p = pr({ base: "production" });
  assert.equal(confirmView(p, start(p)).line, "Merge commit #87 → production? (y · s switch method · Esc)");
});

test("s cycles the allowed methods, and the line follows", () => {
  const p = pr();
  let st = start(p);
  st = confirmKey(st, "s", p).st;
  assert.equal(st.method, "merge");
  st = confirmKey(st, "s", p).st;
  assert.equal(confirmView(p, st).line, "Rebase #87 → main? (y · s switch method · Esc)");
  st = confirmKey(st, "s", p).st;
  assert.equal(st.method, "squash");
});

test("after switching away from the suggested method, the reason says it was the suggestion", () => {
  const p = pr({ base: "develop" });
  let st = start(p);
  assert.equal(confirmView(p, st).reason, "merge commit → develop (base isn't main)");
  st = confirmKey(st, "s", p).st;
  assert.equal(confirmView(p, st).reason, "Suggested: merge commit → develop (base isn't main)");
  st = confirmKey(confirmKey(st, "s", p).st, "s", p).st;
  assert.equal(confirmView(p, st).reason, "merge commit → develop (base isn't main)");
});

test("y merges now; Esc closes without a request", () => {
  const p = pr();
  const r = confirmKey(start(p), "y", p);
  assert.deepEqual(r.request, { method: "squash", when: "now" });
  assert.equal(r.close, true);
  const e = confirmKey(start(p), "escape", p);
  assert.equal(e.close, true);
  assert.equal(e.request, null);
});

test("failed checks: red, and the first y only asks again", () => {
  const p = pr({ checks: "failed" });
  let st = start(p);
  assert.equal(confirmView(p, st).failed, true);
  const first = confirmKey(st, "y", p);
  assert.equal(first.request, null);
  assert.equal(first.close, false);
  st = first.st;
  assert.equal(confirmView(p, st).line, "Checks failed. Press y again to merge anyway.");
  assert.deepEqual(confirmKey(st, "y", p).request, { method: "squash", when: "now" });
  // switching method disarms
  assert.equal(confirmKey(st, "s", p).st.armed, false);
  // no "when green" for failed checks
  assert.equal(confirmView(p, st).green, false);
  assert.equal(confirmKey(st, "w", p).request, null);
});

test("running checks offer w = merge when green", () => {
  const p = pr({ checks: "running" });
  const st = start(p);
  assert.equal(confirmView(p, st).green, true);
  assert.deepEqual(confirmKey(st, "w", p).request, { method: "squash", when: "green" });
  assert.equal(confirmKey(start(pr()), "w", pr()).request, null);
});

test("no method (keep-history repo without merge commits): y and w wait for s", () => {
  const p = pr({ base: "production", checks: "running", allowed: { merge: false, squash: true, rebase: true } });
  let st = start(p);
  assert.equal(st.method, null);
  const v = confirmView(p, st);
  assert.equal(v.line, "Pick a method: s");
  assert.equal(v.reason, "merge commit isn't allowed here; pick a method");
  assert.equal(v.green, false);
  assert.equal(confirmKey(st, "y", p).request, null);
  assert.equal(confirmKey(st, "w", p).request, null);
  st = confirmKey(st, "s", p).st;
  assert.equal(st.method, "squash");
  assert.deepEqual(confirmKey(st, "y", p).request, { method: "squash", when: "now" });
});

test("deleteBranch: per-repo override wins", () => {
  assert.equal(deleteBranchFor(cfg(), pr()), true);
  assert.equal(deleteBranchFor(cfg({ deleteBranch: false }), pr()), false);
  assert.equal(deleteBranchFor(cfg({ repos: { "o/r": { deleteBranch: false } } }), pr()), false);
  assert.equal(deleteBranchFor(cfg({ deleteBranch: false, repos: { "o/r": { deleteBranch: true } } }), pr()), true);
  assert.equal(deleteBranchFor(cfg({ repos: { "o/x": { deleteBranch: false } } }), pr()), true);
});

test("deleteBranch: per-repo override matches the repo name case-insensitively", () => {
  assert.equal(deleteBranchFor(cfg({ repos: { "O/R": { deleteBranch: false } } }), pr()), false);
});

test("deleteBranch: never the default branch, never a keep-history PR", () => {
  assert.equal(deleteBranchFor(cfg(), pr({ head: "main", base: "main" })), false);
  assert.equal(deleteBranchFor(cfg(), pr({ head: "develop", base: "production" })), false); // non-default base
  assert.equal(deleteBranchFor(cfg(), pr({ head: "release/1.2" })), false);
  assert.equal(deleteBranchFor(cfg(), pr({ head: "hotfix/x" })), false);
  // keep-history turned off: an ordinary feature branch into a non-default base is deleted again
  const off = cfg({ keepHistory: { nonDefaultBase: false, headPrefixes: [] } });
  assert.equal(deleteBranchFor(off, pr({ base: "production" })), true);
  // a per-repo default of squash doesn't stop the release head from surviving
  assert.equal(deleteBranchFor(cfg({ repos: { "o/r": { default: "squash" } } }), pr({ head: "release/1" })), false);
});

test("confirm line names the branch it deletes", () => {
  const p = pr();
  const st = confirmStart({ ...chooseMethod(p, cfg()), deletes: "feat/x" });
  assert.equal(confirmView(p, st).line, "Squash #87 → main · deletes feat/x? (y · s switch method · Esc)");
  assert.equal(confirmView(p, confirmStart({ ...chooseMethod(p, cfg()), deletes: null })).line, "Squash #87 → main? (y · s switch method · Esc)");
});

test("acceptRequest: only a fresh request for the confirmed PR at the seen head", () => {
  const p = pr();
  const confirming = { pr: p, options: ["squash", "merge", "rebase"], deleteBranch: true };
  const now = 1_000_000;
  const req = { prId: "1", method: "squash", when: "now", headOid: "abc123", at: now - 1000 };
  assert.deepEqual(acceptRequest(req, confirming, now), { pr: p, method: "squash", when: "now", deleteBranch: true });
  assert.equal(acceptRequest(req, { ...confirming, deleteBranch: false }, now).deleteBranch, false);
  assert.equal(acceptRequest({ ...req, method: "toString" }, { ...confirming, options: ["toString"] }, now), null);
  assert.equal(acceptRequest(null, confirming, now), null);
  assert.equal(acceptRequest(req, null, now), null);
  assert.equal(acceptRequest({ ...req, prId: "2" }, confirming, now), null);
  assert.equal(acceptRequest({ ...req, headOid: "zzz" }, confirming, now), null);
  assert.equal(acceptRequest({ ...req, at: now - REQUEST_TTL_MS - 1 }, confirming, now), null);
  assert.equal(acceptRequest({ ...req, at: undefined }, confirming, now), null);
  assert.equal(acceptRequest({ ...req, method: "octopus" }, confirming, now), null);
  assert.equal(acceptRequest({ ...req, method: "rebase" }, { ...confirming, options: ["squash"] }, now), null);
  assert.equal(acceptRequest({ ...req, when: "later" }, confirming, now), null);
});

test("queueEntry keeps the account, the head and the base", () => {
  assert.deepEqual(queueEntry(pr(), "squash"), {
    repo: "o/r", number: 87, method: "squash", headOid: "abc123", base: "main", deleteBranch: false,
    account: { login: "me", host: "github.com" },
  });
  assert.equal(queueEntry(pr(), "squash", true).deleteBranch, true);
});

test("acceptAsk: the peek's m only goes ahead at the head the peek showed", () => {
  const p = pr();
  const now = 1_000_000;
  const ask = { prId: "1", headOid: "abc123", at: now - 1000 };
  assert.equal(acceptAsk(ask, p, now), "ok");
  assert.equal(acceptAsk({ ...ask, headOid: "old" }, p, now), "moved");
  assert.equal(acceptAsk({ prId: "1", at: now }, p, now), "moved"); // no head: never assume it matches
  assert.equal(acceptAsk(ask, null, now), null);
  assert.equal(acceptAsk({ ...ask, prId: "2" }, p, now), null);
  assert.equal(acceptAsk({ ...ask, at: now - 61_000 }, p, now), null);
  assert.equal(acceptAsk(null, p, now), null);
});
