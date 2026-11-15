import { lstatSync } from "node:fs";
import { win32 } from "node:path";

/** A candidate path probe. Injectable so resolution is testable without a real filesystem. */
export type PathExists = (candidate: string) => boolean;

/**
 * PowerShell argv shared by every invocation. `-NoProfile` keeps runs
 * reproducible, `-NonInteractive` stops a prompt from wedging the tool, and
 * `-Command` takes the whole script as one argument — no intermediate shell
 * quoting layer exists.
 */
const POWERSHELL_ARGS = [
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-Command",
] as const;

/**
 * UTF-8 pinning prepended to every PowerShell command. The subprocess collector
 * decodes bytes as UTF-8, but Windows PowerShell 5.1 writes the OEM code page
 * by default, which garbles non-ASCII output. Both statements are wrapped so a
 * host that disallows one still runs the command.
 */
const POWERSHELL_UTF8_PREAMBLE =
  "try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}; try { $OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}; ";

/** The bash argv for one command: the command is a single `-c` argument. */
export function bashArgv(file: string, command: string): string[] {
  return [file, "-c", command];
}

/** The PowerShell argv for one command, with UTF-8 output pinned first. */
export function powerShellArgv(file: string, command: string): string[] {
  return [file, ...POWERSHELL_ARGS, `${POWERSHELL_UTF8_PREAMBLE}${command}`];
}

/**
 * The `PATH` value of an environment, matched case-insensitively because
 * Windows environments may spell it `Path`.
 */
function pathValue(env: NodeJS.ProcessEnv): string {
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH");
  return key === undefined ? "" : (env[key] ?? "");
}

/** PATH entries usable as install roots: quotes stripped, empty entries dropped. */
function pathEntries(env: NodeJS.ProcessEnv): string[] {
  return pathValue(env)
    .split(";")
    .map((entry) => entry.trim().replace(/^"|"$/gu, ""))
    .filter((entry) => entry.length > 0);
}

/**
 * Well-known bash locations, in resolution order: the standard POSIX installs,
 * or Git for Windows (machine, then user install) followed by PATH entries.
 * A legacy WSL `System32\bash.exe` is deliberately absent: it needs stdin
 * command transport and different argv semantics.
 */
export function candidateBashPaths(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string[] {
  if (platform !== "win32") {
    return ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash", "/bin/sh"];
  }

  const programFiles = env.ProgramFiles ?? "C:\\Program Files";
  const programFilesX86 = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const localAppData = env.LOCALAPPDATA;
  const candidates = [
    win32.join(programFiles, "Git", "bin", "bash.exe"),
    win32.join(programFilesX86, "Git", "bin", "bash.exe"),
  ];
  if (localAppData !== undefined && localAppData.length > 0) {
    candidates.push(
      win32.join(localAppData, "Programs", "Git", "bin", "bash.exe")
    );
  }
  for (const entry of pathEntries(env)) {
    candidates.push(win32.join(entry, "bash.exe"));
  }
  return candidates;
}

/**
 * Resolve the bash executable. POSIX always ends with `bash` as a PATH lookup
 * fallback; Windows returns `undefined` when no Git Bash is installed, so the
 * caller can leave the tool out instead of advertising one that cannot start.
 */
export function resolveBashShell(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: PathExists = candidateExists
): string | undefined {
  for (const candidate of candidateBashPaths(env, platform)) {
    if (exists(candidate)) {
      return candidate;
    }
  }
  return platform === "win32" ? undefined : "bash";
}

/**
 * Well-known PowerShell locations, newest first: an explicit `PWSH_PATH`, the
 * PowerShell 7 install, PATH entries (including the Microsoft Store alias),
 * then Windows PowerShell 5.1 as the last-resort fallback.
 */
export function candidatePowerShellPaths(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string[] {
  if (platform !== "win32") {
    return [];
  }

  const programFiles = env.ProgramFiles ?? "C:\\Program Files";
  const systemRoot = env.SystemRoot ?? "C:\\Windows";
  const candidates: string[] = [];
  const configured = env.PWSH_PATH?.trim();
  if (configured !== undefined && configured.length > 0) {
    candidates.push(configured);
  }
  candidates.push(win32.join(programFiles, "PowerShell", "7", "pwsh.exe"));
  for (const entry of pathEntries(env)) {
    candidates.push(win32.join(entry, "pwsh.exe"));
  }
  candidates.push(
    win32.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe"
    )
  );
  return candidates;
}

/** Resolve the PowerShell executable, or `undefined` outside Windows. */
export function resolvePowerShell(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: PathExists = candidateExists
): string | undefined {
  for (const candidate of candidatePowerShellPaths(env, platform)) {
    if (exists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Whether a candidate can be spawned. `lstat` opens the entry itself instead of
 * following reparse points, so it sees the Microsoft Store execution alias
 * where `stat` hits the target's ACL; a real directory never matches.
 */
function candidateExists(candidate: string): boolean {
  try {
    const info = lstatSync(candidate);
    return info.isFile() || info.isSymbolicLink();
  } catch {
    return false;
  }
}

let cachedBashShell: string | null | undefined;
let cachedPowerShell: string | null | undefined;

/**
 * The process lifetime's bash executable. Resolution is memoized because every
 * session asks for it; the pure {@link resolveBashShell} stays available for
 * tests and for callers that pass their own environment.
 */
export function defaultBashShell(): string | undefined {
  if (cachedBashShell === undefined) {
    cachedBashShell = resolveBashShell() ?? null;
  }
  return cachedBashShell ?? undefined;
}

/** The process lifetime's PowerShell executable, resolved once. */
export function defaultPowerShell(): string | undefined {
  if (cachedPowerShell === undefined) {
    cachedPowerShell = resolvePowerShell() ?? null;
  }
  return cachedPowerShell ?? undefined;
}
