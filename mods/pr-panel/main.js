// pr-panel: open GitHub PRs beside your agents.
// Roles (props.role): the panel (default, or "panel") polls gh, draws the list and posts the
// toasts; "toggle" is the tab-bar button that shows or hides the panel's layout node.
// "peek" is the PR dialog Enter opens (ui/peek.js); "confirm" is the merge confirmation `m` opens
// (ui/confirm.js). The confirm only decides: it hands {prId, method, when, headOid} back through
// shared state and the panel runs the merge, because an overlay's tasks end when it closes.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import {
  exec, run, theme, settings, layout, panes, spaces, notify, shared, setShared, nextCommand,
  readTextFile, writeTextFile, appHome, openOverlay, props as blockProps,
} from "herdr";
import { parseConfig } from "./config.js";
import { collapseAction } from "./collapse.js";
import { SEARCH_GQL, AUTH_STATUS_ARGS, parseAuthStatus, authFailure, resolveAccounts, ghCommand, searchQueries, parseSearch, ghError } from "./github.js";
import { buildView, classify, formatAge } from "./model.js";
import { updateSeen, mergeState, withoutRemoved } from "./seen.js";
import { chooseMethod, mergeBlocker, mergeArgs, queueDecision, deleteBranchFor, acceptRequest, acceptAsk, queueEntry } from "./merge.js";
import { renderPanel, rowOrder } from "./ui/panel.js";
import { Peek, MERGE_ASK } from "./ui/peek.js";
import { Confirm, MERGE_REQUEST } from "./ui/confirm.js";
import { openWebUrl } from "./ui/open.js";

const MOD = "pr-panel";
const COUNT = "pr-panel.count"; // number of waiting PRs, for the toggle
const SELECT = "pr-panel.select"; // a PR id the panel should select (set when a toast is posted)
const AUTH_EVERY_MS = 10 * 60 * 1000;
const MAX_LINE = 120;
const MERGED_HIDE_MS = 10 * 60 * 1000; // search lags a merge: hide a PR we merged for this long

const configPath = () => `${appHome()}/pr-panel.json`;
const statePath = () => `${appHome()}/pr-panel.state.json`;
const clip = (s) => (s.length > MAX_LINE ? `${s.slice(0, MAX_LINE - 1)}…` : s);
const fontSize = () => Number(settings()?.ui_font_size) || 13;

/** The panel's layout node: the block showing this mod whose role isn't "toggle". */
export function panelNode(node = layout()) {
  if (!node || typeof node !== "object") return null;
  const c = node.content;
  if (node.type === "block" && c?.mod === MOD && (c.props?.role ?? "panel") !== "toggle") return node;
  for (const child of node.children ?? []) {
    const found = panelNode(child);
    if (found) return found;
  }
  return null;
}

function parseState(text) {
  try {
    const s = text ? JSON.parse(text) : null;
    if (s && typeof s === "object") {
      return {
        initialized: s.initialized === true,
        seen: Array.isArray(s.seen) ? s.seen.filter((x) => typeof x === "string") : [],
        queue: s.queue && typeof s.queue === "object" && !Array.isArray(s.queue) ? s.queue : {},
      };
    }
  } catch { /* unreadable: start over, quietly (first run never toasts) */ }
  return { initialized: false, seen: [], queue: {} };
}

/** Runs gh as one account and returns its parsed JSON, or throws {code, stderr, message}. */
async function ghJson(account, args) {
  const c = ghCommand(account, args);
  const r = await exec(c.cmd, c.args);
  if (r.code !== 0) throw { code: r.code, stderr: r.stderr || r.stdout, message: "" };
  try { return JSON.parse(r.stdout); }
  catch { throw { code: 1, stderr: (r.stdout || r.stderr || "").slice(0, 200), message: "gh returned something that isn't JSON" }; }
}

let lastCollapse = null; // op:id already sent, so a re-render before the layout updates doesn't repeat it

