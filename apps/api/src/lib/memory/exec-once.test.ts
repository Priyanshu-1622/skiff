import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execOnce } from "./exec-once.js";

function channel() {
  const stream = new EventEmitter() as EventEmitter & { close(): void; closed: boolean };
  stream.closed = false;
  stream.close = () => { stream.closed = true; };
  return stream;
}

test("an exec channel opened after its deadline is immediately closed", async () => {
  let callback: any;
  const result = await execOnce({ exec: ((_cmd: string, cb: any) => { callback = cb; }) as any }, "probe", 5);
  assert.equal(result, null);
  const stream = channel();
  callback(undefined, stream);
  assert.equal(stream.closed, true);
});

test("exec output keeps UTF-8 characters split across SSH chunks", async () => {
  const stream = channel();
  const result = execOnce({ exec: ((_cmd: string, cb: any) => cb(undefined, stream)) as any }, "probe", 1000);
  const bytes = Buffer.from("host-雪");
  stream.emit("data", bytes.subarray(0, bytes.length - 1));
  stream.emit("data", bytes.subarray(bytes.length - 1));
  stream.emit("close", 0);
  assert.equal(await result, "host-雪");
});

test("failed exec commands are not mistaken for successful empty output", async () => {
  const stream = channel();
  const result = execOnce({ exec: ((_cmd: string, cb: any) => cb(undefined, stream)) as any }, "probe", 1000);
  stream.emit("close", 1);
  assert.equal(await result, null);
});

test("exec output is bounded even before its time limit expires", async () => {
  const stream = channel();
  const result = execOnce({ exec: ((_cmd: string, cb: any) => cb(undefined, stream)) as any }, "probe", 1000);
  stream.emit("data", Buffer.alloc(5 * 1024 * 1024, 120));
  stream.emit("close", 0);
  assert.equal(await result, null);
  assert.equal(stream.closed, true);
});
