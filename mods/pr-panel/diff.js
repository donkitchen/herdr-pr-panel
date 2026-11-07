// Turns `gh pr diff --color never` output into rows the peek draws one per line.
// Pure: no herdr imports.

/** The path a `diff --git a/P b/Q` line names: Q (the new path), quotes dropped. */
function filePath(line) {
  const rest = line.slice("diff --git ".length).replace(/"/g, "");
  // Same path on both sides (the common case), even when it holds spaces or " b/".
  const half = (rest.length - 5) / 2;
  if (Number.isInteger(half) && rest.startsWith("a/") && rest.slice(2 + half, 5 + half) === " b/"
    && rest.slice(2, 2 + half) === rest.slice(5 + half)) return rest.slice(5 + half);
  const at = rest.lastIndexOf(" b/");
  return at >= 0 ? rest.slice(at + 3) : rest;
}

/**
 * @param {string} text
 * @returns {{kind:"file"|"hunk"|"add"|"del"|"ctx", text:string}[]}
 */
export function diffRows(text) {
  const rows = [];
  if (!text) return rows;
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  let header = true; // between `diff --git` and the first `@@`: ---, +++, index, modes are noise
  for (let line of lines) {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.startsWith("diff --git ")) {
      rows.push({ kind: "file", text: filePath(line) });
      header = true;
    } else if (line.startsWith("@@")) {
      rows.push({ kind: "hunk", text: line });
      header = false;
    } else if (header) {
      if (line.startsWith("Binary files ")) rows.push({ kind: "ctx", text: line });
    } else if (line[0] === "+") rows.push({ kind: "add", text: line.slice(1) });
    else if (line[0] === "-") rows.push({ kind: "del", text: line.slice(1) });
    else if (line[0] === " ") rows.push({ kind: "ctx", text: line.slice(1) });
    else rows.push({ kind: "ctx", text: line }); // "\ No newline at end of file", or a bare empty line
  }
  return rows;
}
