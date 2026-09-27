// REAL bytes, captured from real bash running Skiff's own OSC-133 probe
// script (see Task 3 in the phase-b-capture-engine plan) on this machine,
// 2026-09-27 — a preview of the "precise mode" injection described in the
// design spec §5, not yet wired into any real session as a shippable
// feature (see Global Constraints).
//
// Line endings are normalized to \r\n by hand, same as bash-plain.ts and
// for the same reason: this sandbox's capture has no real pty, so bash
// emitted bare \n; a real SSH session's pty always translates \n to \r\n
// (ONLCR) before the client sees it, and TermMirror's cursor-column logic
// depends on that carriage return actually happening.
//
// This naive DEBUG-trap probe has a real, observed quirk worth keeping
// rather than cleaning up: bash's DEBUG trap also fires for the precmd
// function's OWN internal statements, so a spurious extra `133;C` shows up
// immediately before every `133;D` (and once, before ANYTHING was typed,
// right at session start). The engine must treat these as no-ops, not
// phantom commands — see Task 4's guard and this plan's Review Focus.
export const BASH_MARKER = {
  label: "real bash with Skiff's OSC 133 probe (marker mode, incl. its DEBUG-trap quirk; \\r\\n normalized)",
  preamble:
    "bash: cannot set terminal process group (1391): Inappropriate ioctl for device\r\n" +
    "bash: no job control in this shell\r\n" +
    "\x1b]133;C\x07\x1b]133;D;0\x07\x1b]7;file://Priyanshu/d/Skiff/skiff webapp updates\x07" +
    "\x1b]133;A\x07\x1b]133;B\x07deploy@web-1:~$ ",
  segments: [
    {
      command: "whoami",
      echoAndOutput:
        "whoami\r\n\x1b]133;C\x07piyup\r\n\x1b]133;C\x07\x1b]133;D;0\x07" +
        "\x1b]7;file://Priyanshu/d/Skiff/skiff webapp updates\x07" +
        "\x1b]133;A\x07\x1b]133;B\x07deploy@web-1:~$ ",
    },
    {
      command: "false",
      echoAndOutput:
        "false\r\n\x1b]133;C\x07\x1b]133;C\x07\x1b]133;D;1\x07" +
        "\x1b]7;file://Priyanshu/d/Skiff/skiff webapp updates\x07" +
        "\x1b]133;A\x07\x1b]133;B\x07deploy@web-1:~$ ",
    },
    {
      command: "echo done",
      echoAndOutput:
        "echo done\r\n\x1b]133;C\x07done\r\n\x1b]133;C\x07\x1b]133;D;0\x07" +
        "\x1b]7;file://Priyanshu/d/Skiff/skiff webapp updates\x07" +
        "\x1b]133;A\x07\x1b]133;B\x07deploy@web-1:~$ ",
    },
  ],
};
