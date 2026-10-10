import { test } from "node:test";
import assert from "node:assert/strict";
import type { Client } from "ssh2";
import { SftpReader } from "./sftp-reader.js";
import { MAX_TRACKED_BYTES } from "./diff.js";

test("a channel that opens after the SFTP deadline is closed", async () => {
  let callback: Function | undefined;
  let ended = 0;
  const reader = new SftpReader({ sftp: (cb: Function) => { callback = cb; } } as unknown as Pick<Client, "sftp">);
  assert.deepEqual(await reader.read("/tmp/a"), { kind: "error" });
  callback!(undefined, { end() { ended++; } });
  assert.equal(ended, 1);
  reader.close();
});

test("a file that grows between stat and read is rejected", async () => {
  const channel = {
    stat(_path: string, cb: Function) { cb(undefined, { size: 1, isFile: () => true }); },
    readFile(_path: string, cb: Function) { cb(undefined, Buffer.alloc(MAX_TRACKED_BYTES + 1)); },
    end() {},
  };
  const reader = new SftpReader({ sftp: (cb: Function) => cb(undefined, channel) } as unknown as Pick<Client, "sftp">);
  assert.deepEqual(await reader.read("/tmp/a"), { kind: "too-large", size: MAX_TRACKED_BYTES + 1 });
  reader.close();
});
