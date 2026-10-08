export type GateResult = "marker" | "timeout" | "overflow" | "gone";

/**
 * Holds a session's output back while Skiff types a line into the shell (Precise
 * mode), so the echo of that line never reaches the screen, the server mirror,
 * the recording or the capture engine.
 *
 * Everything is held until `marker` shows up. Then it passes on `prefix` plus
 * the bytes from the marker onwards (everything before it — the echo — is
 * dropped), and the gate becomes transparent. If the marker never comes,
 * `timeout()` releases exactly what was held so the user sees what the shell
 * said; holding more than `maxHeldBytes` releases it too (fail open).
 * It resolves exactly once.
 */
export class OutputGate {
  private held: Buffer[] = [];
  private heldBytes = 0;
  private done = false;

  constructor(
    private readonly marker: Buffer,
    private readonly prefix: Buffer,
    private readonly maxHeldBytes: number,
    private readonly onDone: (result: GateResult) => void,
  ) {}

  get active(): boolean {
    return !this.done;
  }

  /** The bytes to pass on for this chunk (possibly none). */
  push(chunk: Buffer): Buffer {
    if (this.done) return chunk;
    this.held.push(chunk);
    this.heldBytes += chunk.length;
    const all = Buffer.concat(this.held);
    const at = all.indexOf(this.marker);
    if (at >= 0) {
      this.finish("marker");
      return Buffer.concat([this.prefix, all.subarray(at)]);
    }
    if (this.heldBytes > this.maxHeldBytes) {
      this.finish("overflow");
      return all;
    }
    return Buffer.alloc(0);
  }

  /** Give up waiting: release everything held, unchanged. */
  timeout(): Buffer {
    if (this.done) return Buffer.alloc(0);
    const all = Buffer.concat(this.held);
    this.finish("timeout");
    return all;
  }

  /** The session ended: drop what was held. */
  abort(): void {
    if (this.done) return;
    this.finish("gone");
  }

  private finish(result: GateResult): void {
    this.done = true;
    this.held = [];
    this.heldBytes = 0;
    this.onDone(result);
  }
}
