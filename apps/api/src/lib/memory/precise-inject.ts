import { detectShell, PRECISE_SNIPPETS, type PreciseShell } from "./precise.js";

type GateResult = "marker" | "timeout" | "overflow" | "gone";

export interface PreciseDeps {
  /** Run a one-off command on a separate exec channel; its stdout, or null if it failed or timed out. */
  exec(command: string, timeoutMs: number): Promise<string | null>;
  /** Hold the session's output until the first prompt marker; see SessionManager.armOutputGate. Must take effect synchronously. */
  armGate(marker: Buffer, opts: { prefix: Buffer; timeoutMs: number }): Promise<GateResult>;
  /** Write straight to the shell, bypassing the input hook. False if the session is gone. */
  writeSystem(data: Buffer): boolean;
  activity: {
    /** Epoch ms of the last output from the shell, 0 if none yet. */
    lastOutputAt(): number;
    /** Has the user typed anything in this session? */
    inputSeen(): boolean;
    /** Has the shell already emitted OSC 133 markers by itself? */
    markersSeen(): boolean;
  };
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export type PreciseResult =
  | { status: "injected"; shell: PreciseShell }
  | { status: "skipped"; reason: "no-shell-info" | "unknown-shell" | "no-output" | "not-idle" | "user-typing" | "markers-already" }
  | { status: "failed"; reason: "timeout" | "overflow" | "gone"; shell: PreciseShell };

const PROMPT_MARKER = Buffer.from("\x1b]133;A");
// After the hidden echo, jump back to the start of the line and clear it so the
// new prompt replaces the old one instead of sitting next to it.
const LINE_RESET = Buffer.from("\r\x1b[2K");

/**
 * Types Precise mode's one-line setup into the user's shell — only when it is
 * safe: a supported shell (from $SHELL), idle at its first prompt, nothing
 * typed by the user yet, and no markers of its own. The session's output is
 * held from just before the line is written until the first prompt marker
 * arrives, so the echo is never shown, mirrored, recorded or captured.
 */
export async function injectPrecise(
  deps: PreciseDeps,
  opts: { quietMs?: number; maxWaitMs?: number; gateMs?: number } = {},
): Promise<PreciseResult> {
  const quietMs = opts.quietMs ?? 400;
  const maxWaitMs = opts.maxWaitMs ?? 6000;
  const gateMs = opts.gateMs ?? 3000;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const out = await deps.exec('printf %s "$SHELL"', 4000);
  if (!out || !out.trim()) return { status: "skipped", reason: "no-shell-info" };
  const shell = detectShell(out);
  if (!shell) return { status: "skipped", reason: "unknown-shell" };

  const start = now();
  for (;;) {
    if (deps.activity.inputSeen()) return { status: "skipped", reason: "user-typing" };
    const last = deps.activity.lastOutputAt();
    if (last > 0 && now() - last >= quietMs) break;
    if (now() - start >= maxWaitMs) return { status: "skipped", reason: last > 0 ? "not-idle" : "no-output" };
    await sleep(50);
  }
  if (deps.activity.markersSeen()) return { status: "skipped", reason: "markers-already" };

  const gate = deps.armGate(PROMPT_MARKER, { prefix: LINE_RESET, timeoutMs: gateMs });
  if (!deps.writeSystem(Buffer.from(PRECISE_SNIPPETS[shell] + "\n"))) return { status: "failed", reason: "gone", shell };
  const result = await gate;
  return result === "marker" ? { status: "injected", shell } : { status: "failed", reason: result, shell };
}
