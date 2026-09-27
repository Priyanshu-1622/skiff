import { StringDecoder } from "node:string_decoder";
import type { TermMirror } from "../term-mirror.js";
import { Osc133Parser, type OscMarker } from "./osc133.js";
import { redact } from "./redact.js";

export interface CommandEvent {
  command: string;
  exitCode: number | null;
  cwd: string | null;
  confidence: "marker" | "screen";
  flags: string[];
  output: string;
  outputBytes: number;
  outputPruned: boolean;
  ended: "exited" | "running";
}

const MAX_HEAD_TAIL_BYTES = 32 * 1024;
// How much of the running output we let the live proxy string grow to
// before dropping its (unneeded) middle. Generous relative to
// MAX_HEAD_TAIL_BYTES so the exact byte-accurate cut at emit time always
// has enough head and tail material to work with, regardless of how many
// multi-byte characters are involved.
const RUNNING_OUTPUT_PROXY_CHARS = MAX_HEAD_TAIL_BYTES * 8;

export function truncateHeadTail(
  text: string,
  maxBytes: number = MAX_HEAD_TAIL_BYTES,
): { text: string; totalBytes: number; pruned: boolean } {
  const totalBytes = Buffer.byteLength(text, "utf8");
  if (totalBytes <= maxBytes * 2) return { text, totalBytes, pruned: false };
  const codepoints = Array.from(text);
  const head = takeBytes(codepoints, maxBytes, "start");
  const tail = takeBytes(codepoints, maxBytes, "end");
  return { text: `${head}\n…\n${tail}`, totalBytes, pruned: true };
}

function takeBytes(codepoints: string[], maxBytes: number, from: "start" | "end"): string {
  const ordered = from === "start" ? codepoints : [...codepoints].reverse();
  const out: string[] = [];
  let bytes = 0;
  for (const ch of ordered) {
    const b = Buffer.byteLength(ch, "utf8");
    if (bytes + b > maxBytes) break;
    bytes += b;
    out.push(ch);
  }
  return from === "start" ? out.join("") : out.reverse().join("");
}

