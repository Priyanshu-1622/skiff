import { test } from "node:test";
import assert from "node:assert/strict";
import { isTrackableText, unifiedDiff } from "./diff.js";

/** Test-only: apply a diff produced by unifiedDiff (hunks only) to the old text. */
function applyUnifiedDiff(oldText: string, diff: string): string {
  const oldLines = oldText === "" ? [] : oldText.split(/(?<=\n)/);
  if (diff === "") return oldText;
  const out: string[] = [];
  let pos = 0; // index into oldLines
  const rows = diff.split(/(?<=\n)/);
  let k = 0;
  while (k < rows.length) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@\n?$/.exec(rows[k]!);
    assert.ok(header, `a hunk header at row ${k}: ${JSON.stringify(rows[k])}`);
    const oldStart = Number(header![1]);
    const oldCount = header![2] === undefined ? 1 : Number(header![2]);
    const start = oldCount === 0 ? oldStart : oldStart - 1; // a zero-length old range names the line BEFORE the insertion point
    assert.ok(start <= oldLines.length, `hunk starts inside the old text (${start} <= ${oldLines.length})`);
    while (pos < start) out.push(oldLines[pos++]!);
    k++;
    while (k < rows.length && !rows[k]!.startsWith("@@")) {
      const row = rows[k]!;
      const tag = row[0];
      const body = row.slice(1);
      const next = rows[k + 1];
      const noNewline = next !== undefined && next.startsWith("\\ No newline at end of file");
      const text = noNewline ? body.replace(/\n$/, "") : body;
      if (tag === " ") { assert.equal(oldLines[pos], text, "context matches the old text"); out.push(text); pos++; }
      else if (tag === "-") { assert.equal(oldLines[pos], text, "removed line matches the old text"); pos++; }
      else if (tag === "+") out.push(text);
      else if (tag === "\\") { /* marker row */ }
      else assert.fail(`unexpected row ${JSON.stringify(row)}`);
      k++;
    }
  }
  while (pos < oldLines.length) out.push(oldLines[pos++]!);
  return out.join("");
}

function counts(diff: string) {
  let added = 0, removed = 0;
  for (const row of diff.split("\n")) { if (row.startsWith("+")) added++; else if (row.startsWith("-")) removed++; }
  return { added, removed };
}

test("identical texts produce an empty diff", () => {
  assert.deepEqual(unifiedDiff("a\nb\n", "a\nb\n"), { diff: "", added: 0, removed: 0 });
  assert.deepEqual(unifiedDiff("", ""), { diff: "", added: 0, removed: 0 });
});

test("a single changed line, with context", () => {
  const r = unifiedDiff("one\ntwo\nthree\nfour\nfive\n", "one\ntwo\nTHREE\nfour\nfive\n");
  assert.equal(r.added, 1);
  assert.equal(r.removed, 1);
  assert.ok(r.diff.includes("-three\n") && r.diff.includes("+THREE\n") && r.diff.includes(" two\n"));
  assert.equal(applyUnifiedDiff("one\ntwo\nthree\nfour\nfive\n", r.diff), "one\ntwo\nTHREE\nfour\nfive\n");
});

test("inserting at the start, middle and end, and deleting", () => {
  const base = "a\nb\nc\nd\ne\nf\ng\nh\n";
  for (const next of ["X\na\nb\nc\nd\ne\nf\ng\nh\n", "a\nb\nc\nX\nd\ne\nf\ng\nh\n", "a\nb\nc\nd\ne\nf\ng\nh\nX\n", "b\nc\nd\ne\nf\ng\nh\n", "a\nb\nc\nd\ne\nf\ng\n", "a\nb\nd\ne\nf\ng\nh\n"]) {
    const r = unifiedDiff(base, next);
    assert.equal(applyUnifiedDiff(base, r.diff), next, JSON.stringify(next));
    assert.deepEqual({ added: r.added, removed: r.removed }, counts(r.diff));
  }
});

test("a created file and an emptied file", () => {
  const created = unifiedDiff("", "hello\nworld\n");
  assert.deepEqual({ a: created.added, r: created.removed }, { a: 2, r: 0 });
  assert.equal(applyUnifiedDiff("", created.diff), "hello\nworld\n");
  const emptied = unifiedDiff("hello\nworld\n", "");
  assert.deepEqual({ a: emptied.added, r: emptied.removed }, { a: 0, r: 2 });
  assert.equal(applyUnifiedDiff("hello\nworld\n", emptied.diff), "");
});

test("a missing final newline is shown and survives", () => {
  const r = unifiedDiff("a\nb\n", "a\nb");
  assert.ok(r.diff.includes("\\ No newline at end of file"));
  assert.equal(applyUnifiedDiff("a\nb\n", r.diff), "a\nb");
  const back = unifiedDiff("a\nb", "a\nb\n");
  assert.equal(applyUnifiedDiff("a\nb", back.diff), "a\nb\n");
  const both = unifiedDiff("a\nb", "a\nc");
  assert.equal(applyUnifiedDiff("a\nb", both.diff), "a\nc");
});

