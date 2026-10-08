import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryIndex, toMatchQuery, OUTPUT_INDEX_CAP_CHARS, type IndexDoc } from "./index.js";

function doc(n: number, over: Partial<IndexDoc> = {}): IndexDoc {
  return {
    rowid: n, id: `m${n}`, hostId: "h1", startedAt: new Date(2026, 8, 1, 0, n).toISOString(), finishedAt: new Date(2026, 8, 1, 0, n, 5).toISOString(),
    exitCode: null, confidence: "screen", flags: [], ended: "exited", command: "ls", cwd: "/home/u", output: "", userId: null, username: null, ...over,
  };
}

test("finds a command by a word in it, newest first, and returns timeline-shaped hits with no output", () => {
  const ix = new MemoryIndex();
  ix.add(doc(1, { command: "sudo certbot renew --dry-run", output: "all renewals succeeded" }));
  ix.add(doc(2, { command: "certbot certificates" }));
  const hits = ix.search("certbot");
  assert.deepEqual(hits.map((h) => h.id), ["m2", "m1"]);
  assert.equal("output" in hits[0], false);
  assert.equal(hits[1].command, "sudo certbot renew --dry-run");
  ix.close();
});

test("a flag is findable without its leading dashes, and an IP by its full address", () => {
  const ix = new MemoryIndex();
  ix.add(doc(1, { command: "certbot renew --dry-run" }));
  ix.add(doc(2, { command: "ping 192.168.1.5" }));
  assert.deepEqual(ix.search("dry-run").map((h) => h.id), ["m1"]);
  assert.deepEqual(ix.search("192.168.1.5").map((h) => h.id), ["m2"]);
  ix.close();
});

test("the last term matches as a prefix while typing", () => {
  const ix = new MemoryIndex();
  ix.add(doc(1, { command: "systemctl restart nginx" }));
  assert.deepEqual(ix.search("systemctl rest").map((h) => h.id), ["m1"]);
  ix.close();
});

test("output is only searched when asked, and only the capped head+tail is indexed", () => {
  const ix = new MemoryIndex();
  ix.add(doc(1, { command: "cat log", output: "the needle is here" }));
  assert.deepEqual(ix.search("needle").map((h) => h.id), []);
  assert.deepEqual(ix.search("needle", { includeOutput: true }).map((h) => h.id), ["m1"]);
  const big = "HEADWORD " + "x ".repeat(OUTPUT_INDEX_CAP_CHARS) + " TAILWORD";
  ix.add(doc(2, { command: "cat big", output: big }));
  assert.deepEqual(ix.search("HEADWORD", { includeOutput: true }).map((h) => h.id), ["m2"]);
  assert.deepEqual(ix.search("TAILWORD", { includeOutput: true }).map((h) => h.id), ["m2"]);
  ix.close();
});

test("filters: host, failed only, since", () => {
  const ix = new MemoryIndex();
  ix.add(doc(1, { command: "make build", hostId: "h1", exitCode: 0 }));
  ix.add(doc(2, { command: "make test", hostId: "h2", exitCode: 2 }));
  ix.add(doc(3, { command: "make deploy", hostId: "h1", exitCode: 1 }));
  assert.deepEqual(ix.search("make", { hostId: "h1" }).map((h) => h.id), ["m3", "m1"]);
  assert.deepEqual(ix.search("make", { failedOnly: true }).map((h) => h.id), ["m3", "m2"]);
  assert.deepEqual(ix.search("make", { since: doc(3).startedAt }).map((h) => h.id), ["m3"]);
  ix.close();
});

test("limit caps results; watermark tracks the highest rowid added or skipped", () => {
  const ix = new MemoryIndex();
  for (let i = 1; i <= 5; i++) ix.add(doc(i, { command: "echo hi" }));
  assert.equal(ix.search("echo", { limit: 2 }).length, 2);
  assert.equal(ix.watermark, 5);
  ix.skip(9);
  assert.equal(ix.watermark, 9);
  assert.equal(ix.size(), 5);
  ix.close();
});

test("odd input never throws and never changes meaning", () => {
  const ix = new MemoryIndex();
  ix.add(doc(1, { command: "echo AND NEAR hello" }));
  for (const q of ['"', '"unterminated', "*", "(", ")", "AND", "OR", "NOT", "NEAR", "-", "--", "a:b", "{", "}", "^", "   ", "", "x".repeat(5000)]) {
    assert.doesNotThrow(() => ix.search(q), `query ${JSON.stringify(q.slice(0, 20))}`);
  }
  assert.deepEqual(ix.search("AND").map((h) => h.id), ["m1"], "an operator word is just a word");
  assert.deepEqual(ix.search("   "), []);
  ix.close();
});

test("toMatchQuery quotes every term, prefixes the last, and returns null for nothing searchable", () => {
  assert.equal(toMatchQuery("certbot renew", false), '{command cwd} : ("certbot" "renew"*)');
  assert.equal(toMatchQuery("certbot", true), '("certbot"*)');
  assert.equal(toMatchQuery('say "hi"', false), '{command cwd} : ("say" "hi"*)');
  assert.equal(toMatchQuery("   ", false), null);
  assert.equal(toMatchQuery('""', false), null);
});

