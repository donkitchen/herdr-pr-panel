// Pure module: GitHub search text, gh argument builders, response parsing, error mapping.
// Everything runs through `gh`; nothing here touches the network or the filesystem.

/** @typedef {{ login:string, host:string }} Account */
/** @typedef {{ id:string, repo:string, number:number, title:string, url:string, isDraft:boolean,
 *  createdAt:string, head:string, headOid:string, base:string, defaultBranch:string,
 *  additions:number, deletions:number, mergeable:"MERGEABLE"|"CONFLICTING"|"UNKNOWN",
 *  checks:"passed"|"running"|"failed"|"none", author:{login:string, isBotType:boolean},
 *  allowed:{merge:boolean, squash:boolean, rebase:boolean}, autoMergeAllowed:boolean,
 *  account:Account }} PR   // the account that found it first; peeks and merges run as it
 */

export const SEARCH_GQL = `query($q:String!){search(type:ISSUE,query:$q,first:100){issueCount nodes{... on PullRequest{
 id number title url isDraft createdAt headRefName headRefOid baseRefName additions deletions mergeable
 author{login __typename}
 repository{nameWithOwner isArchived defaultBranchRef{name} mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed autoMergeAllowed}
 commits(last:1){nodes{commit{statusCheckRollup{state}}}}}}}}`;

export const AUTH_STATUS_ARGS = ["auth", "status", "--json", "hosts"];

/** @returns {Account[]} every login gh reports with state "success" */
export function parseAuthStatus(json) {
  const out = [];
  const hosts = json && typeof json === "object" ? json.hosts : null;
  if (!hosts || typeof hosts !== "object") return out;
  for (const [host, list] of Object.entries(hosts)) {
    if (!Array.isArray(list)) continue;
    for (const a of list) {
      if (a && a.state === "success" && typeof a.login === "string") out.push({ login: a.login, host });
    }
  }
  return out;
}

/**
 * Why `gh auth status` gave no usable account, as an error `ghError` can classify, or null
 * when some account is fine. Offline shows up as timeout/error entries (with gh's error text),
 * so the real text is passed on; "not logged in" is only for hosts that are truly empty.
 * @param {any} json parsed stdout, or null when it wasn't JSON
 * @param {{code?:number, stdout?:string, stderr?:string}} result
 */
export function authFailure(json, result) {
  const stderr = (result?.stderr ?? "").trim();
  const hosts = json && typeof json === "object" && json.hosts && typeof json.hosts === "object" ? json.hosts : null;
  if (!hosts) {
    return { code: result?.code ?? 1, stderr: stderr || (result?.stdout ?? "").trim() || "not logged in: run gh auth login", message: "" };
  }
  const entries = Object.values(hosts).flatMap((l) => (Array.isArray(l) ? l : [])).filter((a) => a && typeof a === "object");
  if (entries.some((a) => a.state === "success")) return null;
  if (entries.length === 0) return { code: result?.code ?? 1, stderr: stderr || "not logged in: run gh auth login", message: "" };
  const texts = entries.map((a) => [a.state === "timeout" ? "timed out" : "", typeof a.error === "string" ? a.error : ""].filter(Boolean).join(": "));
  const stderrText = [stderr, ...texts].filter(Boolean).join("\n");
  return { code: result?.code || 1, stderr: stderrText || "gh auth status failed", message: "" };
}

/** Configured accounts, else every logged-in account with the top-level scope. */
export function resolveAccounts(config, loggedIn) {
  if (Array.isArray(config.accounts)) return config.accounts;
  return loggedIn.map((a) => ({ login: a.login, host: a.host, scope: config.scope }));
}

// Login, host and gh args arrive as positional parameters, never inside the script text.
// The token is set for this one command only, so it never reaches argv and gh's active
// account is never switched.
const SCRIPT = [
  'command -v gh >/dev/null 2>&1 || { echo "gh: command not found" >&2; exit 127; }',
  'T=$(gh auth token --user "$1" --hostname "$2") && [ -n "$T" ] || { echo "no token found for user $1" >&2; exit 1; }',
  'export GH_TOKEN="$T"',
  'shift 2',
  'exec gh "$@"',
].join("\n");