test("CRLF line endings are preserved", () => {
  const oldText = "a\r\nb\r\nc\r\n";
  const newText = "a\r\nB\r\nc\r\n";
  const r = unifiedDiff(oldText, newText);
  assert.equal(applyUnifiedDiff(oldText, r.diff), newText);
});

test("two distant changes make two hunks", () => {
  const oldLines = Array.from({ length: 40 }, (_, i) => `line ${i}\n`);
  const newLines = oldLines.slice();
  newLines[2] = "changed early\n";
  newLines[35] = "changed late\n";
  const r = unifiedDiff(oldLines.join(""), newLines.join(""));
  assert.equal((r.diff.match(/^@@/gm) ?? []).length, 2);
  assert.equal(applyUnifiedDiff(oldLines.join(""), r.diff), newLines.join(""));
});

test("random edits always round-trip, and the counts match the diff", () => {
  let seed = 12345;
  const rand = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const alphabet = ["alpha", "beta", "gamma", "delta", "", "x = 1", "x = 2", "}"];
  for (let n = 0; n < 200; n++) {
    const len = Math.floor(rand() * 30);
    const oldLines = Array.from({ length: len }, () => alphabet[Math.floor(rand() * alphabet.length)]!);
    const newLines = oldLines.slice();
    for (let e = 0; e < Math.floor(rand() * 6); e++) {
      const at = Math.floor(rand() * (newLines.length + 1));
      const kind = rand();
      if (kind < 0.4) newLines.splice(at, 0, alphabet[Math.floor(rand() * alphabet.length)]!);
      else if (kind < 0.7) newLines.splice(at, 1);
      else if (at < newLines.length) newLines[at] = alphabet[Math.floor(rand() * alphabet.length)]!;
    }
    const join = (ls: string[]) => ls.map((l) => l + "\n").join("");
    let oldText = join(oldLines), newText = join(newLines);
    if (rand() < 0.2) oldText = oldText.replace(/\n$/, "");
    if (rand() < 0.2) newText = newText.replace(/\n$/, "");
    const r = unifiedDiff(oldText, newText);
    assert.equal(applyUnifiedDiff(oldText, r.diff), newText, `case ${n}: ${JSON.stringify({ oldText, newText })}`);
    assert.deepEqual({ added: r.added, removed: r.removed }, counts(r.diff), `case ${n} counts`);
  }
});

test("a huge total rewrite falls back to a whole-block replace instead of hanging", () => {
  const oldText = Array.from({ length: 20000 }, (_, i) => `old ${i}\n`).join("");
  const newText = Array.from({ length: 20000 }, (_, i) => `new ${i}\n`).join("");
  const started = Date.now();
  const r = unifiedDiff(oldText, newText);
  assert.ok(Date.now() - started < 5000, "finished quickly");
  assert.deepEqual({ a: r.added, r: r.removed }, { a: 20000, r: 20000 });
  assert.equal(applyUnifiedDiff(oldText, r.diff), newText);
});

test("isTrackableText accepts ordinary text and rejects binary, oversized and key-like content", () => {
  assert.deepEqual(isTrackableText(Buffer.from("hello\nworld\n")), { ok: true, text: "hello\nworld\n" });
  assert.deepEqual(isTrackableText(Buffer.from("")), { ok: true, text: "" });
  assert.deepEqual(isTrackableText(Buffer.from("héllo ✓")), { ok: true, text: "héllo ✓" });
  assert.deepEqual(isTrackableText(Buffer.from([0x68, 0x00, 0x69])), { ok: false, reason: "binary" });
  assert.deepEqual(isTrackableText(Buffer.from([0xff, 0xfe, 0x41])), { ok: false, reason: "binary" });
  assert.deepEqual(isTrackableText(Buffer.alloc(256 * 1024, 0x61)), { ok: true, text: "a".repeat(256 * 1024) });
  assert.deepEqual(isTrackableText(Buffer.alloc(256 * 1024 + 1, 0x61)), { ok: false, reason: "too-large" });
  assert.deepEqual(isTrackableText(Buffer.from("x\n-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n")), { ok: false, reason: "key-like" });
  assert.deepEqual(isTrackableText(Buffer.from("-----BEGIN RSA PRIVATE KEY-----\n")), { ok: false, reason: "key-like" });
  assert.deepEqual(isTrackableText(Buffer.from("-----BEGIN PGP PRIVATE KEY BLOCK-----\n")), { ok: false, reason: "key-like" });
  assert.equal(isTrackableText(Buffer.from("-----BEGIN PUBLIC KEY-----\nabc\n")).ok, true, "a public key is fine");
  assert.equal(isTrackableText(Buffer.from("this is private information about keys")).ok, true);
});
