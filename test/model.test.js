import test from "node:test";
import assert from "node:assert/strict";
import { isBot, classify, ageLevel, formatAge, ticketKeys, ticketUrl, buildView } from "../mods/pr-panel/model.js";
import { DEFAULTS } from "../mods/pr-panel/config.js";

const NOW = Date.parse("2026-11-07T12:00:00Z");
const ago = (ms) => new Date(NOW - ms).toISOString();
const H = 3600e3;
const M = 60e3;

const cfg = (over = {}) => ({ ...DEFAULTS, ...over });
const pr = (over = {}) => ({
  id: "1", repo: "o/a", number: 1, title: "t", url: "u", isDraft: false,
  createdAt: ago(H), head: "feat/x", headOid: "abc", base: "main", defaultBranch: "main",
  additions: 1, deletions: 1, mergeable: "MERGEABLE", checks: "passed",
  author: { login: "human", isBotType: false },
  allowed: { merge: true, squash: true, rebase: true }, autoMergeAllowed: true,
  account: { login: "me", host: "github.com" }, ...over,
});
const rule = { repo: "o/a", base: "develop", label: "Hand off", url: "x" };

test("isBot: type, configured login, never text", () => {
  assert.equal(isBot(pr({ author: { login: "x", isBotType: true } }), cfg()), true);
  assert.equal(isBot(pr({ author: { login: "bob-bot", isBotType: false } }), cfg({ bots: ["bob-bot"] })), true);
  assert.equal(isBot(pr({ title: "🤖 robot", body: "🤖" }), cfg()), false);
});

test("classify: draft, handoff, handoff beats draft, head prefix", () => {
  const c = cfg({ handOff: [rule] });
  assert.deepEqual(classify(pr({ isDraft: true }), c), { kind: "draft" });
  assert.deepEqual(classify(pr(), c), { kind: "waiting" });
  assert.deepEqual(classify(pr({ base: "develop" }), c), { kind: "handoff", rule });
  assert.equal(classify(pr({ base: "develop", isDraft: true }), c).kind, "handoff");
  assert.equal(classify(pr({ base: "develop", repo: "o/b" }), c).kind, "waiting");
  const h = cfg({ handOff: [{ ...rule, head: "release/" }] });
  assert.equal(classify(pr({ base: "develop", head: "release/1" }), h).kind, "handoff");
  assert.equal(classify(pr({ base: "develop", head: "feat/1" }), h).kind, "waiting");
});

test("ageLevel", () => {
  const age = { warnHours: 4, lateHours: 24 };
  assert.equal(ageLevel(ago(4 * H - M), NOW, age), "ok");
  assert.equal(ageLevel(ago(4 * H), NOW, age), "warn");
  assert.equal(ageLevel(ago(24 * H), NOW, age), "late");
});

test("formatAge floors", () => {
  assert.equal(formatAge(ago(30e3), NOW), "now");
  assert.equal(formatAge(ago(2 * M + 59e3), NOW), "2m");
  assert.equal(formatAge(ago(9 * H + 50 * M), NOW), "9h");
  assert.equal(formatAge(ago(55 * 24 * H + H), NOW), "55d");
});

test("ticketKeys dedupes in first-seen order; null pattern gives []", () => {
  const tickets = { pattern: /APP-\d+/g, url: null };
  const p = pr({ title: "Admin page (APP-255, APP-256)", head: "claude/APP-255" });
  assert.deepEqual(ticketKeys(p, tickets), ["APP-255", "APP-256"]);
  assert.deepEqual(ticketKeys(p, tickets), ["APP-255", "APP-256"]); // shared regex state safe
  assert.deepEqual(ticketKeys(p, { pattern: null, url: null }), []);
});

test("ticketUrl", () => {
  assert.equal(ticketUrl("CHQ-1", { pattern: null, url: "https://x/browse/{key}" }), "https://x/browse/CHQ-1");
  assert.equal(ticketUrl("CHQ-1", { pattern: null, url: null }), null);
});

test("buildView: counts waiting, sorts groups and items, groups hand-offs", () => {
  const c = cfg({ handOff: [rule], tickets: { pattern: /T-\d+/g, url: null } });
  const prs = [
    pr({ id: "a1", repo: "o/a", number: 1, createdAt: ago(2 * H) }),
    pr({ id: "a2", repo: "o/a", number: 2, createdAt: ago(5 * H), title: "T-9 thing" }),
    pr({ id: "b1", repo: "o/b", number: 1, createdAt: ago(10 * H) }),
    pr({ id: "d1", repo: "o/d", number: 1, createdAt: ago(100 * H), isDraft: true }),
    pr({ id: "c1", repo: "o/c", number: 1, createdAt: ago(1 * H) }),
    pr({ id: "h1", repo: "o/a", number: 3, base: "develop", createdAt: ago(300 * H) }),
  ];
  const v = buildView(prs, c, NOW);
  assert.equal(v.count, 4);
  assert.deepEqual(v.groups.map((g) => g.repo), ["o/b", "o/a", "o/c", "o/d"]);
  assert.deepEqual(v.groups[1].items.map((i) => i.pr.id), ["a2", "a1"]);
  assert.equal(v.groups[1].items[0].age, "5h");
  assert.equal(v.groups[1].items[0].ageLevel, "warn");
  assert.deepEqual(v.groups[1].items[0].tickets, ["T-9"]);
  assert.equal(v.groups[3].items[0].kind, "draft");
  assert.equal(v.handOff.length, 1);
  assert.equal(v.handOff[0].label, "Hand off");
  assert.equal(v.handOff[0].items[0].ageLevel, "ok");
  assert.equal(v.handOff[0].items[0].kind, "handoff");
});
