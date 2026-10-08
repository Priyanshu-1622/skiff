export const MAX_TRACKED_BYTES = 256 * 1024;
const MAX_EDIT_DISTANCE = 1000;
const KEY_LIKE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY[A-Z ]*-----/;

export type Trackable = { ok: true; text: string } | { ok: false; reason: "binary" | "too-large" | "key-like" };

/** Only ordinary UTF-8 text up to 256 KB is tracked, and never anything holding a private key. */
export function isTrackableText(bytes: Buffer): Trackable {
  if (bytes.length > MAX_TRACKED_BYTES) return { ok: false, reason: "too-large" };
  if (bytes.includes(0)) return { ok: false, reason: "binary" };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { ok: false, reason: "binary" };
  }
  if (KEY_LIKE.test(text)) return { ok: false, reason: "key-like" };
  return { ok: true, text };
}

type Op = { t: " " | "-" | "+"; line: string };

// Lines keep their terminator, so a missing final newline is a real difference.
const splitLines = (text: string): string[] => (text === "" ? [] : text.split(/(?<=\n)/));

/** Myers' O(ND) diff; null if the texts differ by more than MAX_EDIT_DISTANCE lines. */
function myers(a: string[], b: string[]): Op[] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
  }
  if (found < 0) return null;
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && prev[off + k - 1]! < prev[off + k + 1]!) ? k + 1 : k - 1;
    const prevX = prev[off + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { x--; y--; ops.push({ t: " ", line: a[x]! }); }
    if (x === prevX) { y--; ops.push({ t: "+", line: b[y]! }); } else { x--; ops.push({ t: "-", line: a[x]! }); }
  }
  while (x > 0 && y > 0) { x--; y--; ops.push({ t: " ", line: a[x]! }); }
  return ops.reverse();
}

function opsFor(a: string[], b: string[]): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const middle = myers(midA, midB) ?? [
    ...midA.map((line): Op => ({ t: "-", line })),
    ...midB.map((line): Op => ({ t: "+", line })),
  ];
  return [
    ...a.slice(0, start).map((line): Op => ({ t: " ", line })),
    ...middle,
    ...a.slice(endA).map((line): Op => ({ t: " ", line })),
  ];
}

const row = (op: Op): string => `${op.t}${op.line}${op.line.endsWith("\n") ? "" : "\n\\ No newline at end of file\n"}`;

/** A unified diff (hunks only, no file header) with `context` lines around each change. */
export function unifiedDiff(oldText: string, newText: string, opts: { context?: number } = {}): { diff: string; added: number; removed: number } {
  const context = opts.context ?? 3;
  const ops = opsFor(splitLines(oldText), splitLines(newText));
  const changed: number[] = [];
  ops.forEach((o, i) => { if (o.t !== " ") changed.push(i); });
  if (changed.length === 0) return { diff: "", added: 0, removed: 0 };

  // Group changes whose surrounding context would touch or overlap.
  const groups: Array<[number, number]> = [];
  for (const i of changed) {
    const last = groups[groups.length - 1];
    if (last && i - last[1] <= 2 * context + 1) last[1] = i; else groups.push([i, i]);
  }

  let diff = "";
  for (const [first, last] of groups) {
    const from = Math.max(0, first - context);
    const to = Math.min(ops.length - 1, last + context);
    let oldBefore = 0;
    let newBefore = 0;
    for (let i = 0; i < from; i++) { if (ops[i]!.t !== "+") oldBefore++; if (ops[i]!.t !== "-") newBefore++; }
    let oc = 0;
    let nc = 0;
    let body = "";
    for (let i = from; i <= to; i++) {
      const op = ops[i]!;
      if (op.t !== "+") oc++;
      if (op.t !== "-") nc++;
      body += row(op);
    }
    const oldStart = oc === 0 ? oldBefore : oldBefore + 1;
    const newStart = nc === 0 ? newBefore : newBefore + 1;
    diff += `@@ -${oldStart},${oc} +${newStart},${nc} @@\n${body}`;
  }
  return {
    diff,
    added: ops.filter((o) => o.t === "+").length,
    removed: ops.filter((o) => o.t === "-").length,
  };
}
