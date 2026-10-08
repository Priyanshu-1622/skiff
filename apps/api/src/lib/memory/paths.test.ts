import { test } from "node:test";
import assert from "node:assert/strict";
import { extractCandidatePaths } from "./paths.js";

const paths = (cmd: string, cwd: string | null = "/srv") => extractCandidatePaths(cmd, cwd).map((c) => c.path);

test("editors: the files named on the command line, with their flags skipped", () => {
  assert.deepEqual(paths("vim /etc/hosts"), ["/etc/hosts"]);
  assert.deepEqual(paths("vi /etc/a /etc/b"), ["/etc/a", "/etc/b"]);
  assert.deepEqual(paths("nano -w /etc/motd"), ["/etc/motd"]);
  assert.deepEqual(paths("vim +10 /etc/hosts"), ["/etc/hosts"]);
  assert.deepEqual(paths("emacs /etc/x"), ["/etc/x"]);
  assert.deepEqual(paths("micro /etc/x"), ["/etc/x"]);
  assert.deepEqual(paths("/usr/bin/vim /etc/x"), ["/etc/x"]);
  assert.deepEqual(paths("sudo vim /etc/hosts"), ["/etc/hosts"]);
  assert.deepEqual(paths("sudo -u bob vim /home/bob/x"), ["/home/bob/x"]);
  assert.deepEqual(paths("sudoedit /etc/hosts"), ["/etc/hosts"]);
  assert.deepEqual(paths("sudo -e /etc/hosts"), ["/etc/hosts"]);
  assert.deepEqual(paths("FOO=1 vim /etc/x"), ["/etc/x"]);
});

test("sed -i, tee, redirects, cp/mv/install", () => {
  assert.deepEqual(paths("sed -i 's/a/b/' /etc/app.conf"), ["/etc/app.conf"]);
  assert.deepEqual(paths("sed -i.bak 's/a/b/' /etc/app.conf"), ["/etc/app.conf"]);
  assert.deepEqual(paths("sudo sed -Ei 's/a|b/c/' /etc/app.conf"), ["/etc/app.conf"]);
  assert.deepEqual(paths("sed -i -e 's/a/b/' -e 's/c/d/' /etc/x /etc/y"), ["/etc/x", "/etc/y"]);
  assert.deepEqual(paths("sed 's/a/b/' /etc/app.conf"), [], "without -i nothing is written");
  assert.deepEqual(paths("echo hi | sudo tee /etc/motd"), ["/etc/motd"]);
  assert.deepEqual(paths("echo hi | tee -a /var/log/x /var/log/y"), ["/var/log/x", "/var/log/y"]);
  assert.deepEqual(paths("echo hi > /tmp/out"), ["/tmp/out"]);
  assert.deepEqual(paths("echo hi >> /tmp/out"), ["/tmp/out"]);
  assert.deepEqual(paths("cmd 2> /tmp/err.log"), [], "stderr redirects are not tracked");
  assert.deepEqual(paths("cmd < /tmp/in"), [], "input redirects are not tracked");
  assert.deepEqual(paths("cp /a/src /b/dest"), ["/b/dest"]);
  assert.deepEqual(paths("mv /a/src /b/dest"), ["/b/dest"]);
  assert.deepEqual(paths("install -m644 /a/src /b/dest"), ["/b/dest"]);
  assert.deepEqual(paths("cp /a/src"), [], "one operand has no destination");
  assert.deepEqual(paths("cp -t /dir /a/src"), [], "a target directory is not a file");
  assert.deepEqual(paths("cp -t /dir /a/one /a/two"), [], "with -t the last operand is a source, not the destination");
  assert.deepEqual(paths("cp --target-directory=/dir /a/one /a/two"), []);
});

test("quoting and escaping", () => {
  assert.deepEqual(paths('vim "/srv/my file.txt"'), ["/srv/my file.txt"]);
  assert.deepEqual(paths("vim '/srv/a b'"), ["/srv/a b"]);
  assert.deepEqual(paths("vim /srv/a\\ b"), ["/srv/a b"]);
  assert.deepEqual(paths("echo hi > '/tmp/a b'"), ["/tmp/a b"]);
});

test("tilde and relative paths", () => {
  assert.deepEqual(paths("vim ~/notes.txt"), ["~/notes.txt"]);
  assert.deepEqual(extractCandidatePaths("vim conf/a.conf", "/srv"), [{ path: "/srv/conf/a.conf", relative: false, via: "editor" }]);
  assert.deepEqual(extractCandidatePaths("vim ../etc/x", "/srv/app"), [{ path: "/srv/etc/x", relative: false, via: "editor" }]);
  assert.deepEqual(extractCandidatePaths("vim conf/a.conf", null), [{ path: "conf/a.conf", relative: true, via: "editor" }]);
  assert.deepEqual(extractCandidatePaths("echo x > out.txt", "/srv"), [{ path: "/srv/out.txt", relative: false, via: "redirect" }]);
});

test("command chains are split and each part is considered", () => {
  assert.deepEqual(paths("vim /a; vim /b"), ["/a", "/b"]);
  assert.deepEqual(paths("cd /srv && vim conf/x || vim /fallback"), ["/srv/conf/x", "/fallback"]);
  assert.deepEqual(paths("cat /etc/hosts | sudo tee /etc/out | wc -l"), ["/etc/out"]);
  assert.deepEqual(paths("vim /a\nvim /b"), ["/a", "/b"]);
});

test("anything that can't be known from the text is skipped, never guessed", () => {
  assert.deepEqual(paths("vim $FILE"), []);
  assert.deepEqual(paths("vim ${HOME}/x"), []);
  assert.deepEqual(paths("vim *.conf"), []);
  assert.deepEqual(paths("vim /etc/*.conf"), []);
  assert.deepEqual(paths("vim $(which foo)"), []);
  assert.deepEqual(paths("vim `which foo`"), []);
  assert.deepEqual(paths("diff <(cat /a) /b"), []);
  assert.deepEqual(paths("cat <<EOF > /tmp/x"), ["/tmp/x"]);
  assert.deepEqual(paths("echo hi > /dev/null"), []);
  assert.deepEqual(paths("echo hi > /dev/stderr"), []);
  assert.deepEqual(paths("tee -"), []);
  assert.deepEqual(paths('vim "/srv/$NAME"'), [], "an expansion inside double quotes is still an expansion");
  assert.deepEqual(paths("vim '/srv/$NAME'"), ["/srv/$NAME"], "inside single quotes it is a literal dollar sign");
});

test("duplicates are removed and at most five paths are returned", () => {
  assert.deepEqual(paths("vim /a /a /b"), ["/a", "/b"]);
  assert.equal(paths("vim /1 /2 /3 /4 /5 /6 /7").length, 5);
});

test("garbage input returns nothing and never throws", () => {
  for (const cmd of ["", "   ", "vim '/unterminated", 'vim "/unterminated', ">", ">>", "vim >", "|", ";;", "sudo", "sed -i", "x".repeat(20000), "\u0000\u0001"]) {
    assert.doesNotThrow(() => extractCandidatePaths(cmd, "/srv"), JSON.stringify(cmd.slice(0, 20)));
  }
  assert.deepEqual(paths(""), []);
  assert.deepEqual(paths("sudo"), []);
});
