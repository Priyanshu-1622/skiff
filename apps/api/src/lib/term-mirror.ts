// CommonJS packages: use the default export (named ESM imports crash at runtime).
import xtermHeadless from "@xterm/headless";
import serializeAddon from "@xterm/addon-serialize";

const { Terminal } = xtermHeadless;
const { SerializeAddon } = serializeAddon;

export interface TermMirrorOptions {
  cols: number;
  rows: number;
  /** Lines kept above the screen; bounds memory and snapshot size. */
  scrollback?: number;
  /**
   * Cap on bytes written but not yet parsed by xterm. Past this, further
   * writes are shed (dropped from the mirror only — the live browser stream
   * is unaffected, see session-manager.ts's separate `deliver()`) until the
   * backlog drains. Without a cap, a fast burst of output (e.g. `cat` on a
   * large file) can queue faster than xterm's async parser drains it; xterm's
   * own WriteBuffer throws once that backlog passes 50,000,000 bytes, which
   * would otherwise fail this mirror — silently and permanently, since there
   * is no reset path — for the rest of the session's life. Default is
   * comfortably under that limit.
   */
  maxPendingBytes?: number;
}

const DEFAULT_MAX_PENDING_BYTES = 4 * 1024 * 1024; // 4 MB; xterm's own limit is 50 MB

const clamp = (n: number, fallback: number) =>
  Number.isInteger(n) && n >= 1 ? Math.min(n, 1000) : fallback;

/**
 * A headless copy of what the browser's terminal shows, kept on the server.
 *
 * Fed the same bytes as the attached browser, so reading it answers "what is
 * on screen right now" — the rendered result of tab completion, backspaces
 * and cursor edits. Used to replay the real screen on reattach, and (phase B)
 * to capture the command a user actually ran.
 *
 * Contained by design: an internal error flips `failed` and turns the mirror
 * into a no-op. It must never take the SSH session down with it.
 */
export class TermMirror {
  private term: InstanceType<typeof Terminal>;
  private serializer: InstanceType<typeof SerializeAddon>;
  private _failed = false;
  private readonly maxPendingBytes: number;
  /** Bytes handed to xterm whose parse callback hasn't fired yet. */
  private pendingBytes = 0;

  constructor(opts: TermMirrorOptions) {
    this.term = new Terminal({
      cols: clamp(opts.cols, 80),
      rows: clamp(opts.rows, 24),
      scrollback: opts.scrollback ?? 2000,
      allowProposedApi: true,
    });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer as any);
    this.maxPendingBytes = opts.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES;
  }

  get failed(): boolean {
    return this._failed;
  }

  private guard<T>(fn: () => T, fallback: T): T {
    if (this._failed) return fallback;
    try {
      return fn();
    } catch {
      this._failed = true;
      return fallback;
    }
  }

  /**
   * Feed output. Returns this write's sequence number, or the previous one
   * unchanged if this write was shed under load (see `maxPendingBytes`) —
   * nothing was queued for it, so nothing new exists to number.
   *
   * xterm applies writes asynchronously and in batches, so "was this chunk on
   * screen when the snapshot was taken?" can only be answered by numbering:
   * `applied` counts writes xterm has actually processed (their callbacks run
   * in order).
   */
  write(data: Buffer | string): number {
    if (this._failed) return this.written;
    const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.length;
    if (this.pendingBytes >= this.maxPendingBytes) return this.written; // shed
    const seq = ++this.written;
    this.pendingBytes += bytes;
    this.guard(() => this.term.write(
      typeof data === "string" ? data : new Uint8Array(data),
      () => { this.applied = seq; this.pendingBytes -= bytes; },
    ), undefined);
    return seq;
  }

  private written = 0;
  private applied = 0;

  resize(cols: number, rows: number): void {
    this.guard(() => this.term.resize(clamp(cols, this.term.cols), clamp(rows, this.term.rows)), undefined);
  }

  /** Resolves once every write issued before this call has been applied. */
  flush(): Promise<void> {
    if (this._failed) return Promise.resolve();
    return new Promise((resolve) => {
      try { this.term.write("", () => resolve()); } catch { this._failed = true; resolve(); }
    });
  }

  /**
   * The cursor's line, right-trimmed. xterm's own trim only drops cells that
   * were never written; a space that was explicitly printed (a prompt's
   * trailing space, or a replayed snapshot) would survive, so trim here too.
   */
  cursorLine(): string {
    return this.guard(() => {
      const buf = this.term.buffer.active;
      return (buf.getLine(buf.baseY + buf.cursorY)?.translateToString(true) ?? "").replace(/\s+$/, "");
    }, "");
  }

  cursorX(): number {
    return this.guard(() => this.term.buffer.active.cursorX, 0);
  }

  /**
   * The line immediately above the cursor, right-trimmed — the line a
   * just-applied "\n" moved the cursor away from. Command text usually
   * arrives as "<echoed command>\n" in one write, so by the time anything
   * downstream can react, the cursor has already moved to the next
   * (still-empty) line; this reads the line that a plain cursorLine()
   * would now miss.
   */
  lineAbove(): string {
    return this.guard(() => {
      const buf = this.term.buffer.active;
      const row = buf.baseY + buf.cursorY - 1;
      if (row < 0) return "";
      return (buf.getLine(row)?.translateToString(true) ?? "").replace(/\s+$/, "");
    }, "");
  }

  /** The cursor's absolute row — grows with scrollback, stable across a resize's viewport reflow relative to lineStartingAt's own reads. */
  cursorRow(): number {
    return this.guard(() => this.term.buffer.active.baseY + this.term.buffer.active.cursorY, 0);
  }

  /**
   * The logical line starting at absolute row `row`, following any wrapped
   * continuation rows into one string, right-trimmed. Anchoring a read to
   * a row captured earlier (e.g. via cursorRow() at the moment typing
   * began) is more robust than re-deriving "which row is this" from the
   * cursor's current position, and — unlike cursorLine() — reads the full
   * command even when it wrapped past one row.
   */
  lineStartingAt(row: number): string {
    return this.guard(() => {
      const buf = this.term.buffer.active;
      let text = "";
      let r = row;
      for (;;) {
        const line = buf.getLine(r);
        if (!line) break;
        text += line.translateToString(false);
        const next = buf.getLine(r + 1);
        if (next?.isWrapped) { r++; continue; }
        break;
      }
      return text.replace(/\s+$/, "");
    }, "");
  }

  isAltScreen(): boolean {
    return this.guard(() => this.term.buffer.active.type === "alternate", false);
  }

  async snapshot(): Promise<string> {
    return (await this.snapshotWithSeq()).screen;
  }

  /**
   * The screen, plus the sequence number of the last write it contains. Read
   * together in one synchronous step, so they always agree: every write with
   * seq <= `seq` is in `screen`, every later one is not.
   */
  async snapshotWithSeq(): Promise<{ screen: string; seq: number }> {
    await this.flush();
    // A failed mirror has no screen to offer: report seq 0 so the caller
    // sends every queued chunk instead of treating them as already shown.
    if (this._failed) return { screen: "", seq: 0 };
    return this.guard(
      () => ({ screen: this.serializer.serialize(), seq: this.applied }),
      { screen: "", seq: 0 },
    );
  }

  dispose(): void {
    try { this.term.dispose(); } catch { /* already gone */ }
  }
}
