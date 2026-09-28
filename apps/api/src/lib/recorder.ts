import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { sealChunk } from "../crypto/data-keys.js";

/** Encrypted recordings are flushed in chunks of about this size, or every 2 s. */
const CHUNK_BYTES = 32 * 1024;
const CHUNK_FLUSH_MS = 2000;

/**
 * Records a terminal session to disk in asciicast v2 format — the open
 * standard used by asciinema. The format is newline-delimited JSON:
 *
 *   line 1: a header object { version, width, height, timestamp, ... }
 *   line n: an event array [elapsedSeconds, "o", outputChunk]
 *           or a resize     [elapsedSeconds, "r", "COLSxROWS"]
 *
 * This is directly playable by the asciinema player (which we embed on the
 * frontend), and being a documented open format it's future-proof and
 * portable — recordings aren't locked into Skiff.
 *
 * Recording is strictly best-effort: a write failure must never disrupt the
 * live SSH session, so every call is guarded by the caller.
 *
 * With a `key`, the file is `<id>.cast.enc`: the same asciicast lines, sealed
 * in AES-GCM chunks (crypto/data-keys.ts) bound to the recording id and
 * position. A crash loses at most the last ~2 s of unflushed output; everything
 * already written still decrypts.
 */
export class SessionRecorder {
  private stream: WriteStream | null = null;
  private startMs = 0;
  private bytes = 0;
  private finalized = false;
  // SSH output arrives in arbitrary chunks, so a multi-byte UTF-8 character
  // can be split across two of them. Decoding each chunk on its own turned
  // both halves into U+FFFD; the decoder carries the partial bytes over.
  private decoder = new StringDecoder("utf8");
  readonly filePath: string;
  private readonly id: string;
  /** Own copy of the session data key (zeroed on finalize); null = plaintext. */
  private key: Buffer | null = null;
  private chunkIndex = 0;
  private pending: string[] = [];
  private pendingBytes = 0;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  /** Resolves once the file is fully written and closed (or failed). */
  readonly closed: Promise<void>;
  private markClosed!: () => void;

  private constructor(filePath: string, id: string) {
    this.filePath = filePath;
    this.id = id;
    this.closed = new Promise((resolve) => { this.markClosed = resolve; });
  }

  /**
   * Create a recorder writing to `<dir>/<id>.cast`, with the asciicast header
   * already written. `cols`/`rows` describe the initial terminal size.
   *
   * Synchronous on purpose: the caller wires it up in the same tick the SSH
   * shell opens, so not even the first bytes (MOTD, prompt) can slip past.
   */
  static create(opts: {
    dir: string;
    id: string;
    cols: number;
    rows: number;
    title?: string;
    /** Session data key: when given, the recording is written encrypted. */
    key?: Buffer;
  }): SessionRecorder {
    mkdirSync(opts.dir, { recursive: true });
    const filePath = join(opts.dir, opts.key ? `${opts.id}.cast.enc` : `${opts.id}.cast`);
    const rec = new SessionRecorder(filePath, opts.id);
    if (opts.key) {
      rec.key = Buffer.from(opts.key); // own copy: the caller may wipe theirs
      rec.flushTimer = setInterval(() => rec.flushChunk(), CHUNK_FLUSH_MS);
      rec.flushTimer.unref?.();
    }
    rec.stream = createWriteStream(filePath, { flags: "w" });
    // An I/O error (disk full, permissions) must not crash the process.
    rec.stream.on("error", () => { rec.finalized = true; rec.stream = null; rec.markClosed(); });
    rec.stream.on("close", () => rec.markClosed());
    rec.startMs = Date.now();

    const header = {
      version: 2,
      width: opts.cols || 80,
      height: opts.rows || 24,
      timestamp: Math.floor(rec.startMs / 1000),
      env: { TERM: "xterm-256color" },
      ...(opts.title ? { title: opts.title } : {}),
    };
    rec.writeLine(JSON.stringify(header));
    return rec;
  }

  private elapsed(): number {
    return Number(((Date.now() - this.startMs) / 1000).toFixed(6));
  }

  /** Record a chunk of terminal output. */
  writeOutput(chunk: Buffer): void {
    if (!this.stream || this.finalized) return;
    this.bytes += chunk.length;
    const text = this.decoder.write(chunk);
    if (text) this.writeLine(JSON.stringify([this.elapsed(), "o", text]));
  }

  /** Record a terminal resize so playback reflows exactly as the session did. */
  writeResize(cols: number, rows: number): void {
    if (!this.stream || this.finalized) return;
    this.writeLine(JSON.stringify([this.elapsed(), "r", `${cols}x${rows}`]));
  }

  private writeLine(line: string): void {
    if (this.key) {
      this.pending.push(line + "\n");
      this.pendingBytes += line.length + 1;
      if (this.pendingBytes >= CHUNK_BYTES) this.flushChunk();
      return;
    }
    try { this.stream?.write(line + "\n"); }
    catch { /* best-effort; never throw into the session path */ }
  }

  /** Seal whatever is pending into the next chunk of the encrypted file. */
  private flushChunk(): void {
    if (!this.key || !this.stream || this.pending.length === 0) return;
    const plain = Buffer.from(this.pending.join(""), "utf8");
    this.pending = [];
    this.pendingBytes = 0;
    try { this.stream.write(sealChunk(this.key, this.chunkIndex++, `recording:${this.id}`, plain)); }
    catch { /* best-effort; never throw into the session path */ }
  }

  /** Close the recording file. Returns duration (s) and output byte count. */
  finalize(): { durationMs: number; bytes: number } {
    const durationMs = Date.now() - this.startMs;
    if (!this.finalized && this.stream) {
      const tail = this.decoder.end();
      if (tail) this.writeLine(JSON.stringify([this.elapsed(), "o", tail]));
      this.flushChunk();
      if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null; }
      this.finalized = true;
      try { this.stream.end(); } catch { /* ignore */ }
      this.stream = null;
      this.key?.fill(0);
    }
    return { durationMs, bytes: this.bytes };
  }
}
