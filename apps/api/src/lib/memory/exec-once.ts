import type { Client } from "ssh2";

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
        stream = execStream;
        let out = "";
        execStream.on("data", (d: Buffer) => { out += d.toString(); });
        execStream.on("close", () => finish(out));
        execStream.on("error", () => finish(null));
      });
    } catch {
      finish(null);
    }
  });
}
