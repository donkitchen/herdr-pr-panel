import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULTS } from "../mods/pr-panel/config.js";
import {
  SEARCH_GQL, AUTH_STATUS_ARGS, parseAuthStatus, resolveAccounts, ghCommand,
  searchQueries, parseSearch, viewArgs, diffArgs, ghError, authFailure, isWebUrl,
} from "../mods/pr-panel/github.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/search.json", import.meta.url), "utf8"));
const A = { login: "a", host: "github.com" };
const B = { login: "b", host: "github.com" };
const scope = (o = {}) => ({ ...structuredClone(DEFAULTS.scope), ...o });
const config = (o = {}) => ({ ...structuredClone(DEFAULTS), ...o });
const nodes = fixture.data.search.nodes;
const live = nodes.filter((n) => !n.repository.isArchived);
const withNodes = (ns, issueCount = ns.length) => ({ data: { search: { issueCount, nodes: ns } } });

test("SEARCH_GQL declares $q", () => {
  assert.match(SEARCH_GQL, /query\(\$q:String!\)/);
  assert.match(SEARCH_GQL, /statusCheckRollup\{state\}/);
});

test("parseAuthStatus keeps only successful logins", () => {
  const json = { hosts: { "github.com": [
    { login: "a", active: true, state: "success" },
    { login: "b", active: false, state: "success" },
    { login: "c", state: "error" },
  ] } };
  assert.deepEqual(AUTH_STATUS_ARGS, ["auth", "status", "--json", "hosts"]);
  assert.deepEqual(parseAuthStatus(json), [A, B]);
  assert.deepEqual(parseAuthStatus({}), []);
  assert.deepEqual(parseAuthStatus(null), []);
});

test("resolveAccounts: null means every logged-in account with config.scope", () => {
  const cfg = config({ scope: scope({ owners: ["o"] }) });
  const r = resolveAccounts(cfg, [A, B]);
  assert.deepEqual(r, [{ ...A, scope: cfg.scope }, { ...B, scope: cfg.scope }]);
});

test("resolveAccounts: configured list wins even if gh knows more", () => {
  const own = scope({ mine: false, owners: ["x"] });
  const cfg = config({ accounts: [{ ...A, scope: own }] });
  assert.deepEqual(resolveAccounts(cfg, [A, B]), [{ ...A, scope: own }]);
});

test("ghCommand passes login, host and gh args as positional args", () => {
  const c = ghCommand({ login: "a b; rm -rf /", host: "github.com" }, ["pr", "view", "1"]);
  assert.equal(c.cmd, "sh");
  assert.equal(c.args[0], "-c");
  const script = c.args[1];
  assert.ok(script.includes('gh auth token --user "$1" --hostname "$2"'));
  assert.ok(script.includes("exec gh"));
  assert.ok(script.includes('shift 2'));
  assert.deepEqual(c.args.slice(2), ["pr-panel", "a b; rm -rf /", "github.com", "pr", "view", "1"]);
  assert.ok(!script.includes("rm -rf"));
  assert.ok(!script.includes("github.com"));
  assert.ok(!c.args.some((x) => x.includes("auth switch")));
});

test("ghCommand reports a missing gh as 127 with no token text", async () => {
  const { spawnSync } = await import("node:child_process");
  const c = ghCommand(A, ["pr", "view", "1"]);
  const r = spawnSync("/bin/sh", c.args, { encoding: "utf8", env: { PATH: "/nonexistent" } });
  assert.equal(r.status, 127);
  assert.ok(!/token/i.test(r.stderr));
  assert.match(ghError({ code: r.status, stderr: r.stderr }, A), /cli\.github\.com/);
});

test("ghCommand script exits non-zero when token lookup fails", () => {
  assert.match(ghCommand(A, []).args[1], /\|\|\s*\{[^}]*exit/);
});

test("searchQueries", () => {
  assert.deepEqual(searchQueries(DEFAULTS.scope), [
    "is:pr is:open archived:false author:@me",
    "is:pr is:open archived:false review-requested:@me",
  ]);
  assert.deepEqual(searchQueries({ mine: false, owners: ["o"], repos: ["a/b"] }), [
    "is:pr is:open archived:false user:o",
    "is:pr is:open archived:false repo:a/b",
  ]);
});

