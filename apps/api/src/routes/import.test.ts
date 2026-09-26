import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSSHConfig } from "./import.js";

test("basic hosts with the usual keywords", () => {
  const hosts = parseSSHConfig(`
Host prod
  HostName 10.0.0.5
  User deploy
  Port 2222
  IdentityFile ~/.ssh/prod
`);
  assert.deepEqual(hosts, [{ alias: "prod", hostname: "10.0.0.5", port: 2222, user: "deploy", identityFile: "~/.ssh/prod" }]);
});

test("a Match block does not leak into the host above it", () => {
  const hosts = parseSSHConfig(`
Host web
  HostName web.example.com
Match host *.internal
  User admin
  Port 2200
`);
  assert.equal(hosts.length, 1);
  assert.equal(hosts[0]!.user, null);
  assert.equal(hosts[0]!.port, null);
});

test("several aliases on one Host line each become a host; patterns are skipped", () => {
  const hosts = parseSSHConfig(`
Host alpha beta *.corp !gamma
  User ops
`);
  assert.deepEqual(hosts.map((h) => h.alias), ["alpha", "beta"]);
  assert.ok(hosts.every((h) => h.user === "ops"));
});

test("Key=value syntax, quotes, case, and CRLF line endings", () => {
  const hosts = parseSSHConfig('host "box"\r\n  HOSTNAME=10.1.1.1\r\n  user = "me"\r\n  port=22\r\n');
  assert.deepEqual(hosts, [{ alias: "box", hostname: "10.1.1.1", port: 22, user: "me", identityFile: null }]);
});

test("the first value wins, like ssh; invalid ports are ignored", () => {
  const hosts = parseSSHConfig(`
Host a
  User first
  User second
  Port 99999
`);
  assert.equal(hosts[0]!.user, "first");
  assert.equal(hosts[0]!.port, null);
});

test("an alias repeated in a later block is kept once", () => {
  const hosts = parseSSHConfig(`
Host dup
  HostName one
Host dup
  HostName two
`);
  assert.equal(hosts.length, 1);
  assert.equal(hosts[0]!.hostname, "one");
});
