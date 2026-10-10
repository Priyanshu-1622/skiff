/** A connected transport is not necessarily a shell ready for typing. */
export function waitForShellReady(socket: any, approveHostKey = false): Promise<void> {
  return new Promise((resolve, reject) => {
    let connected = false;
    let output = "";
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onClose = () => onError(new Error("Terminal closed before the shell prompt"));
    const onMessage = (raw: Buffer) => {
      const message = JSON.parse(raw.toString());
      if (approveHostKey && message.type === "fingerprint_new") socket.send(JSON.stringify({ type: "fingerprint_approve" }));
      if (message.type === "error") return onError(new Error(message.message ?? "Terminal error"));
      if (message.type === "status" && /^(Connected|Reattached)$/.test(message.message)) connected = true;
      if (message.type === "data") output = (output + Buffer.from(message.data, "base64").toString()).slice(-8192);
      // These fixtures all use '$ '. Accumulate chunks so split prompts work,
      // and accept either order of status and initial screen delivery.
      if (connected && output.includes("$ ")) { cleanup(); resolve(); }
    };
    const timer = setTimeout(() => onError(new Error("No shell prompt within 10s")), 10_000);
    socket.on("message", onMessage);
    socket.on("error", onError);
    socket.on("close", onClose);
  });
}
