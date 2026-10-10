import type { Client } from "ssh2";
import type { FileReader, ReadResult } from "./file-tracker.js";
import { MAX_TRACKED_BYTES } from "./diff.js";

const OP_TIMEOUT_MS = 5000;
const FAILURE_BACKOFF_MS = 30_000;

// The slice of ssh2's SFTPWrapper this uses (its published types are partial).
interface Sftp {
  realpath(path: string, cb: (err: Error | undefined, abs: string) => void): void;
  stat(path: string, cb: (err: (Error & { code?: number }) | undefined, stats: { size: number; isFile(): boolean }) => void): void;
  readFile(path: string, cb: (err: (Error & { code?: number }) | undefined, data: Buffer) => void): void;
  end(): void;
}

class Timeout extends Error {}

function withTimeout<T>(start: (done: (err: Error | undefined, value?: T) => void) => void, onLate?: (value: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => { settled = true; reject(new Timeout("sftp timeout")); }, OP_TIMEOUT_MS);
    try {
      start((err, value) => {
        if (settled) { if (!err && value !== undefined) onLate?.(value); return; }
        settled = true;
        clearTimeout(timer);
        if (err) reject(err); else resolve(value as T);
      });
    } catch (e) {
      settled = true;
      clearTimeout(timer);
      reject(e);
    }
  });
}

/**
 * Reads files over SFTP on the session's own SSH connection. The SFTP channel
 * is opened lazily on first use (a session that never edits a file never pays
 * for it), and a failure to open it is remembered for a while so a server
 * without SFTP isn't asked on every command.
 */
export class SftpReader implements FileReader {
  private sftp: Promise<Sftp | null> | null = null;
  private failedAt = 0;
  private homeDir: string | null | undefined;
  private closed = false;

  constructor(private readonly ssh: Pick<Client, "sftp">, private readonly now: () => number = Date.now) {}

  private open(): Promise<Sftp | null> {
    if (this.closed) return Promise.resolve(null);
    if (this.sftp) {
      return this.sftp;
    }
    if (this.failedAt && this.now() - this.failedAt < FAILURE_BACKOFF_MS) return Promise.resolve(null);
    const attempt = withTimeout<Sftp>((done) => {
      (this.ssh as { sftp(cb: (err: Error | undefined, s: Sftp) => void): void }).sftp((err, s) => done(err, s));
    }, (s) => { try { s.end(); } catch { /* already gone */ } }).then((s) => {
      if (this.closed) { try { s.end(); } catch { /* already gone */ } return null; }
      return s;
    }).catch(() => {
      this.failedAt = this.now();
      this.sftp = null;
      return null;
    });
    this.sftp = attempt;
    return attempt;
  }

  async home(): Promise<string | null> {
    if (this.homeDir !== undefined) return this.homeDir;
    const s = await this.open();
    if (!s) return null;
    try {
      this.homeDir = await withTimeout<string>((done) => s.realpath(".", (e, abs) => done(e, abs)));
    } catch {
      return null; // not cached: a later command may succeed
    }
    return this.homeDir;
  }

  async read(path: string): Promise<ReadResult> {
    const s = await this.open();
    if (!s) return { kind: "error" };
    try {
      const st = await withTimeout<{ size: number; isFile(): boolean }>((done) => s.stat(path, (e, stats) => done(e, stats)));
      if (this.closed) return { kind: "error" };
      if (!st.isFile()) return { kind: "not-file" };
      if (st.size > MAX_TRACKED_BYTES) return { kind: "too-large", size: st.size };
      const bytes = await withTimeout<Buffer>((done) => s.readFile(path, (e, data) => done(e, data)));
      if (this.closed) return { kind: "error" };
      if (bytes.length > MAX_TRACKED_BYTES) return { kind: "too-large", size: bytes.length };
      return { kind: "file", bytes, resolvedPath: path };
    } catch (e) {
      const code = (e as { code?: number }).code;
      if (code === 2) return { kind: "missing" };
      if (code === 3) return { kind: "denied" };
      return { kind: "error" };
    }
  }

  close(): void {
    this.closed = true;
    const pending = this.sftp;
    this.sftp = null;
    void pending?.then((s) => { try { s?.end(); } catch { /* already gone */ } }).catch(() => {});
  }
}