/** @returns {{cmd:"sh", args:string[]}} */
export function ghCommand(account, args) {
  return { cmd: "sh", args: ["-c", SCRIPT, "pr-panel", account.login, account.host, ...args] };
}

const BASE = "is:pr is:open archived:false";

/** @param {{mine:boolean, owners?:string[], repos?:string[]}} scope */
export function searchQueries(scope) {
  const q = [];
  if (scope.mine) q.push(`${BASE} author:@me`, `${BASE} review-requested:@me`);
  for (const o of scope.owners ?? []) q.push(`${BASE} user:${o}`);
  for (const r of scope.repos ?? []) q.push(`${BASE} repo:${r}`);
  return q;
}

const CHECKS = { SUCCESS: "passed", PENDING: "running", EXPECTED: "running", FAILURE: "failed", ERROR: "failed" };

function toPR(n, account) {
  const r = n.repository;
  const state = n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
  return {
    id: n.id,
    repo: r.nameWithOwner,
    number: n.number,
    title: n.title ?? "",
    url: n.url,
    isDraft: !!n.isDraft,
    createdAt: n.createdAt,
    head: n.headRefName,
    headOid: n.headRefOid,
    base: n.baseRefName,
    defaultBranch: r.defaultBranchRef?.name ?? n.baseRefName,
    additions: n.additions ?? 0,
    deletions: n.deletions ?? 0,
    mergeable: n.mergeable === "MERGEABLE" || n.mergeable === "CONFLICTING" ? n.mergeable : "UNKNOWN",
    checks: CHECKS[state] ?? "none",
    author: { login: n.author?.login ?? "ghost", isBotType: n.author?.__typename === "Bot" },
    allowed: { merge: !!r.mergeCommitAllowed, squash: !!r.squashMergeAllowed, rebase: !!r.rebaseMergeAllowed },
    autoMergeAllowed: !!r.autoMergeAllowed,
    account,
  };
}

/**
 * @param {{account:Account, scope?:{exclude?:string[]}, json:any}[]} responses
 * @returns {{prs:PR[], truncated:boolean}}
 */
export function parseSearch(responses, config) {
  const seen = new Set();
  const prs = [];
  let truncated = false;
  for (const { account, scope, json } of responses) {
    const search = json?.data?.search;
    if (!search) continue;
    if (search.issueCount > 100) truncated = true;
    const exclude = new Set(((scope ?? config.scope)?.exclude ?? []).map((r) => String(r).toLowerCase()));
    for (const n of search.nodes ?? []) {
      if (!n || !n.id || !n.repository) continue; // non-PR search hits come back as {}
      if (n.repository.isArchived) continue;
      if (exclude.has(String(n.repository.nameWithOwner).toLowerCase())) continue;
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      prs.push(toPR(n, account));
    }
  }
  return { prs, truncated };
}

export const viewArgs = (pr) => ["pr", "view", String(pr.number), "-R", pr.repo, "--json", "body,files"];
export const diffArgs = (pr) => ["pr", "diff", String(pr.number), "-R", pr.repo, "--color", "never"];

/**
 * Whether a link may be opened: an absolute http(s) URL only. Anything else (a file:, a custom
 * scheme, or text starting with "-" that `open` would read as a flag) is never handed on.
 */
export function isWebUrl(url) {
  return typeof url === "string" && /^https?:\/\/[^\s/]/i.test(url);
}

/** One plain line naming the fix. */
export function ghError(err, account) {
  const text = `${err?.stderr ?? ""}\n${err?.message ?? ""}`;
  if (err?.code === 127 || /ENOENT|gh: (command )?not found|command not found: gh/i.test(text)) {
    return "Install the GitHub CLI: https://cli.github.com";
  }
  if (/API rate limit|rate limit exceeded|secondary rate limit/i.test(text)) return "GitHub rate limit: showing last list";
  if (/could not resolve host|connect(ion|ing)|timed? ?out|network is unreachable/i.test(text)) return "Offline: showing last list";
  if (account && /token|not logged in/i.test(text)) return `Log ${account.login} back in: gh auth login, then gh auth switch back`;
  if (/auth login/i.test(text)) return "Run: gh auth login";
  const line = (err?.stderr ?? "").split("\n").map((s) => s.trim()).find(Boolean);
  return line ?? "GitHub CLI failed";
}
