/**
 * WebSocket client for the SSH terminal.
 */

export interface TerminalMessage {
  type: "data" | "status" | "error" | "fingerprint_new" | "fingerprint_mismatch" | "pong";
  data?: string;
  message?: string;
  fingerprint?: string;
  hostname?: string;
  expected?: string;
  actual?: string;
  code?: string;
  t?: number;
}

export function createTerminalSocket(hostId: string): WebSocket {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${window.location.host}/api/terminal/${hostId}`;
  return new WebSocket(url);
}