function toggle() {
  const t = theme();
  const act = collapseAction(layout(), panelNode()?.id);
  const key = act ? `${act.op}:${act.id}` : null;
  if (key && key !== lastCollapse) run(`layout.${act.op}`, { id: act.id });
  lastCollapse = key;
  const n = Number(shared(COUNT)) || 0;
  const node = panelNode();
  const on = node && !node.hidden;
  const size = fontSize();
  return h_flex().size_full().pr(10).items_center().bg(t.chrome).border_b(1).border_color(t.border)
    .child(h_flex().id("toggle-pr-panel").h(26).px(8).gap(6).flex_none().items_center().rounded(6).cursor_pointer()
      .text_size(size - 1).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover)).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => { const p = panelNode(); if (p?.id) run("layout.toggle", { id: p.id }); })
      .child("PRs")
      .child(h_flex().h(18).min_w(18).px(6).flex_none().justify_center().items_center().rounded(9)
        .bg(n > 0 ? t.accent : t.raised).text_size(size - 2).font_semibold()
        .text_color(n > 0 ? t.accent_foreground : t.muted).child(String(n))));
}

export default class PrPanel extends View {
  init(_props, cx) {
    this.role = blockProps()?.role ?? "panel";
    if (this.role === "peek") { this.peek = new Peek(cx); return; }
    if (this.role === "confirm") { this.confirm = new Confirm(cx); return; }
    if (this.role !== "panel") return;

    this.handle = cx.focus_handle();
    this.config = parseConfig(null).config;
    this.configError = null;
    this.view = null; // last good view
    this.prs = []; // last good PR list
    this.selectedId = null;
    this.selectedIndex = 0;
    this.lastSelect = shared(SELECT) ?? null; // only a change selects, not what an old toast left behind
    this.stale = false;
    this.messages = [];
    this.truncated = false;
    this.checkedAt = null;
    this.loading = true;
    this.inFlight = false;
    this.loggedIn = null;
    this.authError = null;
    this.authAt = 0;
    this.state = { initialized: false, seen: [], queue: {} };
    this.unsaved = false; // the last save failed: memory is ahead of the file
    // Queue entries this panel removed (dropped, merged, cancelled): id -> true. A reload or a
    // retried save never brings them back from the file. Kept until a save lands without them.
    this.removed = new Map();
    // Every read and write of the state file runs one at a time, in order (see locked()).
    this.stateChain = Promise.resolve();
    this.stateText = null; // the file's text as last read or written: writeTextFile's `expected`
    this.interval = null;
    this.timer = null;
    this.note = null; // a one-off line from the last key (why m can't merge yet)
    this.merging = new Map(); // PR id -> "repo#n": merges running now; never two for one PR
    this.justMerged = new Map(); // PR id -> when we merged it (search keeps listing it for a while)
    this.confirming = null; // {pr, options}: the PR the open confirm was opened for, as it was shown
    // Shared values persist. A request or ask left over from before is never acted on: clear it.
    this.lastRequestKey = null;
    this.lastAskKey = null;
    if (shared(MERGE_REQUEST)) setShared(MERGE_REQUEST, null);
    if (shared(MERGE_ASK)) setShared(MERGE_ASK, null);

    cx.spawn(async (cx) => {
      await this.loadConfig();
      this.schedule(cx);
      await this.refresh(cx);
    });
    // Work that render() finds (a merge request, the peek's `m`) runs here: a task spawned from
    // render's cx doesn't outlive the frame, so render queues a job and wakes this loop.
    this.jobs = [];
    this.wake = null;
    cx.spawn(async (cx) => {
      for (;;) {
        if (this.jobs.length === 0) await new Promise((resolve) => { this.wake = resolve; });
        this.wake = null;
        const job = this.jobs.shift();
        if (!job) continue;
        try { await job(cx); } catch (e) { console.log(`pr-panel: ${e?.stack ?? e}`); }
        cx.notify();
      }
    });
    cx.spawn(async (cx) => {
      for (;;) {
        if ((await nextCommand()) === "focus") this.handle.focus();
        cx.notify();
      }
    });
  }

  // ---- Data ----

  async loadConfig() {
    let text = null;
    try { text = await readTextFile(configPath()); } catch { text = null; }
    const { config, error } = parseConfig(text);
    this.config = config;
    this.configError = error;
  }

  /**
   * Runs `fn` after every earlier state read/write has finished. Refresh (load, seen, dequeue)
   * and the job loop (enqueue, onMerged) both write the file; this keeps their writes from
   * overlapping, so no write goes out against an `expected` text another write just replaced.
   * Never call locked() from inside a locked fn (it would wait on itself).
   */
  locked(fn) {
    const run = this.stateChain.then(fn, fn);
    this.stateChain = run.catch(() => {});
    return run;
  }

