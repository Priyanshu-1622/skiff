// SYNTHETIC (hand-written from each shell's publicly documented default
// prompt format; NOT captured from a real install — zsh, fish, and
// busybox sh are unavailable in this sandbox as of 2026-09-27, see
// DECISIONS.md). Validate against real installs before relying on these
// for anything beyond "the engine doesn't crash or misparse a plausible
// foreign prompt shape." Line endings are \r\n, matching what a real
// SSH pty's ONLCR translation actually delivers (see bash-plain.ts's
// comment for why bare \n is not representative).

// zsh's default PS1 uses '%' rather than bash's '$'.
export const ZSH_PLAIN = {
  label: "synthetic zsh, plain default prompt",
  preamble: "web-1% ",
  segments: [
    { command: "whoami", echoAndOutput: "whoami\r\ndeploy\r\nweb-1% " },
    { command: "false", echoAndOutput: "false\r\nweb-1% " },
    { command: "echo done", echoAndOutput: "echo done\r\ndone\r\nweb-1% " },
  ],
};

// fish's default prompt ends in '>' with no leading text in a bare shell.
export const FISH_PLAIN = {
  label: "synthetic fish, plain default prompt",
  preamble: "web-1> ",
  segments: [
    { command: "whoami", echoAndOutput: "whoami\r\ndeploy\r\nweb-1> " },
    { command: "false", echoAndOutput: "false\r\nweb-1> " },
    { command: "echo done", echoAndOutput: "echo done\r\ndone\r\nweb-1> " },
  ],
};

// busybox ash's default prompt is a plain '$ ' with no hostname.
export const BUSYBOX_PLAIN = {
  label: "synthetic busybox ash, plain default prompt",
  preamble: "$ ",
  segments: [
    { command: "whoami", echoAndOutput: "whoami\r\ndeploy\r\n$ " },
    { command: "false", echoAndOutput: "false\r\n$ " },
    { command: "echo done", echoAndOutput: "echo done\r\ndone\r\n$ " },
  ],
};
