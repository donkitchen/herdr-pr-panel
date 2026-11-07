// The merge confirmation: one line naming the method, with the reason under it.
// Opened by the panel with openOverlay({mod:"pr-panel", kind:"dialog", modal:true,
// props:{role:"confirm", pr, choice}}); main.js hands this role to `Confirm`.
// It never runs gh. On y or w it hands the decision back to the panel through
// setShared("pr-panel.mergeRequest", ...) and closes, because an overlay's tasks end when it does.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, settings, props, closeOverlay, setShared } from "herdr";
import { confirmStart, confirmView, confirmKey } from "../merge.js";

export const MERGE_REQUEST = "pr-panel.mergeRequest";

const fontSize = () => Number(settings()?.ui_font_size) || 13;

export class Confirm {
  constructor(cx) {
    const p = props() ?? {};
    this.pr = p.pr ?? null;
    this.st = confirmStart(p.choice ?? {});
    this.done = false;
    // Same focus dance as the peek: an overlay doesn't take the keyboard on open.
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.focusedOnce = false;
    cx.timer.after(600, () => { if (!this.handle.is_focused()) this.handle.focus(); });
  }

  close() {
    closeOverlay(props()?.overlay);
  }

  onKey(e, cx) {
    const k = e.key;
    if (e.modifiers?.platform || e.modifiers?.control || e.modifiers?.alt) return;
    if (!this.pr) { if (k === "escape") this.close(); return; }
    if (this.done) return;
    const r = confirmKey(this.st, k, this.pr);
    if (r.st === this.st && !r.close && !r.request) return; // not ours
    this.st = r.st;
    if (r.request) {
      this.done = true; // one request per confirm, however fast the keys come
      setShared(MERGE_REQUEST, {
        prId: this.pr.id, method: r.request.method, when: r.request.when, headOid: this.pr.headOid, at: Date.now(),
      });
    }
    if (r.close) this.close();
    cx.stop_propagation();
    cx.notify();
  }

  render(_cx) {
    const t = theme();
    const size = fontSize();
    const root = v_flex().id("pr-confirm").size_full().min_h(0).px(18).py(14).gap(6)
      .bg(t.popover ?? t.surface).text_size(size).text_color(t.foreground)
      .track_focus(this.handle).on_mouse_down("left", () => this.handle.focus())
      .on_key_down((e, cx) => this.onKey(e, cx))
      .on_size_change(() => { if (!this.focusedOnce) { this.focusedOnce = true; this.handle.focus(); } });
    if (!this.pr) return root.child(div().text_color(t.dim).child("No PR to merge."));
    const v = confirmView(this.pr, this.st);
    const lineColor = v.failed ? t.ansi1 : this.st.method === null ? t.ansi3 : t.foreground;
    return root
      .child(div().text_size(size - 1).text_color(t.muted).truncate().child(`${this.pr.repo}#${this.pr.number} · ${this.pr.title}`))
      .child(div().text_size(size + 1).font_semibold().text_color(lineColor).child(v.line))
      .when(v.reason !== "", (el) => el.child(div().text_size(size - 1).text_color(t.muted).child(v.reason)))
      .when(v.failed && !this.st.armed, (el) => el.child(div().text_size(size - 1).text_color(t.ansi1).child("Checks failed on this PR.")))
      .when(v.green, (el) => el.child(div().text_size(size - 1).text_color(t.ansi3).child("Checks running · w = merge when green")));
  }
}