  loadState() {
    return this.locked(async () => {
      try { this.stateText = await readTextFile(statePath()); } catch { this.stateText = null; }
      const file = parseState(this.stateText);
      // A save that failed left the file behind memory: never let a reload forget seen ids.
      // Tombstoned queue entries never come back from the file either way.
      this.state = this.unsaved
        ? mergeState(file, this.state, this.removed)
        : { ...file, queue: withoutRemoved(file.queue, this.removed) };
    });
  }

  /** Changes the state with `change(state) -> state` and saves, as one step under the lock. */
  updateState(change) {
    return this.locked(async () => {
      this.state = change(this.state);
      await this.writeState();
    });
  }

  /** Writes the state file if it changed. A stale snapshot is re-read once and retried. Lock held. */
  async writeState() {
    const text = `${JSON.stringify(this.state, null, 2)}\n`;
    if (text === this.stateText) { this.settleRemoved(); return; }
    try {
      await writeTextFile(statePath(), text, this.stateText);
      this.stateText = text;
      this.unsaved = false;
      this.settleRemoved();
    } catch {
      try {
        this.stateText = await readTextFile(statePath());
        this.state = mergeState(parseState(this.stateText), this.state, this.removed);
        const merged = `${JSON.stringify(this.state, null, 2)}\n`;
        await writeTextFile(statePath(), merged, this.stateText);
        this.stateText = merged;
        this.unsaved = false;
        this.settleRemoved();
      } catch (e) {
        this.unsaved = true;
        console.log(`pr-panel: could not save ${statePath()}: ${e?.message ?? e}`);
      }
    }
  }

  /** The file now matches memory: tombstones for ids not in it have done their job. */
  settleRemoved() {
    for (const id of [...this.removed.keys()]) if (!this.state.queue?.[id]) this.removed.delete(id);
  }

  /** (Re)starts the poll timer when refresh_seconds changes. */
  schedule(cx) {
    const ms = this.config.refreshSeconds * 1000;
    if (this.timer && this.interval === ms) return;
    if (this.timer) this.timer.cancel();
    this.interval = ms;
    this.timer = cx.timer.every(ms, (cx) => { this.refresh(cx); });
  }

  /** gh's logged-in accounts are asked at start and every 10 minutes; the config applies every time. */
  async loadAccounts() {
    if (!this.loggedIn || Date.now() - this.authAt >= AUTH_EVERY_MS) {
      this.authAt = Date.now();
      this.authError = null;
      try {
        const r = await exec("gh", AUTH_STATUS_ARGS);
        let json = null;
        try { json = JSON.parse(r.stdout); } catch { json = null; }
        this.loggedIn = parseAuthStatus(json);
        this.authError = authFailure(json, r);
      } catch (e) {
        // exec rejects only when gh couldn't be started at all: treat it as "not installed".
        this.loggedIn = [];
        this.authError = { code: 127, stderr: String(e?.message ?? e), message: "" };
      }
    }
    const accounts = resolveAccounts(this.config, this.loggedIn);
    if (accounts.length === 0) {
      const e = this.authError ?? { code: 1, stderr: "not logged in: run gh auth login", message: "" };
      this.loggedIn = null; // ask again next time
      throw e;
    }
    return accounts;
  }

  async refresh(cx) {
    if (this.inFlight) return; // never two at once; this tick is skipped
    this.inFlight = true;
    try {
      await this.loadConfig();
      this.schedule(cx);
      await this.loadState(); // the file is the truth: hand edits and other writers count
      await this.fetchAndApply(cx);
    } catch (e) {
      if (e instanceof Error && !/ENOENT|spawn/i.test(e.message)) console.log(`pr-panel: refresh failed: ${e.stack ?? e.message}`);
      this.stale = true;
      this.messages = [clip(ghError(e))];
    } finally {
      this.inFlight = false;
      this.loading = false;
      cx.notify();
    }
  }