test("parseSearch dedupes by id; first account wins", () => {
  const { prs } = parseSearch([
    { account: A, scope: scope(), json: fixture },
    { account: B, scope: scope(), json: fixture },
  ], config());
  assert.equal(prs.length, new Set(live.map((n) => n.id)).size);
  assert.ok(prs.every((p) => p.account === A));
});

test("parseSearch maps fields to PR", () => {
  const { prs } = parseSearch([{ account: A, scope: scope(), json: fixture }], config());
  const n = nodes[0];
  const p = prs.find((x) => x.id === n.id);
  assert.deepEqual(p, {
    id: n.id, repo: "acme/widgets", number: n.number, title: n.title, url: n.url, isDraft: false,
    createdAt: n.createdAt, head: n.headRefName, headOid: n.headRefOid, base: n.baseRefName,
    defaultBranch: "main", additions: n.additions, deletions: n.deletions, mergeable: "MERGEABLE",
    checks: "passed", author: { login: "alice", isBotType: false },
    allowed: { merge: true, squash: true, rebase: true }, autoMergeAllowed: false, account: A,
  });
  assert.ok(prs.some((x) => x.author.isBotType && x.author.login === "dependabot"));
  assert.ok(prs.some((x) => x.isDraft));
  assert.ok(prs.some((x) => x.mergeable === "CONFLICTING"));
  assert.ok(prs.some((x) => x.mergeable === "UNKNOWN"));
});

test("parseSearch maps rollup states", () => {
  const by = (num) => parseSearch([{ account: A, scope: scope(), json: fixture }], config()).prs.find((p) => p.number === num);
  assert.equal(by(10).checks, "passed");
  assert.equal(by(104).checks, "running"); // PENDING
  assert.equal(by(105).checks, "running"); // EXPECTED
  assert.equal(by(106).checks, "failed"); // ERROR
  const fail = nodes.find((n) => n.number < 100 && n.commits.nodes[0]?.commit.statusCheckRollup?.state === "FAILURE");
  assert.equal(by(fail.number).checks, "failed"); // FAILURE
  assert.equal(by(107).checks, "none"); // null rollup
  assert.equal(by(108).checks, "none"); // no commits
});

test("parseSearch drops archived repos", () => {
  const { prs } = parseSearch([{ account: A, scope: scope(), json: fixture }], config());
  assert.ok(!prs.some((p) => p.repo === "acme/old-stuff"));
  assert.equal(prs.length, live.length);
});

test("parseSearch honors the response scope.exclude", () => {
  const { prs } = parseSearch([{ account: A, scope: scope({ exclude: ["acme/noisy"] }), json: fixture }], config());
  assert.ok(!prs.some((p) => p.repo === "acme/noisy"));
  assert.equal(prs.length, live.length - 1);
});

test("parseSearch falls back to config.scope.exclude when the response has no scope", () => {
  const cfg = config({ scope: scope({ exclude: ["acme/noisy"] }) });
  const { prs } = parseSearch([{ account: A, json: fixture }], cfg);
  assert.ok(!prs.some((p) => p.repo === "acme/noisy"));
});

test("parseSearch: a repo excluded for account A still shows via account B", () => {
  const { prs } = parseSearch([
    { account: A, scope: scope({ exclude: ["acme/noisy"] }), json: fixture },
    { account: B, scope: scope(), json: fixture },
  ], config());
  const noisy = prs.find((p) => p.repo === "acme/noisy");
  assert.ok(noisy);
  assert.equal(noisy.account, B);
});

test("parseSearch truncated when any issueCount > 100", () => {
  const ok = withNodes(live.slice(0, 2), 100);
  const big = withNodes(live.slice(0, 2), 101);
  assert.equal(parseSearch([{ account: A, scope: scope(), json: ok }], config()).truncated, false);
  assert.equal(parseSearch([{ account: A, scope: scope(), json: ok }, { account: B, scope: scope(), json: big }], config()).truncated, true);
});

test("parseSearch tolerates empty or malformed nodes", () => {
  const json = withNodes([{}, null, ...live.slice(0, 1)]);
  const { prs } = parseSearch([{ account: A, scope: scope(), json }, { account: B, scope: scope(), json: {} }], config());
  assert.equal(prs.length, 1);
});