// DEC private-mode alternate-screen toggles (47/1047/1049, set/reset).
const ALT_SCREEN_TOGGLE = /\x1b\[\?(?:47|1047|1049)[hl]/;

type Phase =
  | { name: "idle" }
  | { name: "typing"; promptEndX: number; promptRow: number; promptPrefix: string }
  | {
      name: "running";
      command: string;
      cwd: string | null;
      confidence: "marker" | "screen";
      output: string;
      outputBytes: number;
      flags: string[];
      promptPrefix: string;
    };

/**
 * Turns a live session's raw input/output bytes into CommandEvents.
 *
 * Both modes share one rule: a command's text is whatever sits to the
 * right of the cursor column recorded the moment its first keystroke
 * arrived (before that keystroke's echo has even come back) — that
 * column, together with the absolute row recorded at the same moment
 * (`promptRow`), is enough to read the command back later via
 * `TermMirror.lineStartingAt()`, which follows wrapped continuation rows
 * so a command that wraps past one terminal row is still read in full.
 * Marker mode (OSC 133 present) uses that same split but gets its *end*
 * signal from 133;C/D instead of guessing from the next keystroke. Never
 * stores raw keystrokes: only the single byte needed to detect Enter and
 * "first keystroke of a new command".
 *
 * Screen mode's end signal — "a keystroke arrived while a command was
 * running" — is not by itself enough: input meant for the running program
 * (a password prompt, `less`, anything interactive) also arrives as
 * keystrokes. Each `typing` phase remembers the exact prompt text
 * (`promptPrefix`) it started at; a later keystroke only ends the command
 * if the screen currently shows that SAME prefix again — otherwise it's
 * routed to the program, not treated as the start of a new command. This
 * also naturally excludes Ctrl-C/D/Z, which are explicitly never treated
 * as starting a command.
 *
 * Owns `mirror`: onOutput() processes its Osc133Parser tokens one at a
 * time — write, flush, *then* read mirror state for the marker that
 * follows — never flushing a whole multi-marker chunk at once and reading
 * stale state for an earlier marker in it.
 */
export class CaptureEngine {
  readonly events: CommandEvent[] = [];
  private readonly osc = new Osc133Parser();
  private readonly inputDecoder = new StringDecoder("utf8");
  private readonly outputDecoder = new StringDecoder("utf8");
  private phase: Phase = { name: "idle" };
  private cwd: string | null = null;
  private sawCommandMarkers = false;
  private pendingSplitX: number | null = null;

  constructor(private readonly mirror: TermMirror) {}

  onInput(data: Buffer | string): void {
    const text = typeof data === "string" ? data : this.inputDecoder.write(data);
    for (const ch of text) this.onInputByte(ch);
  }

  private onInputByte(ch: string): void {
    const isEnter = ch === "\r" || ch === "\n";
    const isControl = ch === "\x03" || ch === "\x04" || ch === "\x1a"; // Ctrl-C/D/Z: never the start of a command
    if (this.phase.name === "idle") {
      if (isEnter || isControl) return;
      this.beginTyping();
      return;
    }
    if (this.phase.name === "typing") {
      if (isEnter) this.pendingSplitX = this.phase.promptEndX;
      return;
    }
    if (this.phase.name === "running" && this.phase.confidence === "screen" && !isEnter && !isControl) {
      // A keystroke only means "the prompt returned" if the screen
      // currently shows the SAME prompt text this command started at;
      // otherwise it's input going to the running program itself (spec
      // §5: "a line that doesn't begin at a detected prompt isn't a
      // command", e.g. "[sudo] password:").
      const candidateX = this.mirror.cursorX();
      const candidatePrefix = this.mirror.cursorLine().slice(0, candidateX);
      if (candidatePrefix === this.phase.promptPrefix) {
        this.finishScreenCommand();
        this.beginTyping();
      }
    }
  }

  private beginTyping(): void {
    const promptEndX = this.mirror.cursorX();
    const promptRow = this.mirror.cursorRow();
    const promptPrefix = this.mirror.cursorLine().slice(0, promptEndX);
    this.phase = { name: "typing", promptEndX, promptRow, promptPrefix };
  }

  async onOutput(data: Buffer | string): Promise<void> {
    const text = typeof data === "string" ? data : this.outputDecoder.write(data);
    for (const token of this.osc.feed(text)) {
      if ("write" in token) {
        await this.applyWrite(token.write);
      } else {
        this.applyMarker(token.marker);
      }
    }
  }

  private async applyWrite(text: string): Promise<void> {
    if (!this.sawCommandMarkers && this.phase.name === "typing" && this.pendingSplitX !== null) {
      const m = /\r?\n/.exec(text);
      if (m) {
        const cut = m.index + m[0].length;
        await this.applyWriteRaw(text.slice(0, cut));
        this.startScreenCommand();
        const rest = text.slice(cut);
        if (rest) await this.applyWrite(rest); // now under "running" (or further typing, uncommonly)
        return;
      }
    }
    if (this.phase.name === "running") {
      const m = ALT_SCREEN_TOGGLE.exec(text);
      if (m) {
        // Cut around the toggle itself so content before it is judged by
        // the OLD alt-screen state and content after by the NEW one —
        // entering and leaving alt-screen within a single chunk must not
        // let the content in between slip through as regular output.
        if (m.index > 0) await this.applyWriteRaw(text.slice(0, m.index));
        await this.applyWriteRaw(text.slice(m.index, m.index + m[0].length));
        const rest = text.slice(m.index + m[0].length);
        if (rest) await this.applyWrite(rest);
        return;
      }
    }
    await this.applyWriteRaw(text);
  }

  private async applyWriteRaw(text: string): Promise<void> {
    this.mirror.write(text);
    await this.mirror.flush();
    const altScreen = this.mirror.isAltScreen();
    if (this.phase.name === "running") {
      if (altScreen && !this.phase.flags.includes("fullscreen")) {
        this.phase.flags.push("fullscreen");
      } else if (!altScreen && !this.phase.flags.includes("fullscreen")) {
        this.appendOutput(this.phase, text);
      }
    }
  }

  /** Bounds the live proxy string's retained size regardless of how much output actually arrives; the exact byte-accurate head/tail cut happens once, at emit time, from this (already small) proxy. */
  private appendOutput(phase: Extract<Phase, { name: "running" }>, text: string): void {
    phase.outputBytes += Buffer.byteLength(text, "utf8");
    const combined = phase.output + text;
    phase.output =
      combined.length <= RUNNING_OUTPUT_PROXY_CHARS
        ? combined
        : combined.slice(0, MAX_HEAD_TAIL_BYTES * 2) + combined.slice(-MAX_HEAD_TAIL_BYTES * 2);
  }

  end(): void {
    if (this.phase.name === "running") {
      const p = this.phase;
      this.pushEvent(p.command, null, p.cwd, p.confidence, p.flags, p.output, p.outputBytes, "running");
      this.phase = { name: "idle" };
    }
  }

  private applyMarker(m: OscMarker): void {
    this.sawCommandMarkers = this.sawCommandMarkers || m.type !== "cwd";
    switch (m.type) {
      case "cwd":
        this.cwd = m.path;
        break;
      case "prompt_start":
      case "command_start":
        break; // the exact split point comes from onInput's promptEndX, not A/B
      case "command_executed": {
        // Only a legitimate transition if the user actually typed
        // something and pressed Enter (phase "typing" with a pending
        // split). A spurious/duplicate C — the real probe corpus fires
        // one right before every D, and once before anything was typed —
        // arrives while phase is "idle" or already "running"; ignore it.
        if (this.phase.name !== "typing" || this.pendingSplitX === null) break;
        const splitX = this.pendingSplitX;
        const command = this.mirror.lineStartingAt(this.phase.promptRow).slice(splitX);
        this.pendingSplitX = null;
        if (command.trim() === "") {
          // Typed then erased back to nothing (e.g. backspaced away), or a
          // blank Enter the shell's own hooks still fired markers around —
          // there is no real command here to track.
          this.phase = { name: "idle" };
          break;
        }
        this.phase = {
          name: "running",
          command,
          cwd: this.cwd,
          confidence: "marker",
          output: "",
          outputBytes: 0,
          flags: [],
          promptPrefix: this.phase.promptPrefix,
        };
        break;
      }
      case "command_finished": {
        if (this.phase.name !== "running") break;
        const p = this.phase;
        this.pushEvent(p.command, m.exitCode, p.cwd, "marker", p.flags, p.output, p.outputBytes, "exited");
        this.phase = { name: "idle" };
        break;
      }
    }
  }

  private startScreenCommand(): void {
    if (this.phase.name !== "typing" || this.pendingSplitX === null) return;
    const splitX = this.pendingSplitX;
    const { promptRow, promptPrefix } = this.phase;
    const command = this.mirror.lineStartingAt(promptRow).slice(splitX);
    this.pendingSplitX = null;
    if (command.trim() === "") {
      this.phase = { name: "idle" };
      return;
    }
    this.phase = {
      name: "running",
      command,
      cwd: this.cwd,
      confidence: "screen",
      output: "",
      outputBytes: 0,
      flags: [],
      promptPrefix,
    };
  }

  private finishScreenCommand(): void {
    if (this.phase.name !== "running") return;
    const p = this.phase;
    this.pushEvent(p.command, null, p.cwd, "screen", p.flags, p.output, p.outputBytes, "exited");
    this.phase = { name: "idle" };
  }

  private pushEvent(
    command: string,
    exitCode: number | null,
    cwd: string | null,
    confidence: "marker" | "screen",
    flags: string[],
    output: string,
    outputTotalBytes: number,
    ended: "exited" | "running",
  ): void {
    const pruned = outputTotalBytes > MAX_HEAD_TAIL_BYTES * 2;
    const { text } = truncateHeadTail(output);
    this.events.push({
      command: redact(command),
      exitCode,
      cwd,
      confidence,
      flags,
      output: redact(text),
      outputBytes: outputTotalBytes,
      outputPruned: pruned,
      ended,
    });
  }
}
