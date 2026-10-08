/**
 * ssh2's ed25519 key generator occasionally (about 1 key in 250) emits a
 * private key that ssh2's own parser rejects ("Malformed OpenSSH private key"),
 * so a test that builds a fake SSH server from a fresh key would fail at
 * random. Retry until the key actually parses. Test support only — excluded
 * from the build.
 */
export function generateEd25519(
  utils: { generateKeyPairSync: (type: string, opts?: any) => { private: string; public: string }; parseKey: (key: string, passphrase?: string) => unknown },
  opts?: { passphrase?: string; cipher?: string },
): { private: string; public: string } {
  for (let attempt = 0; attempt < 25; attempt++) {
    const pair = utils.generateKeyPairSync("ed25519", opts);
    const parsed = utils.parseKey(pair.private, opts?.passphrase);
    if (!(parsed instanceof Error)) return pair;
  }
  throw new Error("could not generate a parseable ed25519 key");
}
