import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { hostKeyFingerprint, hostKeyType, legacyHostKeyId } from "./host-key.js";

const require = createRequire(import.meta.url);
const { utils } = require("ssh2");

// A real ed25519 public key and the fingerprint `ssh-keygen -lf` printed for
// it — checked against the reference tool, not against our own arithmetic.
const PUB = "AAAAC3NzaC1lZDI1NTE5AAAAILHMDi/Z9UsedNm8GMFoktSNZV4kyEMPl5YKBt+Ktpsz";
const OPENSSH_FP = "SHA256:OqIRFu+zfAe4D50DvaFqy4BeuS9ZbV5U4++HT4UGaKg";

test("fingerprint matches the OpenSSH SHA256 format", () => {
  const fp = hostKeyFingerprint(Buffer.from(PUB, "base64"));
  assert.equal(fp, OPENSSH_FP);
  assert.match(fp, /^SHA256:[A-Za-z0-9+/]{43}$/); // 32 bytes → 43 chars, no padding
});

test("key type is read from the blob", () => {
  assert.equal(hostKeyType(Buffer.from(PUB, "base64")), "ssh-ed25519");
  const rsa = utils.parseKey(utils.generateKeyPairSync("rsa", { bits: 2048 }).public);
  assert.equal(hostKeyType(rsa.getPublicSSH()), "ssh-rsa");
  assert.equal(hostKeyType(Buffer.from("junk")), "unknown");
});

test("legacy id is the old whole-key format", () => {
  const raw = Buffer.from(PUB, "base64");
  assert.equal(legacyHostKeyId(raw), "SHA256:" + PUB);
  assert.notEqual(legacyHostKeyId(raw), hostKeyFingerprint(raw));
});
