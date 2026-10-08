import { posix } from "node:path";

/**
 * Which files might a command have written? A small shell-aware reader, not a
 * shell: it understands quoting, escapes, command chains and redirects, and
 * deliberately gives up on anything it cannot know from the text alone
 * (variables, globs, command/process substitution). Never guesses.
 */
export interface CandidatePath {
  /** Absolute path, or `~/...` for the caller to expand, or a bare relative path when `relative` is true. */
  path: string;
  /** True when the path was relative and no working directory was known to resolve it. */
  relative: boolean;
  via: "editor" | "sed -i" | "tee" | "redirect" | "cp" | "mv" | "install";
}

const MAX_PATHS = 5;
const MAX_INPUT = 8192;

interface Word { text: string; expands: boolean; glob: boolean }
type Token =
  | { type: "word"; word: Word }
  | { type: "ctl" }
  | { type: "redir"; op: ">" | ">>" | "<" | "<<" | "<<<"; fd: number | null; dup: boolean };

function tokenize(input: string): Token[] | null {
  const out: Token[] = [];
  let buf = "";
  let expands = false;
  let glob = false;
  let inWord = false;
  let i = 0;
  const flush = () => {
    if (inWord) out.push({ type: "word", word: { text: buf, expands, glob } });
    buf = ""; expands = false; glob = false; inWord = false;
  };
  const skipBalanced = (open: string, close: string): boolean => {
    let depth = 0;
    for (; i < input.length; i++) {
      const c = input[i]!;
      if (c === open) depth++;
      else if (c === close) { depth--; if (depth === 0) { i++; return true; } }
    }
    return false;
  };
  while (i < input.length) {
    const c = input[i]!;
    if (c === " " || c === "\t") { flush(); i++; continue; }
    if (c === "\n") { flush(); out.push({ type: "ctl" }); i++; continue; }
    if (c === "#" && !inWord) { while (i < input.length && input[i] !== "\n") i++; continue; }
    if (c === "\\") {
      if (i + 1 >= input.length) { i++; continue; }
      if (input[i + 1] === "\n") { i += 2; continue; }
      buf += input[i + 1]; inWord = true; i += 2; continue;
    }
    if (c === "'") {
      const end = input.indexOf("'", i + 1);
      if (end < 0) return null;
      buf += input.slice(i + 1, end); inWord = true; i = end + 1; continue;
    }
    if (c === '"') {
      i++; inWord = true;
      let closed = false;
      while (i < input.length) {
        const d = input[i]!;
        if (d === '"') { closed = true; i++; break; }
        if (d === "\\" && i + 1 < input.length) {
          const n = input[i + 1]!;
          if (n === '"' || n === "\\" || n === "$" || n === "`") { buf += n; i += 2; continue; }
          buf += d; i++; continue;
        }
        if (d === "$" || d === "`") expands = true;
        buf += d; i++;
      }
      if (!closed) return null;
      continue;
    }
    if (c === "$") {
      expands = true; inWord = true;
      if (input[i + 1] === "(") { i++; if (!skipBalanced("(", ")")) return null; continue; }
      if (input[i + 1] === "{") { i++; if (!skipBalanced("{", "}")) return null; continue; }
      buf += c; i++; continue;
    }
    if (c === "`") {
      expands = true; inWord = true;
      const end = input.indexOf("`", i + 1);
      if (end < 0) return null;
      i = end + 1; continue;
    }
    if ((c === "<" || c === ">") && input[i + 1] === "(") {
      expands = true; inWord = true; i++;
      if (!skipBalanced("(", ")")) return null;
      continue;
    }
    if (c === ";" || c === "|" || c === "&") {
      if (c === "&" && input[i + 1] === ">") {
        flush();
        let op: ">" | ">>" = ">"; i += 2;
        if (input[i] === ">") { op = ">>"; i++; }
        out.push({ type: "redir", op, fd: null, dup: false });
        continue;
      }
      flush();
      i++; // "&&" and "||" simply produce two separators, which is harmless
      out.push({ type: "ctl" });
      continue;
    }
    if (c === ">" || c === "<") {
      let fd: number | null = null;
      if (inWord && /^\d+$/.test(buf) && !expands && !glob) { fd = Number(buf); buf = ""; inWord = false; } else flush();
      let op: ">" | ">>" | "<" | "<<" | "<<<";
      if (c === ">") { if (input[i + 1] === ">") { op = ">>"; i += 2; } else { op = ">"; i++; } }
      else if (input.startsWith("<<<", i)) { op = "<<<"; i += 3; }
      else if (input.startsWith("<<", i)) { op = "<<"; i += 2; }
      else { op = "<"; i++; }
      let dup = false;
      if ((op === ">" || op === "<") && input[i] === "&") { dup = true; i++; }
      out.push({ type: "redir", op, fd, dup });
      continue;
    }
    if (c === "*" || c === "?" || c === "[") glob = true;
    buf += c; inWord = true; i++;
  }
  flush();
  return out;
}

interface Simple { words: Word[]; redirects: { op: string; fd: number | null; dup: boolean; target: Word | null }[] }

function splitSimple(tokens: Token[]): Simple[] {
  const list: Simple[] = [];
  let cur: Simple = { words: [], redirects: [] };
  const push = () => { if (cur.words.length || cur.redirects.length) list.push(cur); cur = { words: [], redirects: [] }; };
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (t.type === "ctl") { push(); continue; }
    if (t.type === "redir") {
      const next = tokens[k + 1];
      let target: Word | null = null;
      if (next && next.type === "word") { target = next.word; k++; }
      cur.redirects.push({ op: t.op, fd: t.fd, dup: t.dup, target });
      continue;
    }
    cur.words.push(t.word);
  }
  push();
  return list;
}

