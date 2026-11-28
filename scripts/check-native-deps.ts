/**
 * Name the native packages and the browser this repository needs, and the command that
 * installs whatever is missing.
 *
 * A store that skipped optional platform packages makes `vp check`, `vp test` and
 * `vp run -r build` fail in files a change never touched. That failure reads as if the
 * change broke something, so this command says what is absent instead.
 *
 * Usage: `vp run doctor`.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

interface Requirement {
  /** What the package is for, in the words of the symptom it causes. */
  readonly name: string;
  /** The directory that holds the platform package. */
  readonly directory: string;
  /** The name prefix of one platform package inside that directory. */
  readonly prefix: string;
  /** The command that installs it. */
  readonly fix: string;
}

const INSTALL = "CI=true vp install --frozen-lockfile";

/** Where Playwright keeps its browsers, by platform. */
function browserCache(): string {
  const override = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (override !== undefined && override.length > 0) {
    return override;
  }
  if (process.platform === "darwin") {
    return path.join(homedir(), "Library", "Caches", "ms-playwright");
  }
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? homedir(), "ms-playwright");
  }
  return path.join(homedir(), ".cache", "ms-playwright");
}

const REQUIREMENTS: readonly Requirement[] = [
  {
    name: "sharp platform package (image decoding)",
    directory: path.join("node_modules", "@img"),
    prefix: `sharp-${process.platform}`,
    fix: INSTALL,
  },
  {
    name: "libsql native binding (database)",
    directory: path.join("node_modules", "@libsql"),
    prefix: `${process.platform}-`,
    fix: INSTALL,
  },
  {
    name: "node-pty platform package (terminal)",
    directory: path.join("node_modules", "@lydell"),
    prefix: `node-pty-${process.platform}`,
    fix: INSTALL,
  },
  {
    name: "Playwright Chromium (e2e)",
    directory: browserCache(),
    prefix: "chromium-",
    fix: "vp exec playwright install chromium",
  },
];

function present(requirement: Requirement): boolean {
  if (!existsSync(requirement.directory)) {
    return false;
  }
  return readdirSync(requirement.directory).some((entry) =>
    entry.startsWith(requirement.prefix)
  );
}

let missing = 0;

for (const requirement of REQUIREMENTS) {
  if (present(requirement)) {
    console.log(`ok    ${requirement.name}`);
    continue;
  }
  missing += 1;
  console.error(`MISS  ${requirement.name}`);
  console.error(`      ${requirement.directory}`);
  console.error(`      fix: ${requirement.fix}`);
}

if (missing === 0) {
  console.log("[doctor] every native package and the browser are in place");
} else {
  console.error(
    `[doctor] ${missing} requirement(s) missing. See docs/development/environment.md.`
  );
  process.exitCode = 1;
}
