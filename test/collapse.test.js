import { test } from "node:test";
import assert from "node:assert/strict";
import { collapseAction } from "../mods/pr-panel/collapse.js";

const tree = (pr, ss, stack = {}) => ({
  id: "root", type: "row", children: [{
    id: "work-body", type: "row", children: [
      { id: "main", type: "block", content: { tab: "active" } },
      { id: "right-stack", type: "column", ...stack, children: [
        { id: "pr-panel", type: "block", content: { mod: "pr-panel" }, ...(pr ? { hidden: true } : {}) },
        { id: "skillshare-panel", type: "column", children: [], ...(ss ? { hidden: true } : {}) },
      ] }] }] });

test("both hidden hides the parent", () => {
  assert.deepEqual(collapseAction(tree(true, true), "pr-panel"), { op: "hide", id: "right-stack" });
});
test("one shown with parent hidden shows the parent", () => {
  assert.deepEqual(collapseAction(tree(true, false, { hidden: true }), "pr-panel"), { op: "show", id: "right-stack" });
});
test("settled states do nothing", () => {
  assert.equal(collapseAction(tree(false, false), "pr-panel"), null);
  assert.equal(collapseAction(tree(true, true, { hidden: true }), "pr-panel"), null);
});
test("work-body (holds the tab area) and root are never touched", () => {
  const t = { id: "root", type: "row", children: [{ id: "work-body", type: "row", children: [
    { id: "main", type: "block", content: { tab: "active" }, hidden: true },
    { id: "pr-panel", type: "block", content: { mod: "pr-panel" }, hidden: true }] }] };
  assert.equal(collapseAction(t, "pr-panel"), null);
  const direct = { id: "root", type: "row", children: [{ id: "pr-panel", type: "block", hidden: true }] };
  assert.equal(collapseAction(direct, "pr-panel"), null);
});
test("missing panel or tree", () => {
  assert.equal(collapseAction(null, "pr-panel"), null);
  assert.equal(collapseAction(tree(true, true), "nope"), null);
});
test("never acts on Herdr's own panel column, or a column holding a stack", () => {
  const herdr = { id: "root", type: "row", children: [{ id: "work-body", type: "row", children: [
    { id: "main", type: "block", content: { tab: "active" } },
    { id: "panel", type: "column", children: [
      { id: "pr-panel", type: "block", content: { mod: "pr-panel" }, hidden: true },
      { id: "x", type: "block", content: { mod: "x" }, hidden: true }] }] }] };
  assert.equal(collapseAction(herdr, "pr-panel"), null);
  const stacked = structuredClone(herdr);
  stacked.children[0].children[1].id = "side";
  stacked.children[0].children[1].children[1] = { id: "panel-body", type: "stack", hidden: true, children: [] };
  assert.equal(collapseAction(stacked, "pr-panel"), null);
});