  async fetchAndApply(cx) {
    const config = this.config;
    const accounts = await this.loadAccounts();
    const responses = [];
    const failed = []; // {account, text}
    let ok = 0;
    for (const account of accounts) {
      let accountFailed = null;
      for (const q of searchQueries(account.scope ?? config.scope)) {
        try {
          const json = await ghJson(account, ["api", "graphql", "-f", `query=${SEARCH_GQL}`, "-f", `q=${q}`]);
          responses.push({ account: { login: account.login, host: account.host }, scope: account.scope, json });
          ok++;
        } catch (e) {
          accountFailed = e;
        }
      }
      if (accountFailed) failed.push({ account, text: clip(ghError(accountFailed, account)) });
    }
    if (ok === 0 && failed.length > 0) {
      // Nothing came back: keep the last good list, and leave the seen list alone.
      this.stale = true;
      this.messages = this.errorLines(failed, accounts);
      return;
    }

    let { prs, truncated } = parseSearch(responses, config);
    const now = Date.now();
    for (const [id, at] of this.justMerged) if (now - at > MERGED_HIDE_MS) this.justMerged.delete(id);
    if (this.justMerged.size) prs = prs.filter((p) => !this.justMerged.has(p.id));
    const allAnswered = failed.length === 0;
    // A list cut at 100 results isn't the whole truth either: a PR missing from it may be open.
    const complete = allAnswered && !truncated;
    if (!allAnswered) {
      // A failing account's PRs stay as they were last seen, rather than vanishing.
      const have = new Set(prs.map((p) => p.id));
      const down = new Set(failed.map((f) => f.account.login));
      prs = prs.concat(this.prs.filter((p) => down.has(p.account?.login) && !have.has(p.id)));
    }

    this.prs = prs;
    this.truncated = truncated;
    this.stale = !allAnswered;
    this.messages = this.errorLines(failed, accounts);
    this.checkedAt = Date.now();
    this.rebuild();

    let fresh = [];
    await this.updateState((cur) => {
      const r = updateSeen(cur, prs, config, { complete });
      fresh = r.fresh;
      return { ...cur, initialized: r.state.initialized, seen: r.state.seen };
    });
    this.toast(fresh);
    // Queued merges only move when every query answered: a PR missing because a query failed
    // isn't gone. On a list cut at 100, a missing PR waits (processQueue is told).
    if (allAnswered) await this.processQueue(cx, truncated);
  }

  /**
   * "Merge when green": each refresh decides every queued entry against the PR as it is now.
   * It is the panel's own queue (never GitHub auto-merge), so it only moves while Herdr is open.
   * The file is saved after every change.
   */
  async processQueue(cx, truncated = false) {
    const queue = this.state.queue ?? {};
    for (const [id, entry] of Object.entries(queue)) {
      if (!entry || typeof entry !== "object") { await this.dequeue(id); continue; }
      if (this.merging.has(id)) continue;
      const pr = this.prs.find((p) => p.id === id) ?? null;
      const decision = queueDecision(entry, pr, { truncated });
      const name = `${entry.repo}#${entry.number}`;
      if (decision === "wait") continue;
      if (decision === "merge") {
        // Hand-off PRs never merge from the panel, even if the rule arrived after queueing.
        let rule = null;
        try { rule = chooseMethod(pr, this.config).handOff; } catch { rule = null; }
        if (rule) {
          await this.dequeue(id);
          notify({ title: `${rule.label}: ${name} isn't merged here`, level: "warning" });
          continue;
        }
        // As the account that queued it, at the head commit that was confirmed.
        const account = entry.account?.login ? entry.account : pr.account;
        await this.dequeue(id);
        await this.runMerge({ ...pr, account, headOid: entry.headOid }, entry.method, { deleteBranch: entry.deleteBranch === true }, cx);
        continue;
      }
      await this.dequeue(id);
      const title = {
        "drop:failed": `Checks failed on ${name}: merge cancelled`,
        "drop:moved": `New commits on ${name}: merge cancelled`,
        "drop:retargeted": `Base changed on ${name}: merge cancelled`,
        "drop:draft": `Converted to draft: ${name}: merge cancelled`,
        "drop:conflicts": `Conflicts on ${name}: merge cancelled`,
      }[decision];
      if (title) notify({ title, level: "warning" });
    }
  }

