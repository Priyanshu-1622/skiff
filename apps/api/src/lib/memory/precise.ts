/**
 * Precise mode: one line typed into the user's interactive shell at the start
 * of a session so the shell announces prompts, commands and exit codes with
 * OSC 133 markers (the capture engine then runs in marker mode).
 *
 * Each snippet is a single line that starts with a space (kept out of history
 * by the usual ignore-space settings), is idempotent (running it twice adds
 * nothing), never replaces an existing hook, and keeps `$?` intact for whatever
 * prompt code runs after it. Markers: A = prompt start, B = prompt end /
 * command start, C = command about to run, D;<code> = command finished.
 * OSC 7 reports the working directory.
 */
export type PreciseShell = "bash" | "zsh" | "fish";

/** The shell from `$SHELL`: bash, zsh or fish (tolerating a version suffix or a leading dash); anything else is not supported. */
export function detectShell(shellPath: string | null | undefined): PreciseShell | null {
  if (!shellPath) return null;
  const base = shellPath.trim().split(/[\\/]/).pop()?.replace(/^-/, "") ?? "";
  const m = /^(bash|zsh|fish)\d*(\.\d+)*$/.exec(base);
  return m ? (m[1] as PreciseShell) : null;
}

const BASH =
  " __skiff_pc(){ local s=$?; printf '\\033]133;D;%s\\007\\033]7;file://%s%s\\007\\033]133;A\\007' \"$s\" \"${HOSTNAME:-}\" \"$PWD\"; return $s; };" +
  " case \";${PROMPT_COMMAND};\" in *\";__skiff_pc;\"*) ;; *) PROMPT_COMMAND=\"__skiff_pc${PROMPT_COMMAND:+;$PROMPT_COMMAND}\";; esac;" +
  " case \"$PS1\" in *'133;B'*) ;; *) PS1=\"${PS1}\\[\\033]133;B\\007\\]\";; esac;" +
  " case \"$(trap -p DEBUG)\" in \"\") trap 'printf \"\\033]133;C\\007\"' DEBUG;; esac";

const ZSH =
  " __skiff_precmd(){ local s=$?; print -rn -- $'\\e]133;D;'\"$s\"$'\\a\\e]7;file://'\"${HOST}${PWD}\"$'\\a\\e]133;A\\a'; return $s; };" +
  " __skiff_preexec(){ print -rn -- $'\\e]133;C\\a'; };" +
  " (( ${precmd_functions[(Ie)__skiff_precmd]} )) || precmd_functions=(__skiff_precmd $precmd_functions);" +
  " (( ${preexec_functions[(Ie)__skiff_preexec]} )) || preexec_functions+=(__skiff_preexec);" +
  " [[ $PS1 == *'133;B'* ]] || PS1=\"${PS1}%{\"$'\\e]133;B\\a'\"%}\"";

const FISH =
  " if not functions -q __skiff_orig_prompt; functions -c fish_prompt __skiff_orig_prompt;" +
  " function __skiff_ret; return $argv[1]; end;" +
  " function fish_prompt; set -l s $status; printf '\\e]133;D;%s\\a\\e]7;file://%s%s\\a\\e]133;A\\a' $s (hostname) $PWD; __skiff_ret $s; __skiff_orig_prompt; printf '\\e]133;B\\a'; end;" +
  " function __skiff_pre --on-event fish_preexec; printf '\\e]133;C\\a'; end; end";

export const PRECISE_SNIPPETS: Record<PreciseShell, string> = { bash: BASH, zsh: ZSH, fish: FISH };
