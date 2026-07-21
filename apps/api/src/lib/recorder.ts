import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Records a terminal session to disk in asciicast v2 format — the open
 * standard used by asciinema. The format is newline-delimited JSON:
 *
 *   line 1: a header object { version, width, height, timestamp, ... }
 *   line n: an event array [elapsedSeconds, "o", outputChunk]
 *
 * This is directly playable by the asciinema player (which we embed on the
 * frontend), and being a documented open format it's future-proof and
 * portable — recordings aren't locked into Skiff.
 *
 * Recording is strictly best-effort: a write failure must never disrupt the
 * live SSH session, so every call is guarded by the caller.
 */
export class SessionRecorder {
  private stream: WriteStream | null = null;
  private startMs = 0;
  private bytes = 0;
  private finalized = false;
  readonly filePath: string;

  private constructor(filePath: string) {
    this.filePath = filePath;
  }

  /**
   * Create a recorder writing to `<dir>/<id>.cast`, with the asciicast header
   * already written. `cols`/`rows` describe the initial terminal size.
   */
  static async create(opts: {
    dir: string;
    id: string;
    cols: number;
    rows: number;
    title?: string;
  }): Promise<SessionRecorder> {
    await mkdir(opts.dir, { recursive: true });
    const filePath = join(opts.dir, `${opts.id}.cast`);
    const rec = new SessionRecorder(filePath);
    rec.stream = createWriteStream(filePath, { flags: "w" });
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

  /** Record a chunk of terminal output. */
  writeOutput(chunk: Buffer): void {
    if (!this.stream || this.finalized) return;
    const elapsed = (Date.now() - this.startMs) / 1000;
    const event = [Number(elapsed.toFixed(6)), "o", chunk.toString("utf8")];
    this.bytes += chunk.length;
    this.writeLine(JSON.stringify(event));
  }

  private writeLine(line: string): void {
    try { this.stream?.write(line + "\n"); }
    catch { /* best-effort; never throw into the session path */ }
  }

  /** Close the recording file. Returns duration (s) and output byte count. */
  finalize(): { durationMs: number; bytes: number } {
    const durationMs = Date.now() - this.startMs;
    if (!this.finalized && this.stream) {
      this.finalized = true;
      try { this.stream.end(); } catch { /* ignore */ }
      this.stream = null;
    }
    return { durationMs, bytes: this.bytes };
  }
}