  /** Removes a queue entry and tombstones it, so no reload or retried save brings it back. */
  dequeue(id) {
    this.removed.set(id, true);
    return this.updateState((cur) => {
      if (!cur.queue?.[id]) return cur;
      const { [id]: _gone, ...queue } = cur.queue;
      return { ...cur, queue };
    });
  }

  /** A new decision by the person: it lifts any tombstone for this PR. */
  enqueue(pr, method, deleteBranch) {
    this.removed.delete(pr.id);
    return this.updateState((cur) => ({ ...cur, queue: { ...(cur.queue ?? {}), [pr.id]: queueEntry(pr, method, deleteBranch) } }));
  }

  /**
   * Runs one merge as the PR's own account, pinned to pr.headOid. Every merge in the panel goes
   * through here, so one PR never merges twice at once. `deleteBranch` is what the confirm showed;
   * the safety rules (default branch, keep-history) are applied again here and can only turn it off.
   */
  async runMerge(pr, method, { deleteBranch }, cx) {
    if (this.merging.has(pr.id)) return;
    const name = `${pr.repo}#${pr.number}`;
    let args;
    try {
      if (!pr.headOid) throw new Error("no head commit to pin");
      args = mergeArgs(pr, method, { deleteBranch: deleteBranch === true && deleteBranchFor(this.config, pr) });
    } catch (e) {
      notify({ title: `Couldn't merge ${name}`, body: String(e?.message ?? e), level: "error" });
      return;
    }
    this.merging.set(pr.id, name);
    if (cx) cx.notify();
    let r;
    try {
      const c = ghCommand(pr.account, args);
      r = await exec(c.cmd, c.args);
    } catch (e) {
      r = { code: 1, stdout: "", stderr: String(e?.message ?? e) };
    } finally {
      this.merging.delete(pr.id);
    }
    if (r.code === 0) {
      notify({ title: `Merged ${name}`, body: pr.title, level: "success" });
      this.onMerged(pr, method, pr.headOid, cx);
    } else {
      const text = ghError({ code: r.code, stderr: r.stderr || r.stdout, message: "" }, pr.account).replace(/: showing last list$/, "");
      notify({ title: `Couldn't merge ${name}`, body: clip(text), level: "error" });
      if (cx) cx.notify();
    }
  }

  errorLines(failed, accounts) {
    const texts = [...new Set(failed.map((f) => f.text))];
    if (texts.length === 1 && (failed.length === accounts.length || accounts.length === 1)) return texts;
    return failed.map((f) => (f.text.includes(f.account.login) ? f.text : clip(`${f.account.login}: ${f.text}`)));
  }

  rebuild() {
    this.view = buildView(this.prs, this.config, Date.now());
    if (shared(COUNT) !== this.view.count) setShared(COUNT, this.view.count);
    const rows = rowOrder(this.view);
    if (this.selectedId && !rows.some((r) => r.pr.id === this.selectedId)) {
      // The selected PR went away: keep the cursor where it was.
      this.selectedId = rows.length ? rows[Math.min(this.selectedIndex, rows.length - 1)].pr.id : null;
    }
    this.selectedIndex = Math.max(0, rows.findIndex((r) => r.pr.id === this.selectedId));
  }

  toast(fresh) {
    if (fresh.length === 0) return;
    const node = panelNode();
    const owners = new Set(this.prs.map((p) => p.repo.split("/")[0]));
    const bots = new Map(rowOrder(this.view).map((r) => [r.pr.id, r.bot]));
    for (const pr of fresh) {
      const repo = owners.size > 1 ? pr.repo : pr.repo.split("/").slice(1).join("/");
      const n = { title: `${bots.get(pr.id) ? "🤖 " : ""}New PR · ${repo}#${pr.number}`, body: pr.title, level: "info" };
      if (node?.id) n.action = { name: "layout.show", args: { id: node.id } };
      setShared(SELECT, pr.id);
      notify(n);
    }
  }