const EDITORS = new Set(["vim", "vi", "nvim", "view", "vimdiff", "nano", "pico", "emacs", "micro", "joe", "ed", "ex", "sudoedit"]);
const EDITOR_FLAGS_WITH_ARG = new Set(["-u", "-c", "-S", "-i", "-T", "--cmd"]);
const SUDO_FLAGS_WITH_ARG = new Set(["-u", "-g", "-h", "-p", "-C", "-r", "-t", "-T", "-U", "-D"]);
const COPY_FLAGS_WITH_ARG = new Set(["-t", "-S", "-m", "-o", "-g"]);

function candidatesOfSimple(simple: Simple): { text: Word; via: CandidatePath["via"] }[] {
  const found: { text: Word; via: CandidatePath["via"] }[] = [];
  for (const r of simple.redirects) {
    if ((r.op === ">" || r.op === ">>") && !r.dup && (r.fd === null || r.fd === 1) && r.target) found.push({ text: r.target, via: "redirect" });
  }

  let words = simple.words.slice();
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!.text)) words.shift();
  let sudoEdit = false;
  while (words.length && (words[0]!.text === "sudo" || words[0]!.text === "doas")) {
    words.shift();
    while (words.length && words[0]!.text.startsWith("-")) {
      const flag = words.shift()!.text;
      if (flag === "-e" || flag === "--edit") sudoEdit = true;
      else if (SUDO_FLAGS_WITH_ARG.has(flag)) words.shift();
    }
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!.text)) words.shift();
  }
  if (!words.length) return found;

  const name = posix.basename(words[0]!.text);
  const args = words.slice(1);
  const isFlag = (w: Word) => w.text.startsWith("-") && w.text !== "-";

  if (sudoEdit) {
    for (const w of words) if (!isFlag(w)) found.push({ text: w, via: "editor" });
    return found;
  }
  if (EDITORS.has(name)) {
    for (let k = 0; k < args.length; k++) {
      const w = args[k]!;
      if (EDITOR_FLAGS_WITH_ARG.has(w.text)) { k++; continue; }
      if (isFlag(w) || /^\+\d*$/.test(w.text)) continue;
      found.push({ text: w, via: "editor" });
    }
    return found;
  }
  if (name === "sed") {
    let inPlace = false;
    let scriptGiven = false;
    const operands: Word[] = [];
    for (let k = 0; k < args.length; k++) {
      const w = args[k]!;
      const t = w.text;
      if (t === "--") { operands.push(...args.slice(k + 1)); break; }
      if (t.startsWith("--")) {
        if (t === "--in-place" || t.startsWith("--in-place=")) inPlace = true;
        else if (t === "--expression" || t === "--file") { scriptGiven = true; k++; }
        else if (t.startsWith("--expression=") || t.startsWith("--file=")) scriptGiven = true;
        continue;
      }
      if (t.startsWith("-") && t.length > 1) {
        for (let j = 1; j < t.length; j++) {
          const ch = t[j]!;
          if (ch === "i") { inPlace = true; break; }
          if (ch === "e" || ch === "f") { scriptGiven = true; if (j === t.length - 1) k++; break; }
        }
        continue;
      }
      operands.push(w);
    }
    if (!inPlace) return found;
    const files = scriptGiven ? operands : operands.slice(1);
    for (const w of files) found.push({ text: w, via: "sed -i" });
    return found;
  }
  if (name === "tee") {
    for (const w of args) if (!isFlag(w)) found.push({ text: w, via: "tee" });
    return found;
  }
  if (name === "cp" || name === "mv" || name === "install") {
    let hasTarget = false;
    let makesDirs = false;
    const operands: Word[] = [];
    for (let k = 0; k < args.length; k++) {
      const w = args[k]!;
      const t = w.text;
      if (t === "-d" && name === "install") { makesDirs = true; continue; }
      if (t === "-t" || t.startsWith("--target-directory")) { hasTarget = true; if (t === "-t") k++; continue; }
      if (COPY_FLAGS_WITH_ARG.has(t)) { k++; continue; }
      if (isFlag(w)) continue;
      operands.push(w);
    }
    if (!hasTarget && !makesDirs && operands.length >= 2) found.push({ text: operands[operands.length - 1]!, via: name });
    return found;
  }
  return found;
}

function toCandidate(word: Word, via: CandidatePath["via"], cwd: string | null): CandidatePath | null {
  const t = word.text;
  if (word.expands || word.glob || t === "" || t === "-" || t === "~") return null;
  if (t.startsWith("/dev/") || t.startsWith("/proc/") || t.startsWith("/sys/")) return null;
  if (t.startsWith("~/")) return { path: t, relative: false, via };
  if (t.startsWith("/")) return { path: posix.normalize(t), relative: false, via };
  if (cwd) return { path: posix.normalize(`${cwd}/${t}`), relative: false, via };
  return { path: t, relative: true, via };
}

export function extractCandidatePaths(command: string, cwd: string | null): CandidatePath[] {
  if (!command || command.length > MAX_INPUT) return [];
  let tokens: Token[] | null;
  try { tokens = tokenize(command); } catch { return []; }
  if (!tokens) return [];
  const result: CandidatePath[] = [];
  const seen = new Set<string>();
  for (const simple of splitSimple(tokens)) {
    for (const c of candidatesOfSimple(simple)) {
      const cand = toCandidate(c.text, c.via, cwd);
      if (!cand || seen.has(cand.path)) continue;
      seen.add(cand.path);
      result.push(cand);
      if (result.length >= MAX_PATHS) return result;
    }
  }
  return result;
}
