// Pure module: which merge method to use, whether a PR can be merged yet,
// the gh arguments, and what a queued "merge when green" entry should do next.
import { classify } from "./model.js";

const ORDER = ["squash", "merge", "rebase"];
const WORD = { squash: "squash", merge: "merge commit", rebase: "rebase" };
const FLAG = { squash: "--squash", merge: "--merge", rebase: "--rebase" };

/** A per-repo entry from a map keyed by "owner/repo". GitHub names are case-insensitive. */
export function repoEntry(map, repo) {
  if (!map || typeof repo !== "string") return undefined;
  const want = repo.toLowerCase();
  for (const [k, v] of Object.entries(map)) if (k.toLowerCase() === want) return v;
  return undefined;
}

// Per-repo overrides hold only the keys they set, so layer them over the global rules.
function effective(config, repo) {
  const m = config.merge;
  const o = repoEntry(m.repos, repo) || {};
  return {
    default: o.default ?? m.default,
    repoDefault: o.default ?? null,
    keepHistory: { ...m.keepHistory, ...(o.keepHistory || {}) },
  };
}

function keepHistoryWhy(pr, kh) {
  if (kh.nonDefaultBase && pr.base !== pr.defaultBranch) return `base isn't ${pr.defaultBranch}`;
  const p = (kh.headPrefixes || []).find((x) => x && pr.head.startsWith(x));
  if (p) return `head starts with ${p}`;
  return null;
}

/**
 * @returns {{method:"squash"|"merge"|"rebase"|null, options:string[], reason:string, handOff:object|null}}
 */
export function chooseMethod(pr, config) {
  const cls = classify(pr, config);
  if (cls.kind === "handoff") {
    return { method: null, options: [], reason: `${cls.rule.label}: not merged here`, handOff: cls.rule };
  }

  const eff = effective(config, pr.repo);
  let wanted, why = null;
  if (eff.repoDefault) wanted = eff.repoDefault;                 // rule 4: wins over 2 and 3
  else if ((why = keepHistoryWhy(pr, eff.keepHistory))) wanted = "merge"; // rule 2
  else wanted = eff.default;                                      // rule 3

  const allowed = ORDER.filter((m) => pr.allowed && pr.allowed[m]);
  if (allowed.length === 0) {
    return { method: null, options: [], reason: "no merge method is allowed in this repo", handOff: null };
  }

  // Keep-history is a safety rule: never quietly squash a release/non-default-base PR.
  if (why && !allowed.includes("merge")) {
    return { method: null, options: allowed, reason: "merge commit isn't allowed here; pick a method", handOff: null };
  }

  let method = wanted;
  let reason = `${WORD[wanted]} → ${pr.base}${why ? ` (${why})` : ""}`;
  if (!allowed.includes(wanted)) {
    method = allowed[0];
    reason = `${WORD[wanted]} isn't allowed in this repo; ${WORD[method]} → ${pr.base}`;
  }
  return { method, options: [method, ...allowed.filter((m) => m !== method)], reason, handOff: null };
}

/** UNKNOWN means GitHub is still computing: "checking", never a conflict. */
export function mergeBlocker(pr) {
  if (pr.isDraft) return "draft";
  if (pr.mergeable === "CONFLICTING") return "conflicts";
  if (pr.mergeable === "UNKNOWN") return "checking";
  return null;
}

/**
 * Always pins the head commit, so code you haven't seen can't merge. Never turns on GitHub
 * auto-merge: "merge when green" is the panel's own queue, which pins the head too.
 */
export function mergeArgs(pr, method, { deleteBranch }) {
  if (!Object.hasOwn(FLAG, method)) throw new Error(`unknown merge method: ${method}`);
  const args = ["pr", "merge", String(pr.number), "-R", pr.repo, FLAG[method]];
  if (deleteBranch) args.push("--delete-branch");
  args.push("--match-head-commit", pr.headOid);
  return args;
}

/**
 * Order: gone, moved, retargeted, draft, conflicts, failed, running (wait), still computing
 * (wait), merge. "none" checks count as green; UNKNOWN mergeable waits for the next refresh.
 * A PR missing from a list that was cut at 100 results may still be open: it waits.
 * @returns {"merge"|"wait"|"drop:failed"|"drop:moved"|"drop:retargeted"|"drop:gone"|"drop:draft"|"drop:conflicts"}
 */
export function queueDecision(entry, pr, { truncated = false } = {}) {
  if (!pr) return truncated ? "wait" : "drop:gone";
  if (pr.headOid !== entry.headOid) return "drop:moved";
  if (pr.base !== entry.base) return "drop:retargeted";
  if (pr.isDraft) return "drop:draft";
  if (pr.mergeable === "CONFLICTING") return "drop:conflicts";
  if (pr.checks === "failed") return "drop:failed";
  if (pr.checks === "running") return "wait";
  if (pr.mergeable === "UNKNOWN") return "wait";
  return "merge";
}

// ---- The confirm and the hand-back to the panel (pure, so they can be tested) ----

