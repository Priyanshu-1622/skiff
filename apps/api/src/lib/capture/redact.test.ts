import { test } from "node:test";
import assert from "node:assert/strict";
import { redact } from "./redact.js";

test("redacts a -p / --password flag's value", () => {
  assert.equal(redact("mysql -uroot -pHunter2!"), "mysql -uroot -p‹redacted›");
  assert.equal(redact("curl --password=Hunter2! https://x"), "curl --password=‹redacted› https://x");
  assert.equal(redact("curl --password Hunter2! https://x"), "curl --password ‹redacted› https://x");
});

test("redacts key=value style secrets", () => {
  assert.equal(redact("export TOKEN=ghp_abc123"), "export TOKEN=‹redacted›");
  assert.equal(redact("secret=sw0rdfish"), "secret=‹redacted›");
  assert.equal(redact("API_KEY=sk-abcdef"), "API_KEY=‹redacted›");
});

test("redacts an Authorization: Bearer header", () => {
  assert.equal(
    redact("Authorization: Bearer abc.def.ghi"),
    "Authorization: Bearer ‹redacted›",
  );
});

test("redacts known token formats", () => {
  assert.equal(redact("key is AKIAABCDEFGHIJKLMNOP"), "key is ‹redacted›");
  assert.equal(redact("gh_token=" + "ghp_" + "a".repeat(36)), "gh_token=‹redacted›");
  assert.equal(redact("slack " + "xoxb-111-222-abcdefghij"), "slack ‹redacted›");
  assert.equal(redact("stripe " + "sk_live_" + "a".repeat(20)), "stripe ‹redacted›");
});

test("redacts a JWT", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dQw4w9WgXcQ_dQw4w9WgXcQ";
  assert.equal(redact(`token: ${jwt}`), "token: ‹redacted›");
});

test("redacts a PEM private key block", () => {
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIB...\n-----END RSA PRIVATE KEY-----";
  assert.equal(redact(`cat id_rsa\n${pem}`), "cat id_rsa\n‹redacted›");
});

test("does not touch ordinary text that merely mentions these words", () => {
  assert.equal(redact("please change your password soon"), "please change your password soon");
  assert.equal(redact("the api is down again"), "the api is down again");
  assert.equal(redact("git log --author=me --since=2026-01-01"), "git log --author=me --since=2026-01-01");
  assert.equal(redact("ls -la /etc/secrets"), "ls -la /etc/secrets");
});

// --- Fixes from the fresh reviewer's whole-branch review (2026-09-27) ---

test("-p is only redacted for mysql-family commands, not every -p flag on any command", () => {
  // The bare -p<secret> rule with no separator is deliberately narrow to
  // mysql's own flag style; applying it to every command redacted `find
  // -print`, `cp -pr`, `ssh -p2222` and similar unrelated flags.
  assert.equal(redact("find . -print"), "find . -print");
  assert.equal(redact("find / -perm"), "find / -perm");
  assert.equal(redact("ls -pa"), "ls -pa");
  assert.equal(redact("cp -pr src dst"), "cp -pr src dst");
  assert.equal(redact("tar -pxzf archive.tar.gz"), "tar -pxzf archive.tar.gz");
  assert.equal(redact("ssh -p2222 host"), "ssh -p2222 host");
  assert.equal(redact("docker run -p8080:80 img"), "docker run -p8080:80 img");
  assert.equal(redact("gcc -pthread -pedantic main.c"), "gcc -pthread -pedantic main.c");
  // still redacted for the mysql family itself, including via sudo
  assert.equal(redact("mysql -uroot -pHunter2!"), "mysql -uroot -p‹redacted›");
  assert.equal(redact("mysqldump -uroot -pHunter2! db"), "mysqldump -uroot -p‹redacted› db");
  assert.equal(redact("sudo mysql -uroot -pHunter2!"), "sudo mysql -uroot -p‹redacted›");
});

test("redacts secrets in env-var-style names with a prefix or suffix, not just the bare word", () => {
  assert.equal(redact("export DB_PASSWORD=hunter2"), "export DB_PASSWORD=‹redacted›");
  assert.equal(redact("AWS_SECRET_ACCESS_KEY=abc123"), "AWS_SECRET_ACCESS_KEY=‹redacted›");
  assert.equal(redact("GITHUB_TOKEN=abc123"), "GITHUB_TOKEN=‹redacted›");
  assert.equal(redact("PGPASSWORD=pw"), "PGPASSWORD=‹redacted›");
});

test("a PEM block cut off mid-key by truncation is still redacted, not just left with a visible BEGIN line", () => {
  // Truncation (32KB head/tail) can keep a key's BEGIN line while cutting
  // away its END line entirely; the exact-block rule alone never matches
  // an incomplete pair, so a truncated key must be caught separately.
  const cutOffKey = "cat id_rsa\n-----BEGIN RSA PRIVATE KEY-----\nMIIBogIBAAKCAQEAy...(cut off, no END line)";
  const result = redact(cutOffKey);
  assert.ok(!result.includes("MIIBogIBAAKCAQEAy"), "key material must not survive an unterminated BEGIN block");
  assert.ok(result.startsWith("cat id_rsa\n"), "text before the key is untouched");
});
