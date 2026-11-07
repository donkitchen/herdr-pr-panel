import { classify } from "./model.js";

/**
 * Notify-once bookkeeping. Only waiting PRs are recorded; drafts and hand-offs
 * never are, so a draft that is later marked ready counts as new. The first run
 * records everything and toasts nothing. Does not mutate `state`.
 *
 * Callers MUST pass `{complete:false}` whenever any query failed this refresh
 * (the PR list is partial). Then prior ids are kept (no pruning), so PRs that
 * were merely missing do not toast again on the next full refresh.
 * @returns {{state:{initialized:boolean, seen:string[]}, fresh:object[]}}
 */
export function updateSeen(state, prs, config, { complete = true } = {}) {
  const known = new Set(state.seen);
  const seen = complete ? [] : [...state.seen];
  const listed = new Set(seen);
  const fresh = [];
  const done = new Set();
  for (const pr of prs) {
    if (classify(pr, config).kind !== "waiting" || done.has(pr.id)) continue;
    done.add(pr.id);
    if (!listed.has(pr.id)) {
      listed.add(pr.id);
      seen.push(pr.id);
    }
    if (state.initialized && !known.has(pr.id)) fresh.push(pr);
  }
  return { state: { initialized: true, seen }, fresh };
}

/**
 * After a failed save, the file is behind memory: union both so a reload never forgets
 * seen ids (which would toast again every refresh). Memory's queue entries win; the
 * file's other entries are kept, except ids in `removed` (tombstones: queue entries this
 * panel dropped, merged or cancelled), which never come back from the file. Does not
 * mutate its inputs.
 * @param {{has(id:string):boolean}|null} [removed] a Set or Map of tombstoned PR ids
 */
export function mergeState(file, mem, removed = null) {
  const seen = [...file.seen];
  const have = new Set(seen);
  for (const id of mem.seen) if (!have.has(id)) { have.add(id); seen.push(id); }
  const queue = withoutRemoved(file.queue, removed);
  for (const [id, e] of Object.entries(mem.queue ?? {})) queue[id] = e; // memory never holds a tombstoned id
  return { initialized: file.initialized || mem.initialized, seen, queue };
}

/** A copy of `queue` without the tombstoned ids. */
export function withoutRemoved(queue, removed) {
  const out = {};
  for (const [id, e] of Object.entries(queue ?? {})) if (!removed?.has(id)) out[id] = e;
  return out;
}
