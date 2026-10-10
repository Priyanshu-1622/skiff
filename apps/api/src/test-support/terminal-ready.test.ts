import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { waitForShellReady } from "./terminal-ready.js";

test("Connected alone is not readiness; a fragmented prompt completes it in either order", async () => {
  for (const statusFirst of [true, false]) {
    const socket = new EventEmitter();
    const send = (message: unknown) => socket.emit("message", Buffer.from(JSON.stringify(message)));
    let ready = false;
    const promise = waitForShellReady(socket).then(() => { ready = true; });
    const status = () => send({ type: "status", message: "Connected" });
    const data = (text: string) => send({ type: "data", data: Buffer.from(text).toString("base64") });
    if (statusFirst) status();
    data("$");
    await Promise.resolve();
    assert.equal(ready, false);
    data(" ");
    if (!statusFirst) status();
    await promise;
    assert.equal(ready, true);
    assert.equal(socket.listenerCount("message"), 0);
  }
});