test("remove deletes an entry from search and size, and reports whether it was indexed", () => {
  const ix = new MemoryIndex();
  ix.add(doc(1, { command: "echo secret-token" }));
  ix.add(doc(2, { command: "echo fine" }));
  assert.equal(ix.remove("m1"), true);
  assert.deepEqual(ix.search("secret"), []);
  assert.equal(ix.size(), 1);
  assert.equal(ix.remove("m1"), false, "already gone");
  assert.equal(ix.remove("nope"), false);
  ix.close();
});

test("remove resets the watermark to the highest remaining rowid, so a reused rowid is indexed again", () => {
  const ix = new MemoryIndex();
  ix.add(doc(1)); ix.add(doc(2)); ix.add(doc(3));
  assert.equal(ix.watermark, 3);
  ix.remove("m3");
  assert.equal(ix.watermark, 2, "SQLite reuses rowid 3 for the next entry; catch-up must not skip it");
  ix.add(doc(3, { id: "m3b", command: "uname -a" }));
  assert.deepEqual(ix.search("uname").map((h) => h.id), ["m3b"]);
  const empty = new MemoryIndex();
  empty.add(doc(5)); empty.remove("m5");
  assert.equal(empty.watermark, 0);
  empty.close(); ix.close();
});

test("remove of an id that was never indexed still resets a skip-advanced watermark", () => {
  const ix = new MemoryIndex();
  ix.add(doc(1));
  ix.skip(2); // row 2 was unreadable, so the watermark moved past it
  assert.equal(ix.watermark, 2);
  ix.remove("not-indexed"); // row 2 is later deleted from the database
  assert.equal(ix.watermark, 1);
  ix.close();
});

test("hits carry who ran the command", () => {
  const ix = new MemoryIndex();
  ix.add(doc(1, { command: "make", userId: "u1", username: "bob" }));
  const hit = ix.search("make")[0];
  assert.equal(hit.userId, "u1");
  assert.equal(hit.username, "bob");
  ix.close();
});

test("filters: several hosts, one person, and a before cursor", () => {
  const ix = new MemoryIndex();
  ix.add(doc(1, { command: "make a", hostId: "h1", userId: "u1" }));
  ix.add(doc(2, { command: "make b", hostId: "h2", userId: "u2" }));
  ix.add(doc(3, { command: "make c", hostId: "h3", userId: "u1" }));
  assert.deepEqual(ix.search("make", { hostIds: ["h1", "h3"] }).map((h) => h.id), ["m3", "m1"]);
  assert.deepEqual(ix.search("make", { hostIds: [] }).map((h) => h.id), ["m3", "m2", "m1"], "an empty list means no host filter");
  assert.deepEqual(ix.search("make", { hostIds: ["nope", ""] }), []);
  assert.deepEqual(ix.search("make", { hostIds: [""] }), [], "a list of only empty ids matches nothing rather than everything");
  assert.deepEqual(ix.search("make", { userId: "u1" }).map((h) => h.id), ["m3", "m1"]);
  assert.deepEqual(ix.search("make", { before: doc(3).startedAt }).map((h) => h.id), ["m2", "m1"]);
  ix.close();
});

test("browse lists everything matching the filters newest first when the query is empty; without browse an empty query is empty", () => {
  const ix = new MemoryIndex();
  ix.add(doc(1, { command: "alpha", hostId: "h1" }));
  ix.add(doc(2, { command: "beta", hostId: "h2" }));
  ix.add(doc(3, { command: "gamma", hostId: "h1" }));
  assert.deepEqual(ix.search("", { browse: true }).map((h) => h.id), ["m3", "m2", "m1"]);
  assert.deepEqual(ix.search("   ", { browse: true, hostIds: ["h1"] }).map((h) => h.id), ["m3", "m1"]);
  assert.deepEqual(ix.search("", { browse: true, limit: 2, before: doc(3).startedAt }).map((h) => h.id), ["m2", "m1"]);
  assert.deepEqual(ix.search(""), []);
  assert.deepEqual(ix.search("alp", { browse: true }).map((h) => h.id), ["m1"], "a real query still searches under browse");
  ix.close();
});

test("entries that share a timestamp are not lost across a before cursor", () => {
  const ix = new MemoryIndex();
  const t = new Date(2026, 8, 1, 1, 0).toISOString();
  ix.add(doc(1, { command: "same a", startedAt: t }));
  ix.add(doc(2, { command: "same b", startedAt: t }));
  ix.add(doc(3, { command: "same c", startedAt: t }));
  const first = ix.search("same", { limit: 2 });
  assert.equal(first.length, 2);
  const last = first[first.length - 1];
  const second = ix.search("same", { limit: 2, before: last.startedAt, beforeId: last.id });
  assert.deepEqual([...first, ...second].map((h) => h.id).sort(), ["m1", "m2", "m3"]);
  assert.equal(second.length, 1, "no repeats across the boundary");
  ix.close();
});
