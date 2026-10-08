import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { generateEd25519 } from "./ssh-keys.js";

const require = createRequire(import.meta.url);
const { utils, Server } = require("ssh2");

test("generateEd25519 always returns a key ssh2 can parse and a Server accepts (the raw generator fails about 1 in 250)", () => {
  for (let i = 0; i < 2000; i++) {
    const pair = generateEd25519(utils);
    assert.ok(!(utils.parseKey(pair.private) instanceof Error), `key ${i} must parse`);
    assert.doesNotThrow(() => new Server({ hostKeys: [pair.private] }, () => {}), `key ${i} must be accepted by Server`);
  }
});

test("generateEd25519 retries past an unparseable key and gives up loudly if the generator never recovers", () => {
  const good = utils.generateKeyPairSync("ed25519");
  let calls = 0;
  const flaky = {
    generateKeyPairSync: () => (++calls < 3 ? { private: "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n", public: "x" } : good),
    parseKey: utils.parseKey,
  };
  assert.equal(generateEd25519(flaky).private, good.private);
  assert.equal(calls, 3);

  const broken = {
    generateKeyPairSync: () => ({ private: "not a key", public: "x" }),
    parseKey: utils.parseKey,
  };
  assert.throws(() => generateEd25519(broken), /parseable ed25519 key/);
});

test("generateEd25519 passes passphrase options through and still verifies the key", () => {
  const pair = generateEd25519(utils, { passphrase: "open-sesame", cipher: "aes256-cbc" });
  assert.ok(!(utils.parseKey(pair.private, "open-sesame") instanceof Error));
  assert.ok(utils.parseKey(pair.private) instanceof Error, "it really is encrypted");
});
