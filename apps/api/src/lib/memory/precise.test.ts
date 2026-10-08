import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { detectShell, PRECISE_SNIPPETS } from "./precise.js";

const hasBash = spawnSync("bash", ["--version"]).status === 0;
const ESC = "\x1b";
const BEL = "\x07";

function bash(script: string): string {
  const r = spawnSync("bash", ["--noprofile", "--norc", "-c", script], { encoding: "utf8" });
  // The last command may legitimately exit non-zero (the hook preserves $?), so check stderr, not the status.
  assert.equal(r.stderr, "", `bash complained: ${r.stderr}`);
  return r.stdout;
}

test("detectShell recognises bash, zsh and fish from $SHELL and nothing else", () => {
  assert.equal(detectShell("/bin/bash"), "bash");
  assert.equal(detectShell("/usr/bin/zsh\n"), "zsh");
  assert.equal(detectShell("/usr/local/bin/fish"), "fish");
  assert.equal(detectShell("bash"), "bash");
  assert.equal(detectShell("-bash"), "bash");
  assert.equal(detectShell("/opt/homebrew/bin/bash5"), "bash");
  for (const other of ["/bin/sh", "/bin/dash", "/usr/sbin/nologin", "/bin/tcsh", "", "/bin/bashful", "  "]) {
    assert.equal(detectShell(other), null, JSON.stringify(other));
  }
  assert.equal(detectShell(null), null);
  assert.equal(detectShell(undefined), null);
});

test("every snippet is one visible-safe line that starts with a space and mentions all four markers", () => {
  for (const [shell, snippet] of Object.entries(PRECISE_SNIPPETS)) {
    assert.ok(snippet.startsWith(" "), `${shell}: starts with a space`);
    assert.ok(!/[\r\n]/.test(snippet), `${shell}: single line`);
    assert.ok(/^[\x20-\x7e]+$/.test(snippet), `${shell}: printable ASCII only`);
    assert.ok(snippet.length <= 1200, `${shell}: short enough (${snippet.length})`);
    for (const code of ["133;A", "133;B", "133;C", "133;D"]) assert.ok(snippet.includes(code), `${shell}: ${code}`);
    assert.ok(snippet.includes("__skiff"), `${shell}: named so it can be recognised`);
  }
});

test("the bash snippet is valid bash", { skip: !hasBash }, () => {
  const r = spawnSync("bash", ["-n"], { input: PRECISE_SNIPPETS.bash + "\n", encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("bash: the prompt hook reports the previous command's exit code, then the prompt-start marker", { skip: !hasBash }, () => {
  const failed = bash(`${PRECISE_SNIPPETS.bash}\nfalse; eval "$PROMPT_COMMAND"`);
  const d = failed.indexOf(`${ESC}]133;D;1${BEL}`);
  const a = failed.indexOf(`${ESC}]133;A${BEL}`);
  assert.ok(d >= 0 && a > d, `D;1 then A in ${JSON.stringify(failed)}`);
  assert.ok(failed.includes(`${ESC}]7;file://`), "working directory is reported too");
  assert.ok(bash(`${PRECISE_SNIPPETS.bash}\ntrue; eval "$PROMPT_COMMAND"`).includes(`${ESC}]133;D;0${BEL}`));
});

test("bash: an existing PROMPT_COMMAND still runs afterwards and still sees the real exit status", { skip: !hasBash }, () => {
  const out = bash(`PROMPT_COMMAND='echo next:$?'\n${PRECISE_SNIPPETS.bash}\nfalse; eval "$PROMPT_COMMAND"`);
  assert.ok(out.indexOf(`${ESC}]133;A${BEL}`) < out.indexOf("next:1"), JSON.stringify(out));
});

test("bash: running the snippet twice does not duplicate the hook or the prompt marker", { skip: !hasBash }, () => {
  const out = bash(`PS1='$ '\n${PRECISE_SNIPPETS.bash}\n${PRECISE_SNIPPETS.bash}\nprintf 'PC=%s\\n' "$PROMPT_COMMAND"\nprintf 'PS=%s\\n' "$PS1"`);
  assert.equal((out.match(/PC=.*/)![0].match(/__skiff_pc/g) ?? []).length, 1, out);
  assert.equal((out.match(/PS=.*/)![0].match(/133;B/g) ?? []).length, 1, out);
});

test("bash: an existing DEBUG trap is left alone; with none, the command-start marker is installed", { skip: !hasBash }, () => {
  const kept = bash(`trap 'echo user-trap' DEBUG\n${PRECISE_SNIPPETS.bash}\ntrap -p DEBUG`);
  assert.ok(kept.includes("user-trap") && !kept.includes("133;C"), kept);
  const fresh = bash(`${PRECISE_SNIPPETS.bash}\ntrap -p DEBUG`);
  assert.ok(fresh.includes("133;C"), fresh);
});
