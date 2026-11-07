// Pure module: turns the text of pr-panel.json into a normalized Config.
// Settings are snake_case in the file and camelCase here. Unknown keys are ignored.
// Only the first problem is reported; the rest of the file still applies where it can.
// Note: tickets.pattern is compiled with the g flag, so a consumer must reset lastIndex
// before .test()/.exec() on it, or use matchAll.

const FILE = "pr-panel.json";

/** @typedef {{mine:boolean, owners:string[], repos:string[], exclude:string[]}} Scope */

/** @type {any} */
export const DEFAULTS = Object.freeze({
  accounts: null,
  scope: { mine: true, owners: [], repos: [], exclude: [] },
  refreshSeconds: 60,
  age: { warnHours: 4, lateHours: 24 },
  bots: [],
  merge: {
    default: "squash",
    keepHistory: { nonDefaultBase: true, headPrefixes: ["release/", "hotfix/"] },
    deleteBranch: true,
    repos: {},
  },
  handOff: [],
  tickets: { pattern: null, url: null },
});

const METHODS = ["squash", "merge", "rebase"];
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : null);
// Plain JSON data only (no RegExp at clone time). Herdr's runtime has no structuredClone.
const clone = (v) => JSON.parse(JSON.stringify(v));

function scopeFrom(raw, base) {
  const s = clone(base);
  if (!isObj(raw)) return s;
  if (typeof raw.mine === "boolean") s.mine = raw.mine;
  for (const k of ["owners", "repos", "exclude"]) {
    const a = strings(raw[k]);
    if (a) s[k] = a;
  }
  return s;
}

// The merge settings shared by the global block and a per-repo override. Each valid key is
// written to `out`; an invalid one is reported (`where` names it) and left out.
function mergeKeys(raw, out, where, problem) {
  if (raw.default !== undefined) {
    if (METHODS.includes(raw.default)) out.default = raw.default;
    else problem(`${where}.default must be "squash", "merge" or "rebase"`);
  }
  if (raw.keep_history !== undefined) {
    const k = raw.keep_history;
    if (!isObj(k)) problem(`${where}.keep_history must be an object`);
    else {
      const kh = {};
      if (k.non_default_base !== undefined) {
        if (typeof k.non_default_base === "boolean") kh.nonDefaultBase = k.non_default_base;
        else problem(`${where}.keep_history.non_default_base must be true or false`);
      }
      if (k.head_prefixes !== undefined) {
        const p = strings(k.head_prefixes);
        if (p && p.length === k.head_prefixes.length) kh.headPrefixes = p;
        else problem(`${where}.keep_history.head_prefixes must be a list of strings`);
      }
      out.keepHistory = { ...(out.keepHistory || {}), ...kh };
    }
  }
  if (raw.delete_branch !== undefined) {
    if (typeof raw.delete_branch === "boolean") out.deleteBranch = raw.delete_branch;
    else problem(`${where}.delete_branch must be true or false`);
  }
}

function mergeFrom(raw, base, problem) {
  const m = clone(base);
  if (raw === undefined) return m;
  if (!isObj(raw)) { problem("merge must be an object"); return m; }
  mergeKeys(raw, m, "merge", problem);
  return m;
}

// Per-repo overrides keep only the keys they set, so they can win over the defaults later.
function repoOverride(raw, repo, problem) {
  const o = {};
  if (!isObj(raw)) { problem(`merge.repos["${repo}"] must be an object`); return o; }
  mergeKeys(raw, o, `merge.repos["${repo}"]`, problem);
  return o;
}

/**
 * @param {string|null} text file contents, or null when the file is missing
 * @returns {{config:any, error:string|null}}
 */
export function parseConfig(text) {
  if (text === null || text === undefined) return { config: clone(DEFAULTS), error: null };
  let raw;
  try { raw = JSON.parse(text); }
  catch (e) { return { config: clone(DEFAULTS), error: `${FILE}: invalid JSON (${e.message})` }; }
  if (!isObj(raw)) return { config: clone(DEFAULTS), error: `${FILE}: expected a JSON object` };

  const c = clone(DEFAULTS);
  let error = null;
  const problem = (msg) => { if (error === null) error = `${FILE}: ${msg}`; };

  c.scope = scopeFrom(raw.scope, c.scope);

  if (raw.refresh_seconds !== undefined) {
    if (typeof raw.refresh_seconds === "number" && Number.isFinite(raw.refresh_seconds)) {
      c.refreshSeconds = Math.max(30, raw.refresh_seconds);
      if (raw.refresh_seconds < 30) problem(`refresh_seconds is at least 30; using 30`);
    } else problem("refresh_seconds must be a number");
  }

  if (raw.age !== undefined) {
    if (!isObj(raw.age)) problem("age must be an object");
    else {
      for (const [key, name] of [["warn_hours", "warnHours"], ["late_hours", "lateHours"]]) {
        const v = raw.age[key];
        if (v === undefined) continue;
        if (typeof v === "number" && Number.isFinite(v) && v >= 0) c.age[name] = v;
        else problem(`age.${key} must be a number of hours`);
      }
    }
  }

  const bots = strings(raw.bots);
  if (bots) c.bots = bots;

  c.merge = mergeFrom(raw.merge, c.merge, problem);
  if (isObj(raw.merge) && raw.merge.repos !== undefined) {
    if (!isObj(raw.merge.repos)) problem("merge.repos must be an object");
    else for (const [repo, v] of Object.entries(raw.merge.repos)) c.merge.repos[repo] = repoOverride(v, repo, problem);
  }

  if (raw.hand_off !== undefined) {
    if (!Array.isArray(raw.hand_off)) problem("hand_off must be a list");
    else {
      for (const [i, h] of raw.hand_off.entries()) {
        if (!isObj(h) || typeof h.repo !== "string" || typeof h.base !== "string") {
          problem(`hand_off[${i}] needs a repo and a base`);
          continue;
        }
        const rule = { repo: h.repo, base: h.base, label: typeof h.label === "string" ? h.label : "Hand off", url: typeof h.url === "string" ? h.url : "" };
        if (typeof h.head === "string") rule.head = h.head;
        c.handOff.push(rule);
      }
    }
  }

  if (isObj(raw.tickets)) {
    if (typeof raw.tickets.url === "string") c.tickets.url = raw.tickets.url;
    if (raw.tickets.pattern !== undefined) {
      try {
        if (typeof raw.tickets.pattern !== "string") throw new Error("not a string");
        c.tickets.pattern = new RegExp(raw.tickets.pattern, "g");
      } catch (e) {
        c.tickets.pattern = null;
        problem(`tickets.pattern is not a valid regex (${e.message})`);
      }
    }
  }

  if (raw.accounts !== undefined) {
    if (!Array.isArray(raw.accounts)) problem("accounts must be a list");
    else if (raw.accounts.length === 0) {
      // An empty list would show nothing at all: say so, and use every logged-in account.
      if (error === null) error = `No accounts listed in ${FILE}: using every gh account`;
    } else {
      const list = [];
      for (const [i, a] of raw.accounts.entries()) {
        if (!isObj(a) || typeof a.login !== "string" || a.login === "") {
          problem(`accounts[${i}] needs a login`);
          continue;
        }
        list.push({
          login: a.login,
          host: typeof a.host === "string" && a.host !== "" ? a.host : "github.com",
          scope: scopeFrom(a.scope, c.scope),
        });
      }
      c.accounts = list;
    }
  }

  return { config: c, error };
}
