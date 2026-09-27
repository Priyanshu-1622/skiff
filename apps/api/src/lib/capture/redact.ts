const MARK = "‹redacted›"; // ‹redacted›

interface Rule {
  pattern: RegExp;
  replace: (...args: string[]) => string;
  when?: (text: string) => boolean;
}

// mysql's own -p<secret> form (no separator) is common enough to redact,
// but the same bare "-p" shape collides with unrelated flags on many other
// tools (find -print, cp -pr, ssh -p2222, docker run -p8080:80, gcc
// -pthread...). Scope it to commands that are actually mysql-family.
const MYSQL_FAMILY = /^\s*(?:sudo\s+)?(?:mysql|mysqldump|mysqladmin|mariadb\w*)\b/i;

const RULES: Rule[] = [
  // -p<secret>, attached with no separator (mysql-style short flag)
  { pattern: /(?<=\s|^)-p\S+/g, replace: () => `-p${MARK}`, when: (text) => MYSQL_FAMILY.test(text) },
  // --password[= |space]<secret>
  { pattern: /--password([= ])\S+/g, replace: (_m, sep) => `--password${sep}${MARK}` },
  // Env-var-style secrets: the keyword may be the whole name (PASSWORD=) or
  // embedded with a prefix/suffix (DB_PASSWORD=, AWS_SECRET_ACCESS_KEY=,
  // GITHUB_TOKEN=, PGPASSWORD=) — no word boundary around the keyword
  // itself, since "_" isn't a boundary and neither is a following letter.
  {
    pattern: /[A-Za-z0-9_]*(?:password|passwd|token|secret|api[_-]?key)[A-Za-z0-9_]*=\S+/gi,
    replace: (m: string) => `${m.slice(0, m.indexOf("=") + 1)}${MARK}`,
  },
  { pattern: /Authorization:\s*Bearer\s+\S+/gi, replace: () => `Authorization: Bearer ${MARK}` },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replace: () => MARK },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, replace: () => MARK },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replace: () => MARK },
  { pattern: /\bsk_(live|test)_[A-Za-z0-9]{16,}\b/g, replace: () => MARK },
  { pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, replace: () => MARK },
  { pattern: /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, replace: () => MARK },
  // A BEGIN block with no matching END anywhere in the text — most likely
  // the END line was cut away by output truncation, or by a chunk-boundary
  // split — must still be redacted, not left showing key material with a
  // visible BEGIN line. Conservative by design: redacts everything from
  // BEGIN to the end of the string, since there is no reliable end point.
  { pattern: /-----BEGIN [^-]+PRIVATE KEY-----(?![\s\S]*-----END)[\s\S]*$/g, replace: () => MARK },
];

export function redact(text: string): string {
  let out = text;
  for (const rule of RULES) {
    if (rule.when && !rule.when(text)) continue;
    out = out.replace(rule.pattern, rule.replace);
  }
  return out;
}