test("viewArgs and diffArgs", () => {
  const pr = { number: 7, repo: "o/r" };
  assert.deepEqual(viewArgs(pr), ["pr", "view", "7", "-R", "o/r", "--json", "body,files"]);
  assert.deepEqual(diffArgs(pr), ["pr", "diff", "7", "-R", "o/r", "--color", "never"]);
});

test("ghError", () => {
  assert.match(ghError({ message: "spawn gh ENOENT" }), /https:\/\/cli\.github\.com/);
  assert.equal(ghError({ stderr: "To get started with GitHub CLI, please run:  gh auth login" }), "Run: gh auth login");
  assert.equal(ghError({ stderr: "dial tcp: lookup api.github.com: Could not resolve host" }), "Offline: showing last list");
  assert.equal(ghError({ stderr: "error connecting to api.github.com" }), "Offline: showing last list");
  assert.equal(ghError({ stderr: "API rate limit exceeded for user" }), "GitHub rate limit: showing last list");
  assert.equal(ghError({ stderr: "You have exceeded a secondary rate limit." }), "GitHub rate limit: showing last list");
  assert.equal(ghError({ stderr: "no oauth token found for github.com" }, A), "Log a back in: gh auth login, then gh auth switch back");
  assert.equal(ghError({ stderr: "no token found for user a" }, A), "Log a back in: gh auth login, then gh auth switch back");
  assert.equal(ghError({ stderr: "weird failure\nsecond line" }), "weird failure");
  assert.equal(ghError({}), "GitHub CLI failed");
  // missing gh through sh: old script printed this stderr, and the token guard used to win
  assert.match(ghError({ code: 1, stderr: "pr-panel: gh: command not found\nno token found for user a\n" }, A), /cli\.github\.com/);
  assert.match(ghError({ code: 127, stderr: "gh: command not found\n" }, A), /cli\.github\.com/);
});

test("authFailure: offline auth status yields the Offline line, not a login prompt", () => {
  const json = { hosts: { "github.com": [
    { state: "timeout", login: "a", host: "github.com", error: "" },
    { state: "error", login: "b", host: "github.com", error: "dial tcp: lookup api.github.com: no such host; could not resolve host" },
  ] } };
  const e = authFailure(json, { code: 1, stdout: JSON.stringify(json), stderr: "" });
  assert.ok(e);
  assert.equal(ghError(e), "Offline: showing last list");
});

test("authFailure: timeout state alone classifies as offline", () => {
  const json = { hosts: { "github.com": [{ state: "timeout", login: "a", host: "github.com" }] } };
  assert.equal(ghError(authFailure(json, { code: 1, stderr: "" })), "Offline: showing last list");
});

test("authFailure: null when any account succeeds", () => {
  const json = { hosts: { "github.com": [{ state: "success", login: "a" }, { state: "error", login: "b", error: "x" }] } };
  assert.equal(authFailure(json, { code: 0, stderr: "" }), null);
});

test("authFailure: truly empty hosts means not logged in", () => {
  assert.equal(ghError(authFailure({ hosts: {} }, { code: 1, stderr: "" })), "Run: gh auth login");
});

test("authFailure: non-JSON output keeps gh's stderr", () => {
  assert.equal(ghError(authFailure(null, { code: 127, stderr: "gh: command not found" })), "Install the GitHub CLI: https://cli.github.com");
});

test("parseSearch: exclude matches the repo name case-insensitively", () => {
  const { prs } = parseSearch([{ account: A, scope: scope({ exclude: ["ACME/Noisy"] }), json: fixture }], config());
  assert.ok(!prs.some((p) => p.repo === "acme/noisy"));
});

test("isWebUrl: only absolute http(s) links", () => {
  assert.equal(isWebUrl("https://github.com/o/r/pull/1"), true);
  assert.equal(isWebUrl("HTTP://example.com"), true);
  for (const bad of ["-a Calculator", "file:///etc/passwd", "javascript:alert(1)", "ssh://x", "https:///x", "//example.com", "", null, undefined, 7]) {
    assert.equal(isWebUrl(bad), false, String(bad));
  }
});
