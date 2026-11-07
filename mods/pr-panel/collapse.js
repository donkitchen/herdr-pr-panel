// Pure: keeps an emptied wrapper column from leaving a blank strip.
const hasTab = (n) => n?.content?.tab !== undefined || (n?.children ?? []).some(hasTab);
const hasStack = (n) => n?.type === "stack" || (n?.children ?? []).some(hasStack);
// Herdr's own side panel: its tabs mod hides and shows this column itself.
const HERDR_PANEL = "panel";

function findParent(node, id, parent = null) {
  if (!node || typeof node !== "object") return null;
  if (node.id === id) return parent;
  for (const c of node.children ?? []) {
    const p = findParent(c, id, node);
    if (p) return p;
  }
  return null;
}

/**
 * When every child of the panel's parent is hidden, the parent should hide too; when any child is
 * shown again and the parent is hidden, it should show. Returns {op:"hide"|"show", id} or null.
 * It only acts on a column (or row) of its own beside Herdr's: never the root, a node holding the
 * tab area, a parent without an id, Herdr's `panel` column, or anything holding a stack (that is
 * how Herdr's panel switches files/changes; whoever owns a stack owns its column's visibility).
 */
export function collapseAction(tree, panelId) {
  if (!tree || !panelId) return null;
  const parent = findParent(tree, panelId);
  if (!parent || parent === tree || !parent.id) return null;
  if (parent.type !== "row" && parent.type !== "column") return null;
  if (hasTab(parent)) return null;
  if (parent.id === HERDR_PANEL || hasStack(parent)) return null;
  const kids = parent.children ?? [];
  if (kids.length === 0) return null;
  const allHidden = kids.every((k) => k.hidden === true);
  if (allHidden && parent.hidden !== true) return { op: "hide", id: parent.id };
  if (!allHidden && parent.hidden === true) return { op: "show", id: parent.id };
  return null;
}
