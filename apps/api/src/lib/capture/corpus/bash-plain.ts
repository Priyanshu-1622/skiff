// REAL bytes, captured from `bash --norc --noprofile -i` on this machine,
// 2026-09-27 (see Task 3 in the phase-b-capture-engine plan for the exact
// capture command). No OSC 133 markers — this is the screen-mode corpus.
// `whoami` prints the real sandbox user ("piyup"), exit 0; `false` prints
// nothing, exit 1; `echo done` prints "done", exit 0.
//
// The capture itself had no real pty (none is available in this sandbox —
// input/output were plain redirected files), so bash's raw bytes used bare
// \n with no \r. A real SSH session always has a pty, and a pty's default
// line discipline (ONLCR) rewrites every \n to \r\n before it ever reaches
// the client — without that, a terminal emulator moves the cursor down but
// leaves it in the same column, not column 0 (confirmed against this
// project's own TermMirror while building Task 4: a bare \n corpus put the
// cursor at column 34, not 0, breaking every cursor-column-based read).
// \r\n below is that translation applied by hand to the real captured
// text, not an invention — it's what the same bash session would have
// produced over a real pty.
export const BASH_PLAIN = {
  label: "real bash, plain PS1, no markers (line endings normalized to \\r\\n as a real pty's ONLCR would)",
  preamble:
    "bash: cannot set terminal process group (670): Inappropriate ioctl for device\r\n" +
    "bash: no job control in this shell\r\n" +
    "deploy@web-1:~$ ",
  segments: [
    { command: "whoami", echoAndOutput: "whoami\r\npiyup\r\ndeploy@web-1:~$ " },
    { command: "false", echoAndOutput: "false\r\ndeploy@web-1:~$ " },
    { command: "echo done", echoAndOutput: "echo done\r\ndone\r\ndeploy@web-1:~$ " },
  ],
};
