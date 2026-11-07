// Draws the panel from a View model (model.js buildView). No data fetching here:
// main.js owns the state and passes callbacks in `ui`.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { chooseMethod } from "../merge.js";
import { ticketUrl } from "../model.js";

const CHECK = { passed: "✓", running: "●", failed: "✗", none: "" };
const MAX_LINE = 120;

const clip = (s) => (s.length > MAX_LINE ? `${s.slice(0, MAX_LINE - 1)}…` : s);
const stop = (_e, cx) => cx.stop_propagation();

/** Rows in the order they are drawn: repo groups, then hand-off groups. Up/Down walks this. */
export function rowOrder(view) {
  const rows = [];
  for (const g of view?.groups ?? []) rows.push(...g.items);
  for (const h of view?.handOff ?? []) rows.push(...h.items);
  return rows;
}

/** "owner/repo" only matters when the list spans more than one owner. */
function repoNamer(view) {
  const owners = new Set(rowOrder(view).map((i) => i.pr.repo.split("/")[0]));
  return owners.size > 1 ? (repo) => repo : (repo) => repo.split("/").slice(1).join("/") || repo;
}

const checkColor = (t, checks) => (checks === "passed" ? t.ansi2 : checks === "failed" ? t.ansi1 : t.ansi3);
const ageColor = (t, level) => (level === "late" ? t.ansi1 : level === "warn" ? t.ansi3 : t.dim);

function tag(t, text, size) {
  return div().flex_none().px(5).rounded(4).bg(t.raised).text_size(size - 2).text_color(t.muted).child(text);
}

function row(item, ui, t, size) {
  const { pr } = item;
  const selected = ui.selectedId === pr.id;
  const dim = item.kind === "draft";
  const queued = ui.queued?.has(pr.id);
  const check = CHECK[pr.checks] ?? "";
  const line = h_flex().id(`row-${pr.id}`).h(size + 13).px(12).gap(6).items_center().cursor_pointer()
    .bg(selected ? t.selected : t.surface).hover((s) => s.bg(selected ? t.selected : t.hover))
    .on_click((_e, cx) => ui.onSelect(pr.id, cx))
    .child(div().flex_none().text_size(size - 1).text_color(t.muted).child(`#${pr.number}`))
    .when(item.bot, (el) => el.child(div().flex_none().text_size(size - 1).child("🤖")))
    .when(check !== "", (el) => el.child(div().flex_none().w(size - 1).text_size(size - 1).text_color(checkColor(t, pr.checks))
      .child(check).when(pr.checks === "running", (c) => c.loop("opacity", { from: 0.35, to: 1, period: 1400 }))))
    .child(div().flex_1().min_w(0).truncate().text_color(dim ? t.dim : t.foreground).child(pr.title))
    .when(dim, (el) => el.child(tag(t, "draft", size)))
    .when(Boolean(queued), (el) => el.child(tag(t, "queued", size)))
    .child(div().flex_none().text_size(size - 1).text_color(item.kind === "waiting" ? ageColor(t, item.ageLevel) : t.dim).child(item.age));
  if (!selected) return line;
  return v_flex().child(line).child(detail(item, ui, t, size));
}

function detail(item, ui, t, size) {
  const { pr } = item;
  const tickets = ui.config?.tickets;
  const links = (item.tickets ?? []).map((key) => {
    const url = ticketUrl(key, tickets);
    return div().id(`ticket-${pr.id}-${key}`).flex_none().text_size(size - 1).text_color(url ? t.accent : t.muted)
      .when(Boolean(url), (el) => el.cursor_pointer().hover((s) => s.underline()).on_mouse_down("left", stop)
        .on_click((_e, cx) => ui.onOpen(url, cx)))
      .child(key);
  });
  let reason = "";
  try { reason = chooseMethod(pr, ui.config).reason; } catch { reason = ""; }
  if (pr.mergeable === "UNKNOWN" && item.kind !== "handoff") reason = reason ? `${reason} · checking…` : "checking…";
  else if (pr.mergeable === "CONFLICTING" && item.kind !== "handoff") reason = reason ? `${reason} · conflicts` : "conflicts";
  return v_flex().px(12).pl(12 + size).pb(6).gap(2).bg(t.selected)
    .when(links.length > 0, (el) => el.child(h_flex().gap(8).children(links)))
    .when(reason !== "", (el) => el.child(div().truncate().text_size(size - 1).text_color(t.muted).child(reason)));
}

function groupHeader(t, label, size, first) {
  return div().flex_none().px(12).pt(first ? 8 : 12).pb(4).text_size(size - 1.5).font_semibold().text_color(t.muted).truncate().child(label);
}

/**
 * @param {{count:number, groups:any[], handOff:any[]}|null} view
 * @param {{selectedId:string|null, stale:boolean, message:string[]|string|null, checkedAgo:string|null,
 *   truncated:boolean, configError:string|null, queued:Set<string>, config:any, loading?:boolean,
 *   size?:number, onSelect:(id:string, cx:any)=>void, onOpen:(url:string, cx:any)=>void}} ui
 * @param {Record<string,string>} t theme()
 */
export function renderPanel(view, ui, t) {
  const size = ui.size ?? 13;
  const count = view?.count ?? 0;

  const messages = [];
  if (ui.configError) messages.push(ui.configError);
  for (const m of [].concat(ui.message ?? [])) if (m) messages.push(m);
  if (ui.truncated) messages.push("showing first 100");

  const status = ui.loading && !view ? "checking…" : ui.checkedAgo ? `checked ${ui.checkedAgo}` : "";
  const header = h_flex().h(38).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
    .child(div().flex_none().text_size(size + 1).font_semibold().text_color(t.foreground).child(`PRs waiting · ${count}`))
    .when(ui.stale, (el) => el.child(tag(t, "stale", size)))
    .child(h_flex().flex_1().min_w(0).justify_end()
      .child(div().min_w(0).truncate().text_size(size - 1.5).text_color(ui.stale ? t.ansi3 : t.dim).child(status)));

  const messageArea = v_flex().flex_none().px(12).py(messages.length ? 6 : 0).gap(2)
    .when(messages.length > 0, (el) => el.border_b(1).border_color(t.border))
    .children(messages.map((m) => div().truncate().text_size(size - 1).text_color(t.ansi3).child(clip(m))));

  const name = repoNamer(view);
  const blocks = [];
  let first = true;
  for (const g of view?.groups ?? []) {
    blocks.push(groupHeader(t, name(g.repo), size, first));
    first = false;
    for (const item of g.items) blocks.push(row(item, ui, t, size));
  }
  for (const h of view?.handOff ?? []) {
    blocks.push(groupHeader(t, h.label, size, first));
    first = false;
    for (const item of h.items) blocks.push(row(item, ui, t, size));
  }

  const body = blocks.length > 0
    ? div().id("pr-list").flex_1().min_h(0).overflow_y_scrollbar().child(v_flex().pb(8).children(blocks))
    : v_flex().flex_1().min_h(0).justify_center().items_center().text_color(t.dim)
      .child(view ? "Nothing waiting." : ui.loading ? "Checking GitHub…" : "");

  const hints = div().flex_none().h(28).px(12).flex().items_center().border_t(1).border_color(t.border)
    .text_size(size - 2).text_color(t.dim).truncate().child("⏎ peek · m merge · o GitHub · g go to agent · r refresh");

  return v_flex().size_full().min_h(0).bg(t.surface).text_size(size).text_color(t.foreground)
    .child(header).child(messageArea).child(body).child(hints);
}
