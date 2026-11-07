import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseConfig, DEFAULTS } from "../mods/pr-panel/config.js";

test("null text gives defaults", () => {
  const r = parseConfig(null);
  assert.equal(r.error, null);
  assert.deepEqual(r.config, DEFAULTS);
  assert.equal(r.config.refreshSeconds, 60);
  assert.equal(r.config.merge.default, "squash");
  assert.deepEqual(r.config.merge.keepHistory.headPrefixes, ["release/", "hotfix/"]);
  assert.equal(r.config.scope.mine, true);
});

test("invalid JSON reports the file and uses defaults", () => {
  const r = parseConfig("{bad");
  assert.match(r.error, /pr-panel\.json/);
  assert.deepEqual(r.config, DEFAULTS);
});

test("refresh_seconds is clamped to 30", () => {
  assert.equal(parseConfig('{"refresh_seconds":5}').config.refreshSeconds, 30);
  assert.equal(parseConfig('{"refresh_seconds":90}').config.refreshSeconds, 90);
});

test("bad ticket regex is reported and disabled", () => {
  const r = parseConfig('{"tickets":{"pattern":"[","url":"x/{key}"}}');
  assert.equal(r.config.tickets.pattern, null);
  assert.match(r.error, /tickets\.pattern/);
});

test("unknown keys are ignored", () => {
  const r = parseConfig('{"unknown":1,"bots":["acme-bot"]}');
  assert.equal(r.error, null);
  assert.deepEqual(r.config.bots, ["acme-bot"]);
});

test("the shipped example config parses cleanly", () => {
  const r = parseConfig(readFileSync(new URL("../examples/pr-panel.json", import.meta.url), "utf8"));
  assert.equal(r.error, null);
  assert.equal(r.config.handOff[0].base, "production");
  assert.ok(r.config.tickets.pattern.test("APP-255"));
  assert.equal(r.config.accounts[0].login, "you");
  assert.deepEqual(r.config.accounts[0].scope.exclude, ["acme-co/legacy"]);
});

test("merge.keep_history maps to camelCase", () => {
  const r = parseConfig('{"merge":{"keep_history":{"non_default_base":false,"head_prefixes":[]}}}');
  assert.deepEqual(r.config.merge.keepHistory, { nonDefaultBase: false, headPrefixes: [] });
  assert.equal(r.config.merge.default, "squash");
  assert.equal(r.config.merge.deleteBranch, true);
});

test("accounts", () => {
  assert.equal(parseConfig("{}").config.accounts, null);
  const r = parseConfig('{"accounts":[{"login":"a"}]}');
  assert.deepEqual(r.config.accounts, [{ login: "a", host: "github.com", scope: DEFAULTS.scope }]);
  const s = parseConfig('{"scope":{"owners":["o"]},"accounts":[{"login":"a","scope":{"mine":false}}]}');
  assert.deepEqual(s.config.accounts[0].scope, { mine: false, owners: ["o"], repos: [], exclude: [] });
  const bad = parseConfig('{"accounts":[{"host":"x"}]}');
  assert.match(bad.error, /accounts/);
});

test("parseConfig works without structuredClone (Herdr's runtime has none)", async () => {
  const saved = globalThis.structuredClone;
  globalThis.structuredClone = undefined;
  try {
    const { config, error } = parseConfig('{"scope":{"owners":["acme"]},"merge":{"default":"rebase"}}');
    assert.equal(error, null);
    assert.deepEqual(config.scope.owners, ["acme"]);
    assert.equal(config.merge.default, "rebase");
    assert.equal(parseConfig(null).config.refreshSeconds, 60);
  } finally {
    globalThis.structuredClone = saved;
  }
});

test("refresh_seconds below 30 is clamped and said so", () => {
  const r = parseConfig('{"refresh_seconds":5}');
  assert.equal(r.config.refreshSeconds, 30);
  assert.match(r.error, /refresh_seconds is at least 30/);
  assert.equal(parseConfig('{"refresh_seconds":30}').error, null);
});

test("an invalid merge.default is reported, globally and per repo, and the default stays", () => {
  const g = parseConfig('{"merge":{"default":"fast-forward"}}');
  assert.equal(g.config.merge.default, "squash");
  assert.match(g.error, /merge\.default/);
  const r = parseConfig('{"merge":{"repos":{"o/r":{"default":"octopus","delete_branch":false}}}}');
  assert.deepEqual(r.config.merge.repos["o/r"], { deleteBranch: false });
  assert.match(r.error, /merge\.repos\["o\/r"\]\.default/);
});

test("invalid delete_branch and keep_history fields are reported", () => {
  const d = parseConfig('{"merge":{"delete_branch":"yes"}}');
  assert.equal(d.config.merge.deleteBranch, true);
  assert.match(d.error, /merge\.delete_branch/);
  const n = parseConfig('{"merge":{"keep_history":{"non_default_base":"no"}}}');
  assert.equal(n.config.merge.keepHistory.nonDefaultBase, true);
  assert.match(n.error, /keep_history\.non_default_base/);
  const p = parseConfig('{"merge":{"keep_history":{"head_prefixes":"release/"}}}');
  assert.deepEqual(p.config.merge.keepHistory.headPrefixes, ["release/", "hotfix/"]);
  assert.match(p.error, /keep_history\.head_prefixes/);
  const k = parseConfig('{"merge":{"keep_history":true}}');
  assert.match(k.error, /merge\.keep_history/);
  const rd = parseConfig('{"merge":{"repos":{"o/r":{"delete_branch":1}}}}');
  assert.deepEqual(rd.config.merge.repos["o/r"], {});
  assert.match(rd.error, /merge\.repos\["o\/r"\]\.delete_branch/);
});

test("invalid age fields are reported and keep their defaults", () => {
  const r = parseConfig('{"age":{"warn_hours":"4","late_hours":12}}');
  assert.equal(r.config.age.warnHours, 4);
  assert.equal(r.config.age.lateHours, 12);
  assert.match(r.error, /age\.warn_hours/);
  assert.match(parseConfig('{"age":3}').error, /age must be an object/);
});

test("only the first problem is shown; the rest of the file still applies", () => {
  const r = parseConfig('{"refresh_seconds":"x","merge":{"default":"nope"},"bots":["b"]}');
  assert.match(r.error, /refresh_seconds must be a number/);
  assert.deepEqual(r.config.bots, ["b"]);
});

test("an empty accounts list gets its own message and uses every gh account", () => {
  const r = parseConfig('{"accounts":[]}');
  assert.equal(r.config.accounts, null);
  assert.match(r.error, /^No accounts listed in pr-panel\.json/);
});
