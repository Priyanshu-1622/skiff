export interface TerminalMessage {
  type: "data" | "status" | "error" | "fingerprint_new" | "fingerprint_mismatch" | "pong" | "memory" | "memory_note";
  /** For type "memory": what Memory is doing for this session. */
  state?: "remembering" | "paused" | "off" | "unavailable";
  data?: string;
  message?: string;
  fingerprint?: string;
  hostname?: string;
  expected?: string;
  actual?: string;
  code?: string;
  t?: number;
  algorithm?: string;
  canReset?: boolean;
}

export function createTerminalSocket(hostId: string): WebSocket {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${window.location.host}/api/terminal/${hostId}`;
  return new WebSocket(url);
}
