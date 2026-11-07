import test from "node:test";
import assert from "node:assert/strict";
import { diffRows } from "../mods/pr-panel/diff.js";

test("diff --git line gives a file row named by its path", () => {
  assert.deepEqual(diffRows("diff --git a/x b/x"), [{ kind: "file", text: "x" }]);
});

test("a path with spaces, and a rename, name the new path", () => {
  assert.deepEqual(diffRows("diff --git a/my dir/f b.js b/my dir/f b.js"), [{ kind: "file", text: "my dir/f b.js" }]);
  assert.deepEqual(diffRows("diff --git a/old.js b/new.js"), [{ kind: "file", text: "new.js" }]);
});

test("hunk header gives a hunk row", () => {
  const rows = diffRows("diff --git a/x b/x\n@@ -1,2 +1,3 @@");
  assert.deepEqual(rows[1], { kind: "hunk", text: "@@ -1,2 +1,3 @@" });
});

test("+, - and space lines give add, del and ctx (marker dropped)", () => {
  const rows = diffRows("diff --git a/x b/x\n@@ -1,2 +1,2 @@\n+a\n-b\n c");
  assert.deepEqual(rows.slice(2), [
    { kind: "add", text: "a" },
    { kind: "del", text: "b" },
    { kind: "ctx", text: "c" },
  ]);
});

test("+++, --- and index header lines are skipped", () => {
  const text = [
    "diff --git a/x b/x",
    "index 83db48f..bf269f4 100644",
    "--- a/x",
    "+++ b/x",
    "@@ -1 +1 @@",
    "-old",
    "+new",
  ].join("\n");
  assert.deepEqual(diffRows(text), [
    { kind: "file", text: "x" },
    { kind: "hunk", text: "@@ -1 +1 @@" },
    { kind: "del", text: "old" },
    { kind: "add", text: "new" },
  ]);
});

test("inside a hunk, a removed '-- x' or added '++ y' line is content, not a header", () => {
  const rows = diffRows("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n--- x\n+++ y");
  assert.deepEqual(rows.slice(2), [
    { kind: "del", text: "-- x" },
    { kind: "add", text: "++ y" },
  ]);
});

test("mode and rename headers are skipped; a binary note shows as context", () => {
  const text = [
    "diff --git a/img.png b/img.png",
    "new file mode 100644",
    "index 0000000..1111111",
    "Binary files /dev/null and b/img.png differ",
  ].join("\n");
  assert.deepEqual(diffRows(text), [
    { kind: "file", text: "img.png" },
    { kind: "ctx", text: "Binary files /dev/null and b/img.png differ" },
  ]);
});

test("a trailing newline adds no row; an empty string gives []", () => {
  assert.deepEqual(diffRows(""), []);
  assert.equal(diffRows("diff --git a/x b/x\n@@ -1 +1 @@\n+a\n").length, 3);
});

test("CRLF output and an empty context line both parse", () => {
  const rows = diffRows("diff --git a/x b/x\r\n@@ -1,2 +1,2 @@\r\n \r\n+a\r\n");
  assert.deepEqual(rows.slice(2), [{ kind: "ctx", text: "" }, { kind: "add", text: "a" }]);
});
