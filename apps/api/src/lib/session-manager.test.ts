/**
 * SessionManager unit tests.
 *
 * The manager is exercised with a fake SSH client + stream (EventEmitters)
 * so we can test the attach/detach/scrollback/reap logic without opening a
 * real SSH connection.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { SessionManager } from "./session-manager.js";

function fakeSsh() {
  const ssh: any = new EventEmitter();
  ssh.ended = false;
  ssh.end = () => { ssh.ended = true; };
  return ssh;
}

function fakeStream() {
  const stream: any = new EventEmitter();
  stream.written = [];
  stream.windows = [];
  stream.write = (b: Buffer) => { stream.written.push(b); };
  stream.setWindow = (r: number, c: number) => { stream.windows.push([r, c]); };
  return stream;
}

function register(mgr: SessionManager, id = "s1:h1") {
  const ssh = fakeSsh();
  const stream = fakeStream();
  const session = mgr.register({ id, hostId: "h1", ssh, stream });
  return { ssh, stream, session };
}

test("register then get returns the live session", () => {
  const mgr = new SessionManager();
  register(mgr);
  const s = mgr.get("s1:h1");
  assert.ok(s);
  assert.equal(s!.hostId, "h1");
  assert.equal(s!.closed, false);
});

test("output is buffered into scrollback and replayed on attach", () => {
  const mgr = new SessionManager();
  const { stream } = register(mgr);

  stream.emit("data", Buffer.from("hello "));
  stream.emit("data", Buffer.from("world"));

  const received: Buffer[] = [];
  const scrollback = mgr.attach("s1:h1", {
    send: (c) => received.push(c),
    end: () => {},
  });

  assert.equal(scrollback!.toString(), "hello world");
});

test("attached client receives live output", () => {
  const mgr = new SessionManager();
  const { stream } = register(mgr);

  const received: Buffer[] = [];
  mgr.attach("s1:h1", { send: (c) => received.push(c), end: () => {} });

  stream.emit("data", Buffer.from("live"));
  assert.equal(Buffer.concat(received).toString(), "live");
});

test("second attach boots the first client (one viewer per session)", () => {
  const mgr = new SessionManager();
  register(mgr);

  let firstEnded = "";
  mgr.attach("s1:h1", { send: () => {}, end: (r) => { firstEnded = r; } });
  mgr.attach("s1:h1", { send: () => {}, end: () => {} });

  assert.match(firstEnded, /another window/i);
});

test("detach keeps the session alive (persistence)", () => {
  const mgr = new SessionManager();
  const client = { send: () => {}, end: () => {} };
  register(mgr);
  mgr.attach("s1:h1", client);
  mgr.detach("s1:h1", client);

  // Session must still exist after the client detaches.
  assert.ok(mgr.get("s1:h1"));
  assert.equal(mgr.get("s1:h1")!.closed, false);
});

test("idle grace timer reaps a detached session", async () => {
  const mgr = new SessionManager({ idleGraceMs: 30 });
  const { ssh } = register(mgr);
  const client = { send: () => {}, end: () => {} };
  mgr.attach("s1:h1", client);
  mgr.detach("s1:h1", client);

  await new Promise((r) => setTimeout(r, 60));
  assert.equal(mgr.get("s1:h1"), undefined);
  assert.equal(ssh.ended, true);
});

test("re-attaching before grace expiry cancels the reap", async () => {
  const mgr = new SessionManager({ idleGraceMs: 40 });
  const client = { send: () => {}, end: () => {} };
  register(mgr);
  mgr.attach("s1:h1", client);
  mgr.detach("s1:h1", client);

  await new Promise((r) => setTimeout(r, 20));
  mgr.attach("s1:h1", { send: () => {}, end: () => {} }); // re-attach in time

  await new Promise((r) => setTimeout(r, 40));
  assert.ok(mgr.get("s1:h1")); // survived
});

test("write forwards input to the stream", () => {
  const mgr = new SessionManager();
  const { stream } = register(mgr);
  mgr.write("s1:h1", Buffer.from("ls -la\n"));
  assert.equal(stream.written[0].toString(), "ls -la\n");
});

test("resize forwards dimensions to the stream", () => {
  const mgr = new SessionManager();
  const { stream } = register(mgr);
  mgr.resize("s1:h1", 40, 120);
  assert.deepEqual(stream.windows[0], [40, 120]);
});

test("stream close ends the session and runs onEnd once", () => {
  const mgr = new SessionManager();
  const { stream, session } = register(mgr);
  let ends = 0;
  session.onEnd = () => { ends++; };

  stream.emit("close");
  stream.emit("close"); // second close must not double-fire

  assert.equal(mgr.get("s1:h1"), undefined);
  assert.equal(ends, 1);
});

test("onOutput hook receives every chunk (recording)", () => {
  const mgr = new SessionManager();
  const { stream, session } = register(mgr);
  const chunks: string[] = [];
  session.onOutput = (c) => chunks.push(c.toString());

  stream.emit("data", Buffer.from("a"));
  stream.emit("data", Buffer.from("b"));
  assert.deepEqual(chunks, ["a", "b"]);
});

test("scrollback is capped and keeps the most recent bytes", () => {
  const mgr = new SessionManager();
  const { stream } = register(mgr);

  // Push well past the 256 KB cap.
  const chunk = Buffer.alloc(64 * 1024, 0x41); // 'A'
  for (let i = 0; i < 6; i++) stream.emit("data", chunk);
  // Then a final distinct marker.
  stream.emit("data", Buffer.from("TAIL"));

  const scrollback = mgr.attach("s1:h1", { send: () => {}, end: () => {} })!;
  assert.ok(scrollback.length <= 256 * 1024 + 4);
  assert.ok(scrollback.toString("utf8").endsWith("TAIL"));
});

test("a session that is never attached reaps itself (orphan safety net)", async () => {
  const mgr = new SessionManager({ idleGraceMs: 30 });
  const { ssh } = register(mgr); // register but never attach
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(mgr.get("s1:h1"), undefined);
  assert.equal(ssh.ended, true);
});

test("attaching cancels the orphan safety-net timer", async () => {
  const mgr = new SessionManager({ idleGraceMs: 30 });
  register(mgr);
  mgr.attach("s1:h1", { send: () => {}, end: () => {} }); // attach in time
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(mgr.get("s1:h1")); // still alive because a client is attached
});

test("shutdown ends all sessions", () => {
  const mgr = new SessionManager();
  const a = register(mgr, "s1:h1");
  const b = register(mgr, "s2:h2");
  mgr.shutdown();
  assert.equal(a.ssh.ended, true);
  assert.equal(b.ssh.ended, true);
  assert.equal(mgr.list().length, 0);
});
