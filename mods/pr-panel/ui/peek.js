// The peek dialog: one PR's description, changed files and full diff, over the window.
// Opened by the panel with openOverlay({mod:"pr-panel", kind:"dialog", props:{role:"peek", pr}});
// main.js hands this role to `Peek`. Read-only: it runs `gh pr view` and `gh pr diff` as the
// PR's own account and never writes anything.
import { div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, TextView, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { exec, theme, settings, props, closeOverlay, readTextFile, appHome, setShared } from "herdr";
import { parseConfig } from "../config.js";
import { ghCommand, viewArgs, diffArgs, ghError } from "../github.js";
import { ticketKeys, ticketUrl, isBot } from "../model.js";
import { chooseMethod } from "../merge.js";
import { diffRows } from "../diff.js";
import { openWebUrl } from "./open.js";

/** The peek's `m`: asks the panel to open the merge confirm for this PR ({prId, headOid, at}). */
export const MERGE_ASK = "pr-panel.mergeAsk";

const ROW = 20; // diff row height, px
const STEP = 3; // rows per arrow / j / k
const MAX_TEXT = 2000; // characters drawn per diff line; the rest is cut
const MAX_LINE = 120;
const EXEC_LIMIT = 8 * 1024 * 1024; // exec's output cap: at it, the diff was cut short
const CHECK = { passed: ["✓", "checks passed"], running: ["●", "checks running"], failed: ["✗", "checks failed"], none: ["", ""] };
const MARK = { add: "+", del: "-", ctx: " " };

const clip = (s) => (s.length > MAX_LINE ? `${s.slice(0, MAX_LINE - 1)}…` : s);
const stop = (_e, cx) => cx.stop_propagation();
const fontSize = () => Number(settings()?.ui_font_size) || 13;

/** ghError's line without the panel's "showing last list" (the peek has no list). */
const peekError = (err, account) => clip(ghError(err, account).replace(/: showing last list$/, ""));

/** Runs gh as the PR's account. Resolves to stdout, or throws a one-line reason. */
async function gh(account, args) {
  const c = ghCommand(account, args);
  let r;
  try { r = await exec(c.cmd, c.args); }
  catch (e) {
    const m = String(e?.message ?? e);
    if (/time(d)? ?out|30 ?s/i.test(m)) throw new Error("GitHub took over 30 s: press o to open it there");
    throw new Error(peekError({ code: 1, stderr: m, message: m }, account));
  }
  if (r.code !== 0) throw new Error(peekError({ code: r.code, stderr: r.stderr || r.stdout, message: "" }, account));
  return r.stdout;
}

export class Peek {
  constructor(cx) {
    this.pr = props()?.pr ?? null;
    // An overlay doesn't take the keyboard on open, and this handle has no element yet: ask now,
    // again on the first layout (the element exists then), and once more later, as help/picker do.
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.focusedOnce = false;
    cx.timer.after(600, () => { if (!this.handle.is_focused()) this.handle.focus(); });
    this.scroll = VirtualListScrollHandle.new();
    this.top = 0; // first diff row on screen, as far as the keys know
    this.page = 20; // diff rows that fit, from on_size_change
    this.width = 0;
    this.height = 0;
    this.config = parseConfig(null).config;
    this.info = null; // {body, files}
    this.infoError = null;
    this.rows = null; // diffRows, capped per line
    this.diffError = null;
    this.diffNote = null;
    this.diffWidth = 300;
    if (!this.pr) return;
    cx.spawn(async (cx) => {
      try { this.config = parseConfig(await readTextFile(`${appHome()}/pr-panel.json`)).config; } catch { /* defaults */ }
      cx.notify();
    });
    cx.spawn(async (cx) => {
      try {
        const json = JSON.parse(await gh(this.pr.account, viewArgs(this.pr)));
        this.info = { body: String(json?.body ?? ""), files: Array.isArray(json?.files) ? json.files : [] };
      } catch (e) { this.infoError = e instanceof SyntaxError ? "gh returned something that isn't JSON" : e.message; }
      cx.notify();
    });
    cx.spawn(async (cx) => {
      try {
        const text = await gh(this.pr.account, diffArgs(this.pr));
        if (text.length >= EXEC_LIMIT - 1024) this.diffNote = "Diff over 8 MiB: showing the start. Press o for the rest on GitHub.";
        const rows = diffRows(text);
        let longest = 0;
        for (const r of rows) {
          if (r.text.length > MAX_TEXT) r.text = `${r.text.slice(0, MAX_TEXT)}… (line cut)`;
          if (r.text.length > longest) longest = r.text.length;
        }
        this.rows = rows;
        this.diffWidth = Math.max(300, longest * 7.5 + 60);
      } catch (e) { this.diffError = e.message; this.rows = []; }
      cx.notify();
    });
  }

  close() {
    closeOverlay(props()?.overlay);
  }

  dispose() {
    try { this.scroll.release(); } catch { /* already released */ }
  }

  /** `m`: close the peek and have the panel run its `m` for this PR (same checks, same confirm). */
  requestMerge() {
    // The head commit this peek showed: the panel refuses if the PR has moved on since.
    if (this.pr?.id) setShared(MERGE_ASK, { prId: this.pr.id, headOid: this.pr.headOid, at: Date.now() });
    this.close();
  }

  /**
   * Puts diff row `top` at the top. scroll_to_item only brings a row to the *nearest* edge, so
   * going down it targets the row that should end up last on screen. `this.top` is what the keys
   * last asked for; a mouse-wheel scroll in between isn't seen, so the next key starts from there.
   */
  scrollTo(top) {
    const n = this.rows?.length ?? 0;
    if (n === 0) return;
    const next = Math.max(0, Math.min(top, Math.max(0, n - this.page)));
    const down = next > this.top;
    this.top = next;
    this.scroll.scroll_to_item(down ? Math.min(n - 1, next + this.page - 1) : next, "top");
  }

  jumpToFile(path) {
    const at = (this.rows ?? []).findIndex((r) => r.kind === "file" && r.text === path);
    if (at >= 0) this.scrollTo(at);
  }

  onKey(e, cx) {
    const k = e.key;
    if (e.modifiers?.platform || e.modifiers?.control || e.modifiers?.alt) return;
    if (k === "escape") this.close();
    else if (k === "down" || k === "j") this.scrollTo(this.top + STEP);
    else if (k === "up" || k === "k") this.scrollTo(this.top - STEP);
    else if (k === "space") this.scrollTo(this.top + (e.modifiers?.shift ? -1 : 1) * Math.max(1, this.page - 2));
    else if (k === "pagedown") this.scrollTo(this.top + Math.max(1, this.page - 2));
    else if (k === "pageup") this.scrollTo(this.top - Math.max(1, this.page - 2));
    else if (k === "home") this.scrollTo(0);
    else if (k === "end") this.scrollTo(Infinity);
    else if (k === "o") openWebUrl(this.pr?.url, cx);
    else if (k === "m") this.requestMerge();
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  // ---- Drawing ----

  header(t, size) {
    const pr = this.pr;
    const keys = ticketKeys(pr, this.config.tickets);
    let method = "";
    try { method = chooseMethod(pr, this.config).reason ?? ""; } catch { method = ""; }
    const [icon, word] = CHECK[pr.checks] ?? CHECK.none;
    const checkColor = pr.checks === "passed" ? t.ansi2 : pr.checks === "failed" ? t.ansi1 : t.ansi3;
    const meta = h_flex().flex_wrap().gap_x(14).gap_y(2).items_center().text_size(size - 1).text_color(t.muted)
      .child(div().flex_none().child(`${pr.repo}#${pr.number}`))
      .child(div().flex_none().child(`${pr.head} → ${pr.base}`))
      .when(icon !== "", (el) => el.child(div().flex_none().text_color(checkColor).child(`${icon} ${word}`)))
      .child(h_flex().flex_none().gap(6)
        .child(div().text_color(t.ansi2).child(`+${pr.additions ?? 0}`))
        .child(div().text_color(t.ansi1).child(`−${pr.deletions ?? 0}`)))
      .children(keys.map((key) => {
        const url = ticketUrl(key, this.config.tickets);
        return div().id(`peek-ticket-${key}`).flex_none().text_color(url ? t.accent : t.muted)
          .when(Boolean(url), (el) => el.cursor_pointer().hover((s) => s.underline()).on_mouse_down("left", stop)
            .on_click((_e, cx) => openWebUrl(url, cx)))
          .child(key);
      }))
      .when(method !== "", (el) => el.child(div().flex_none().text_color(t.dim).child(method)));
    return v_flex().flex_none().px(18).pt(14).pb(10).gap(6).border_b(1).border_color(t.border)
      .child(h_flex().gap(8).items_center()
        .when(isBot(pr, this.config), (el) => el.child(div().flex_none().text_size(size + 3).child("🤖")))
        .child(div().flex_1().min_w(0).truncate().text_size(size + 3).font_semibold().text_color(t.foreground).child(pr.title))
        .when(pr.isDraft, (el) => el.child(div().flex_none().px(5).rounded(4).bg(t.raised).text_size(size - 2).text_color(t.muted).child("draft"))))
      .child(meta);
  }

  description(t, size) {
    const body = this.infoError ? null : this.info ? (this.info.body.trim() || "_No description._") : null;
    return div().id("peek-desc").flex_1().min_h(0).overflow_y_scrollbar().child(v_flex().px(18).py(12)
      .child(body !== null
        ? TextView.markdown("peek-body", body).selectable(true).text_size(size).text_color(t.foreground)
          .on_link_click((url, cx) => openWebUrl(url, cx))
        : div().text_color(this.infoError ? t.ansi1 : t.dim).child(this.infoError ?? "Loading…")));
  }

  files(t, size) {
    const files = this.info?.files ?? [];
    const label = this.info ? `Files · ${files.length}` : "Files";
    const list = div().id("peek-files").flex_1().min_h(0).overflow_y_scrollbar().child(v_flex().px(10).pb(8)
      .children(files.map((f) => {
        const path = String(f.path ?? "");
        const parts = path.split("/");
        const name = parts.pop();
        return h_flex().id(`peek-file-${path}`).h(size + 11).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer()
          .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.jumpToFile(path); this.handle.focus(); cx.notify(); })
          .child(h_flex().flex_1().min_w(0).text_size(size - 1)
            .child(div().min_w(0).truncate().text_color(t.dim).child(parts.length ? `${parts.join("/")}/` : ""))
            .child(div().flex_none().max_w(260).truncate().text_color(t.foreground).child(name)))
          .when(Number(f.additions) > 0, (el) => el.child(div().flex_none().text_size(size - 2).text_color(t.ansi2).child(`+${f.additions}`)))
          .when(Number(f.deletions) > 0, (el) => el.child(div().flex_none().text_size(size - 2).text_color(t.ansi1).child(`−${f.deletions}`)));
      }))
      .when(!this.info && !this.infoError, (el) => el.child(div().px(8).text_size(size - 1).text_color(t.dim).child("Loading…"))));
    // As tall as its rows, up to 45% of the dialog; the description takes the rest.
    const want = 34 + Math.max(1, files.length) * (size + 11) + 8;
    const h = Math.round(Math.min(want, Math.max(120, (this.height || 800) * 0.45)));
    return v_flex().flex_none().h(h).min_h(0).border_t(1).border_color(t.border)
      .child(div().flex_none().px(18).pt(10).pb(4).text_size(size - 1.5).font_semibold().text_color(t.muted).child(label))
      .child(list);
  }

  diffRow(row, t) {
    if (row.kind === "file") {
      return div().w_full().h(ROW).flex_none().px(12).flex().items_center().bg(t.raised).font_semibold().text_color(t.foreground).truncate().child(row.text);
    }
    if (row.kind === "hunk") {
      return div().w_full().h(ROW).flex_none().px(12).flex().items_center().text_color(t.ansi4).truncate().child(row.text);
    }
    const color = row.kind === "add" ? t.ansi2 : row.kind === "del" ? t.ansi1 : t.foreground;
    return h_flex().w_full().h(ROW).flex_none().text_color(color)
      .child(div().w(24).flex_none().text_right().pr(8).text_color(row.kind === "ctx" ? t.dim : color).child(MARK[row.kind] ?? " "))
      .child(div().flex_1().min_w(0).truncate().child(row.text || " "));
  }

  diff(t, size) {
    const rows = this.rows;
    let inner;
    if (rows === null) inner = div().p(14).text_color(t.dim).child("Loading…");
    else if (this.diffError) inner = div().p(14).text_color(t.ansi1).child(this.diffError);
    else if (rows.length === 0) inner = div().p(14).text_color(t.dim).child("No changes in this diff.");
    else {
      inner = div().id("peek-diff-x").size_full().overflow_x_scrollbar()
        .child(div().w_full().min_w(this.diffWidth).h_full()
          .child(v_virtual_list("peek-diff", rows.length, ROW, (i) => String(i),
            (range) => rows.slice(range.start, range.end).map((row) => this.diffRow(row, t)))
            .track_scroll(this.scroll).size_full()));
    }
    return v_flex().flex_1().min_w(0).min_h(0)
      .when(Boolean(this.diffNote), (el) => el.child(div().flex_none().px(14).py(4).text_size(size - 1).text_color(t.ansi3).border_b(1).border_color(t.border).child(this.diffNote)))
      .child(div().id("peek-diff-area").flex_1().min_h(0).relative().font_family(settings()?.font_family ?? "JetBrains Mono").text_size(size - 1)
        .on_size_change((s, cx) => {
          const page = Math.max(1, Math.floor(s.height / ROW));
          if (page !== this.page) { this.page = page; cx.notify(); }
        })
        .child(inner)
        .when(Boolean(rows && rows.length && !this.diffError), (el) => el.child(Scrollbar.vertical("peek-diff").viewport_from_layout().absolute().inset_0())));
  }

  render(_cx) {
    const t = theme();
    const size = fontSize();
    const root = v_flex().id("pr-peek").size_full().min_h(0).bg(t.popover ?? t.surface).text_size(size).text_color(t.foreground)
      .track_focus(this.handle).on_mouse_down("left", () => this.handle.focus())
      .on_key_down((e, cx) => this.onKey(e, cx))
      .on_size_change((s, cx) => {
        if (!this.focusedOnce) { this.focusedOnce = true; this.handle.focus(); }
        if (s.width !== this.width || s.height !== this.height) { this.width = s.width; this.height = s.height; cx.notify(); }
      });
    if (!this.pr) return root.child(div().p(18).text_color(t.dim).child("No PR to show."));
    const side = Math.round(Math.max(260, Math.min(560, (this.width || 1000) * 0.34)));
    const hints = div().flex_none().h(28).px(18).flex().items_center().border_t(1).border_color(t.border)
      .text_size(size - 2).text_color(t.dim).truncate()
      .child("↑↓ j k scroll · space page · m merge · o GitHub · Esc close");
    return root
      .child(this.header(t, size))
      .child(h_flex().flex_1().min_h(0).items_stretch() // h_flex centers by default: stretch the columns
        .child(v_flex().w(side).flex_none().min_h(0).border_r(1).border_color(t.border)
          .child(this.description(t, size))
          .child(this.files(t, size)))
        .child(this.diff(t, size)))
      .child(hints);
  }
}
