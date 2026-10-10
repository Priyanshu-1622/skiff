import type { Client } from "ssh2";
import { StringDecoder } from "node:string_decoder";

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/**
 * Run one command on its own exec channel and return what it printed, or null
 * if it could not run, errored, or did not finish within `timeoutMs` (the
 * channel is then closed). Never throws.
 */
export function execOnce(ssh: Pick<Client, "exec">, command: string, timeoutMs: number): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let finished = false;
    let stream: { close?: () => void } | null = null;
    const finish = (value: string | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (value === null) { try { stream?.close?.(); } catch { /* already gone */ } }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      ssh.exec(command, (err, execStream) => {
        if (err || !execStream) return finish(null);
        // exec() can open its channel after the deadline already fired.
        if (finished) { try { execStream.close(); } catch { /* already gone */ } return; }
        stream = execStream;
        const decoder = new StringDecoder("utf8");
        let bytes = 0;
        let out = "";
        execStream.on("data", (d: Buffer) => {
          if (finished) return;
          bytes += d.length;
          if (bytes > MAX_OUTPUT_BYTES) { finish(null); return; }
          out += decoder.write(d);
        });
        execStream.on("close", (code: number | undefined, signal: string | undefined) =>
          finish(signal || (code !== undefined && code !== 0) ? null : out + decoder.end()));
        execStream.on("error", () => finish(null));
      });
    } catch {
      finish(null);
    }
  });
}
