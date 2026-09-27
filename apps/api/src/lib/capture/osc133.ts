export type OscMarker =
  | { type: "prompt_start" }
  | { type: "command_start" }
  | { type: "command_executed" }
  | { type: "command_finished"; exitCode: number | null }
  | { type: "cwd"; path: string };

export type OscToken = { write: string } | { marker: OscMarker };

// Bounds how long we'll hold an unterminated sequence waiting for its
// terminator before giving up and resuming the scan — a malformed or
// hostile stream must not grow this buffer forever.
const MAX_PENDING = 4096;

function parseBody(body: string): OscMarker | null {
  if (body.startsWith("133;")) {
    const parts = body.slice(4).split(";");
    switch (parts[0]) {
      case "A": return { type: "prompt_start" };
      case "B": return { type: "command_start" };
      case "C": return { type: "command_executed" };
      case "D": {
        const raw = parts[1];
        const exitCode = raw !== undefined && /^-?\d+$/.test(raw) ? Number(raw) : null;
        return { type: "command_finished", exitCode };
      }
      default:
        return null;
    }
  }
  if (body.startsWith("7;")) {
    const m = /^7;file:\/\/[^/]*(\/.*)$/.exec(body);
    const path = m?.[1];
    return path ? { type: "cwd", path } : null;
  }
  return null;
}

/**
 * Incrementally tokenizes raw terminal output into plain-text runs and
 * recognized OSC 133/7 markers, in the order they occurred — never just a
 * flat list of markers, because CaptureEngine needs to write each text run
 * into its mirror and let it settle *before* trusting a marker that came
 * right after it (see engine.ts's module comment).
 */
export class Osc133Parser {
  private pending = "";

  feed(chunk: Buffer | string): OscToken[] {
    const buf = this.pending + (typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    const tokens: OscToken[] = [];
    let pos = 0;

    for (;;) {
      const start = buf.indexOf("\x1b]", pos);
      if (start === -1) {
        // Keep a trailing lone ESC: the next chunk might start with ']'.
        const keepTail = buf.endsWith("\x1b");
        const emitEnd = keepTail ? buf.length - 1 : buf.length;
        if (emitEnd > pos) tokens.push({ write: buf.slice(pos, emitEnd) });
        this.pending = keepTail ? "\x1b" : "";
        return tokens;
      }

      // A real terminal ends an OSC string at BEL or ST (ESC \) normally,
      // but ALSO aborts it — without consuming the aborting byte — on any
      // other ESC (so that ESC can start its own sequence right after),
      // and aborts-and-consumes on CAN/SUB. Only searching for BEL/ST (as
      // an earlier version of this parser did) would treat any other
      // escape sequence appearing before the next BEL/ST as still "inside"
      // the OSC body, silently discarding visible text a real terminal
      // would have rendered.
      let bodyEnd = -1;
      let consumedEnd = -1;
      let aborted = false;
      for (let i = start + 2; i < buf.length; i++) {
        const c = buf.charCodeAt(i);
        if (c === 0x07) { bodyEnd = i; consumedEnd = i + 1; break; }
        if (c === 0x1b) {
          if (buf[i + 1] === "\\") { bodyEnd = i; consumedEnd = i + 2; break; }
          if (i + 1 === buf.length) break; // could still become ST; wait for more data
          bodyEnd = i; consumedEnd = i; aborted = true; break; // not consumed: may start its own sequence
        }
        if (c === 0x18 || c === 0x1a) { bodyEnd = i; consumedEnd = i + 1; aborted = true; break; } // CAN / SUB
      }

      if (consumedEnd === -1) {
        if (start > pos) tokens.push({ write: buf.slice(pos, start) });
        let tail = buf.slice(start);
        if (tail.length > MAX_PENDING) tail = ""; // give up on a runaway malformed sequence
        this.pending = tail;
        return tokens;
      }

      if (start > pos) tokens.push({ write: buf.slice(pos, start) });
      if (!aborted) {
        const body = buf.slice(start + 2, bodyEnd);
        const marker = parseBody(body);
        if (marker) tokens.push({ marker });
      }
      pos = consumedEnd;
    }
  }
}
