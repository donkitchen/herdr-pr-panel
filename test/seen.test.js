import test from "node:test";
import assert from "node:assert/strict";
import { updateSeen, mergeState, withoutRemoved } from "../mods/pr-panel/seen.js";
import { DEFAULTS } from "../mods/pr-panel/config.js";

const cfg = { ...DEFAULTS, handOff: [{ repo: "o/a", base: "develop", label: "Hand off", url: "x" }] };
const pr = (id, over = {}) => ({
  id, repo: "o/a", number: 1, isDraft: false, head: "feat/x", base: "main", ...over,
});
const fresh0 = { initialized: false, seen: [] };

test("first run: nothing fresh, waiting ids recorded, initialized", () => {
  const { state, fresh } = updateSeen(fresh0, [pr("1"), pr("2")], cfg);
  assert.deepEqual(fresh, []);
  assert.deepEqual(state, { initialized: true, seen: ["1", "2"] });
});

test("later run: only unseen ids are fresh", () => {
  const { state, fresh } = updateSeen({ initialized: true, seen: ["1"] }, [pr("1"), pr("2")], cfg);
  assert.deepEqual(fresh.map((p) => p.id), ["2"]);
  assert.deepEqual(state.seen, ["1", "2"]);
});

test("draft is never seen; fresh once it turns non-draft", () => {
  const s0 = { initialized: true, seen: [] };
  const a = updateSeen(s0, [pr("1", { isDraft: true })], cfg);
  assert.deepEqual(a.fresh, []);
  assert.deepEqual(a.state.seen, []);
  const b = updateSeen(a.state, [pr("1")], cfg);
  assert.deepEqual(b.fresh.map((p) => p.id), ["1"]);
});

test("hand-off PR is never fresh nor recorded", () => {
  const { state, fresh } = updateSeen({ initialized: true, seen: [] }, [pr("1", { base: "develop" })], cfg);
  assert.deepEqual(fresh, []);
  assert.deepEqual(state.seen, []);
});

test("absent ids are pruned", () => {
  const { state } = updateSeen({ initialized: true, seen: ["1", "2"] }, [pr("2")], cfg);
  assert.deepEqual(state.seen, ["2"]);
});

test("idempotent; input not mutated; no duplicates", () => {
  const s0 = { initialized: true, seen: ["1"] };
  const frozen = JSON.stringify(s0);
  const a = updateSeen(s0, [pr("1"), pr("2"), pr("2")], cfg);
  assert.equal(JSON.stringify(s0), frozen);
  assert.deepEqual(a.state.seen, ["1", "2"]);
  const b = updateSeen(a.state, [pr("1"), pr("2")], cfg);
  assert.deepEqual(b.fresh, []);
});

test("complete:false keeps absent ids, so no re-toast on the next full run", () => {
  const s0 = { initialized: true, seen: ["1", "2"] };
  const a = updateSeen(s0, [pr("2"), pr("3")], cfg, { complete: false });
  assert.deepEqual(a.fresh.map((p) => p.id), ["3"]);
  assert.deepEqual(a.state.seen, ["1", "2", "3"]);
  const b = updateSeen(a.state, [pr("1"), pr("2"), pr("3")], cfg);
  assert.deepEqual(b.fresh, []);
});

test("complete:true prunes, so a reappearing id toasts again", () => {
  const a = updateSeen({ initialized: true, seen: ["1"] }, [], cfg);
  assert.deepEqual(a.state.seen, []);
  const b = updateSeen(a.state, [pr("1")], cfg);
  assert.deepEqual(b.fresh.map((p) => p.id), ["1"]);
});

test("mergeState: unions seen and keeps memory's queue entries over the file's", () => {
  const file = { initialized: false, seen: ["a", "b"], queue: { q1: { number: 1 }, q2: { number: 2 } } };
  const mem = { initialized: true, seen: ["b", "c"], queue: { q2: { number: 22 }, q3: { number: 3 } } };
  const m = mergeState(file, mem);
  assert.equal(m.initialized, true);
  assert.deepEqual(m.seen, ["a", "b", "c"]);
  assert.deepEqual(m.queue, { q1: { number: 1 }, q2: { number: 22 }, q3: { number: 3 } });
  assert.deepEqual(file.seen, ["a", "b"]); // inputs untouched
});

test("mergeState: a tombstoned queue entry in the file never comes back", () => {
  const X = { repo: "o/r", number: 1, method: "squash", headOid: "a" };
  const file = { initialized: true, seen: [], queue: { X, Y: { ...X, number: 2 } } };
  const mem = { initialized: true, seen: [], queue: {} }; // X was dropped in memory; the write behind it failed
  const out = mergeState(file, mem, new Set(["X"]));
  assert.deepEqual(Object.keys(out.queue), ["Y"]);
  assert.deepEqual(Object.keys(file.queue), ["X", "Y"]); // input not mutated
  assert.deepEqual(Object.keys(withoutRemoved(file.queue, new Map([["X", true]]))), ["Y"]);
});

test("mergeState: re-queueing the same PR after a tombstone (a new decision) is kept", () => {
  const X = { repo: "o/r", number: 1, method: "squash", headOid: "b" };
  const removed = new Set(["X"]);
  removed.delete("X"); // enqueue clears the tombstone
  const out = mergeState({ initialized: true, seen: [], queue: {} }, { initialized: true, seen: [], queue: { X } }, removed);
  assert.deepEqual(out.queue, { X });
  // and with no tombstones at all, the plain union still holds
  assert.deepEqual(mergeState({ initialized: true, seen: [], queue: { X } }, { initialized: true, seen: [], queue: {} }).queue, { X });
});