  /**
   * The one hook the merge flow (Tasks 7 and 8) calls after `gh pr merge` succeeds.
   * Drops the row (and any queue entry) at once, then saves and refreshes. Pass the caller's
   * cx so the panel redraws now.
   */
  onMerged(pr, method, oid, cx) {
    this.justMerged.set(pr.id, Date.now());
    this.prs = this.prs.filter((p) => p.id !== pr.id);
    this.rebuild();
    if (cx) cx.notify();
    // Drop any queue entry (tombstoned, saved under the lock), then refresh, on the panel's own
    // task (see later()); a refresh already in flight just skips.
    const drop = this.dequeue(pr.id);
    if (this.jobs) this.later(async (cx) => { await drop; await this.refresh(cx); });
  }

  // ---- Keys and actions ----

  selected() {
    return rowOrder(this.view).find((r) => r.pr.id === this.selectedId) ?? null;
  }

  move(delta) {
    const rows = rowOrder(this.view);
    if (rows.length === 0) return;
    const at = rows.findIndex((r) => r.pr.id === this.selectedId);
    const next = at < 0 ? (delta > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, at + delta));
    this.selectedId = rows[next].pr.id;
    this.selectedIndex = next;
  }

  /** Opens an http(s) link in the browser. Anything else is ignored (see isWebUrl). */
  open(url, cx) {
    openWebUrl(url, cx);
  }

  openSelected(cx) {
    const item = this.selected();
    if (!item) return;
    if (item.kind === "handoff") {
      this.open(classify(item.pr, this.config).rule?.url || item.pr.url, cx);
    } else this.open(item.pr.url, cx);
  }

  /** Opens the peek dialog for the selected PR. The PR goes over as plain JSON. */
  peekSelected() {
    const item = this.selected();
    if (!item) return;
    const pr = JSON.parse(JSON.stringify(item.pr));
    openOverlay({ mod: MOD, kind: "dialog", width: 0.9, height: 0.9, props: { role: "peek", pr } });
  }

  /** Focus the agent working on this PR's branch, else the repo's space, else nothing. */
  goToAgent() {
    const item = this.selected();
    if (!item) return;
    const pr = item.pr;
    const pane = panes().find((p) => p.terminal && p.branch === pr.head);
    if (pane) return run("pane.focus", { terminal: pane.terminal });
    const name = pr.repo.split("/").pop();
    const space = spaces().find((s) => (s.folder || "").replace(/\/+$/, "").split("/").pop() === name);
    if (space) run("space.select", { id: space.id });
  }

  /** `m`: hand-offs open their URL; blocked PRs say why; anything else opens the confirm. */
  mergeItem(item, cx) {
    const pr = item.pr;
    let choice;
    try { choice = chooseMethod(pr, this.config); } catch (e) { this.note = String(e?.message ?? e); return; }
    if (choice.handOff) { this.open(choice.handOff.url || pr.url, cx); return; }
    if (this.merging.has(pr.id)) return; // its "Merging …" line is already showing
    const blocker = mergeBlocker(pr);
    if (blocker === "draft") { this.note = "Draft: mark it ready on GitHub first"; return; }
    if (blocker === "conflicts") { this.note = "Conflicts: press g to go to the agent"; return; }
    if (blocker === "checking") { this.note = "GitHub is still checking this PR; try again in a moment"; return; }
    if (choice.options.length === 0) { this.note = choice.reason; return; }
    const snap = JSON.parse(JSON.stringify(pr));
    const deleteBranch = deleteBranchFor(this.config, pr);
    this.confirming = { pr: snap, options: choice.options, deleteBranch };
    const shown = { ...choice, deletes: deleteBranch ? pr.head : null };
    openOverlay({ mod: MOD, kind: "dialog", modal: true, width: 560, height: 150, props: { role: "confirm", pr: snap, choice: shown } });
  }

  /** Runs `job(cx)` on the panel's own task, after this frame. */
  later(job) {
    this.jobs.push(job);
    if (this.wake) this.wake();
  }

  /** The confirm decided. Only a fresh request for the PR it was opened for, at the head it showed, runs. */
  takeRequest(req) {
    const m = acceptRequest(req, this.confirming, Date.now());
    this.confirming = null;
    if (!m) { this.note = "Merge not started: confirm again"; return; }
    if (m.when === "now") this.later((cx) => this.runMerge(m.pr, m.method, { deleteBranch: m.deleteBranch }, cx));
    else {
      // Always the panel's own queue, never `gh pr merge --auto`: it pins the head commit and
      // drops the merge if anything changes, so nothing merges that the person didn't see.
      this.later(async (cx) => {
        await this.enqueue(m.pr, m.method, m.deleteBranch);
        this.note = `Queued: ${m.pr.repo}#${m.pr.number} merges when the checks pass`;
        cx.notify();
      });
    }
  }

  onKey(e, cx) {
    const k = e.key;
    if (e.modifiers?.platform || e.modifiers?.control || e.modifiers?.alt) return;
    this.note = null;
    if (k === "up") this.move(-1);
    else if (k === "down") this.move(1);
    else if (k === "o") this.openSelected(cx);
    else if (k === "g") this.goToAgent();
    else if (k === "r") cx.spawn(async (cx) => this.refresh(cx));
    else if (k === "enter") this.peekSelected();
    else if (k === "m") { const item = this.selected(); if (item) this.mergeItem(item, cx); }
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  /** The peek's overlay went: free its scroll handle. */
  async close(_cx) {
    if (this.peek) this.peek.dispose();
  }

  // ---- Drawing ----

  render(cx) {
    if (this.role === "toggle") return toggle();
    if (this.role === "peek") return this.peek.render(cx);
    if (this.role === "confirm") return this.confirm.render(cx);
    if (this.role !== "panel") return div();
    const t = theme();

    const want = shared(SELECT) ?? null;
    if (want !== this.lastSelect) {
      this.lastSelect = want;
      if (want) {
        this.selectedId = want;
        this.selectedIndex = Math.max(0, rowOrder(this.view).findIndex((r) => r.pr.id === want));
      }
    }

    // The confirm's decision, and the peek's `m`, arrive as shared values (overlays can't call in).
    const req = shared(MERGE_REQUEST) ?? null;
    const reqKey = req ? JSON.stringify(req) : null;
    if (reqKey !== this.lastRequestKey) {
      this.lastRequestKey = reqKey;
      if (req) { setShared(MERGE_REQUEST, null); this.takeRequest(req); }
    }
    const ask = shared(MERGE_ASK) ?? null;
    const askKey = ask ? JSON.stringify(ask) : null;
    if (askKey !== this.lastAskKey) {
      this.lastAskKey = askKey;
      if (ask) {
        setShared(MERGE_ASK, null);
        const item = rowOrder(this.view).find((r) => r.pr.id === ask.prId);
        const verdict = acceptAsk(ask, item?.pr ?? null, Date.now());
        if (verdict) {
          this.selectedId = item.pr.id;
          this.selectedIndex = Math.max(0, rowOrder(this.view).findIndex((r) => r.pr.id === item.pr.id));
          // The peek showed an older head than the panel has now: what was read isn't what would merge.
          if (verdict === "moved") this.note = "New commits since you peeked: peek again";
          else {
            this.note = null;
            // Out of render: opening an overlay mid-draw isn't the place.
            this.later(async (cx) => { this.mergeItem(item, cx); });
          }
        }
      }
    }

    const lines = [...this.messages];
    for (const name of this.merging.values()) lines.push(`Merging ${name}…`);
    if (this.note) lines.push(this.note);
    const ui = {
      selectedId: this.selectedId,
      stale: this.stale,
      message: lines,
      checkedAgo: this.checkedAt ? ago(this.checkedAt) : null,
      truncated: this.truncated,
      configError: this.configError,
      queued: new Set(Object.keys(this.state.queue ?? {})),
      config: this.config,
      loading: this.loading,
      size: fontSize(),
      // Click selects; a click on the row that's already selected opens the peek.
      onSelect: (id, cx) => { if (id === this.selectedId) { this.peekSelected(); return; } this.selectedId = id; this.selectedIndex = Math.max(0, rowOrder(this.view).findIndex((r) => r.pr.id === id)); this.handle.focus(); cx.notify(); },
      onOpen: (url, cx) => this.open(url, cx),
    };
    return v_flex().id("pr-panel").size_full().min_h(0).track_focus(this.handle)
      .on_mouse_down("left", () => this.handle.focus())
      .on_key_down((e, cx) => this.onKey(e, cx))
      .child(renderPanel(this.view, ui, t));
  }
}

function ago(ms) {
  const a = formatAge(new Date(ms).toISOString(), Date.now());
  return a === "now" ? "just now" : `${a} ago`;
}