export const METHOD_NAME = { squash: "Squash", merge: "Merge commit", rebase: "Rebase" };
/** How long a merge request from the confirm stays good. Shared values persist, so an old one must never fire. */
export const REQUEST_TTL_MS = 2 * 60 * 1000;

/**
 * Whether a merge of this PR deletes its head branch. A per-repo `delete_branch` wins over the
 * global one. Never when the head is the repo's default branch, or when the PR keeps history
 * (non-default base or a release/hotfix head): those branches live on after the merge.
 */
export function deleteBranchFor(config, pr) {
  const on = repoEntry(config.merge.repos, pr.repo)?.deleteBranch ?? config.merge.deleteBranch;
  if (!on) return false;
  if (pr.head === pr.defaultBranch) return false;
  if (keepHistoryWhy(pr, effective(config, pr.repo).keepHistory)) return false;
  return true;
}

/** The confirm's starting state, from chooseMethod's choice. `deletes` is the head branch a merge deletes, or null. */
export function confirmStart(choice) {
  return {
    method: choice.method ?? null, suggested: choice.method ?? null, options: [...(choice.options ?? [])],
    reason: choice.reason ?? "", armed: false, deletes: typeof choice.deletes === "string" ? choice.deletes : null,
  };
}

/**
 * What the confirm shows. `failed` turns the line red; `green` offers "merge when green".
 * @returns {{line:string, reason:string, failed:boolean, green:boolean}}
 */
export function confirmView(pr, st) {
  const failed = pr.checks === "failed";
  const green = pr.checks === "running" && st.method !== null;
  let line;
  if (st.method === null) line = "Pick a method: s";
  else if (failed && st.armed) line = "Checks failed. Press y again to merge anyway.";
  else line = `${METHOD_NAME[st.method]} #${pr.number} → ${pr.base}${st.deletes ? ` · deletes ${st.deletes}` : ""}? (y · s switch method · Esc)`;
  // Once s moves off the suggested method, the reason is about the suggestion, so say so.
  const reason = st.method !== null && st.suggested && st.method !== st.suggested && st.reason ? `Suggested: ${st.reason}` : st.reason;
  return { line, reason, failed, green };
}

/**
 * One key in the confirm. Returns the next state, and `request` ({method, when}) when the
 * person has decided, or `close` for Esc. y and w do nothing until a method is picked.
 */
export function confirmKey(st, key, pr) {
  if (key === "escape") return { st, close: true, request: null };
  if (key === "s") {
    if (st.options.length === 0) return { st, close: false, request: null };
    const at = st.method === null ? -1 : st.options.indexOf(st.method);
    const method = st.options[(at + 1) % st.options.length];
    return { st: { ...st, method, armed: false }, close: false, request: null };
  }
  if (st.method === null) return { st, close: false, request: null };
  if (key === "y") {
    if (pr.checks === "failed" && !st.armed) return { st: { ...st, armed: true }, close: false, request: null };
    return { st, close: true, request: { method: st.method, when: "now" } };
  }
  if (key === "w" && pr.checks === "running") return { st, close: true, request: { method: st.method, when: "green" } };
  return { st, close: false, request: null };
}

/**
 * The panel's check on a request handed back by the confirm: it must be fresh, for the PR the
 * panel opened the confirm for, at the head commit the person saw, with a method that was offered.
 * Returns the merge to run (using the PR as the confirm showed it), or null.
 */
export function acceptRequest(req, confirming, now) {
  if (!req || typeof req !== "object" || !confirming) return null;
  const { pr, options } = confirming;
  if (req.prId !== pr.id || req.headOid !== pr.headOid) return null;
  if (!(typeof req.at === "number" && now - req.at >= 0 && now - req.at <= REQUEST_TTL_MS)) return null;
  if (!options.includes(req.method) || !Object.hasOwn(FLAG, req.method)) return null;
  if (req.when !== "now" && req.when !== "green") return null;
  return { pr, method: req.method, when: req.when, deleteBranch: confirming.deleteBranch === true };
}

/**
 * The peek's `m`, handed to the panel as {prId, headOid, at}. Returns "ok" when the panel should
 * run its own `m` for `pr` (the PR as the panel has it now), "moved" when commits landed since
 * the peek was drawn, or null to ignore it (unknown PR, stale or malformed ask).
 */
export function acceptAsk(ask, pr, now) {
  if (!ask || typeof ask !== "object" || !pr || ask.prId !== pr.id) return null;
  if (!(typeof ask.at === "number" && Math.abs(now - ask.at) < 60_000)) return null;
  if (ask.headOid !== pr.headOid) return "moved";
  return "ok";
}

/**
 * A "merge when green" queue entry. It keeps the account, so a restart merges as the same one,
 * and the base, so a PR retargeted to another branch never merges there.
 */
export function queueEntry(pr, method, deleteBranch = false) {
  return {
    repo: pr.repo, number: pr.number, method, headOid: pr.headOid, base: pr.base, deleteBranch: deleteBranch === true,
    account: { login: pr.account.login, host: pr.account.host },
  };
}
