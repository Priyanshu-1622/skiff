// Cross-platform test runner.
//
// We can't rely on a shell glob (`src/**/*.test.ts`) because PowerShell on
// Windows doesn't expand it and Node's own glob handling differs by platform
// and path separator. So we walk src/ ourselves, collect every *.test.ts
// file, and hand the list to `node --test`. Works the same everywhere.

import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname } from "node:path";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "src");
const require = createRequire(import.meta.url);

function findTests(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...findTests(full));
    } else if (entry.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

const tests = findTests(srcDir);
if (tests.length === 0) {
  console.error("No test files found under", srcDir);
  process.exit(1);
}

// The route tests import app.ts, which imports the compiled @skiff/shared
// package (dist/index.js). On a fresh clone that dist doesn't exist yet, so
// build it first. This makes `pnpm --filter @skiff/api test` work on its own
// without a separate `pnpm build` step (and matches what CI needs).
const sharedDist = join(here, "..", "..", "packages", "shared", "dist", "index.js");
if (!existsSync(sharedDist)) {
  console.log("Building @skiff/shared (dist not found)...");
  const build = spawnSync(
    process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    ["--filter", "@skiff/shared", "build"],
    { stdio: "inherit", cwd: join(here, "..", "..") },
  );
  if (build.status !== 0) {
    console.error("Failed to build @skiff/shared");
    process.exit(build.status ?? 1);
  }
}

// Resolve tsx's ESM loader to an absolute file URL. Passing the resolved path
// (rather than the bare specifier "tsx") via NODE_OPTIONS means every child
// test process can load it no matter where tsx is installed in the workspace.
const tsxLoader = pathToFileURL(require.resolve("tsx/esm")).href;

const result = spawnSync(
  process.execPath,
  ["--test", ...tests],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${tsxLoader}`.trim(),
    },
  },
);
process.exit(result.status ?? 1);
