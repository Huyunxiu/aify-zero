import { describe, expect, test } from "vitest";

import {
  bashArgv,
  candidateBashPaths,
  candidatePowerShellPaths,
  powerShellArgv,
  resolveBashShell,
  resolvePowerShell,
} from "../../../src/tools/shell/resolve.js";

describe(resolveBashShell, () => {
  test("should prefer /bin/bash on POSIX", () => {
    const shell = resolveBashShell(
      {},
      "darwin",
      (path) => path === "/bin/bash"
    );
    expect(shell).toBe("/bin/bash");
  });

  test("should fall back to a PATH lookup when no POSIX location exists", () => {
    expect(resolveBashShell({}, "linux", () => false)).toBe("bash");
  });

  test("should use /bin/sh when bash is absent but sh exists", () => {
    expect(resolveBashShell({}, "linux", (path) => path === "/bin/sh")).toBe(
      "/bin/sh"
    );
  });

  test("should find Git Bash in the default install location on Windows", () => {
    const env = { ProgramFiles: "C:\\Program Files" };
    const shell = resolveBashShell(
      env,
      "win32",
      (path) => path === "C:\\Program Files\\Git\\bin\\bash.exe"
    );
    expect(shell).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
  });

  test("should find Git Bash from a quoted PATH entry on Windows", () => {
    const env = { PATH: '"C:\\Tools";;C:\\Git\\bin' };
    const shell = resolveBashShell(
      env,
      "win32",
      (path) => path === "C:\\Git\\bin\\bash.exe"
    );
    expect(shell).toBe("C:\\Git\\bin\\bash.exe");
  });

  test("should report no bash on Windows when Git Bash is absent", () => {
    expect(resolveBashShell({}, "win32", () => false)).toBeUndefined();
  });

  test("should list Git installs before PATH entries", () => {
    const env = {
      ProgramFiles: "C:\\Program Files",
      PATH: "C:\\Tools",
    };
    const candidates = candidateBashPaths(env, "win32");
    expect(candidates[0]).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
    expect(candidates).toContain("C:\\Tools\\bash.exe");
  });
});

describe(resolvePowerShell, () => {
  test("should never resolve outside Windows", () => {
    expect(resolvePowerShell({}, "darwin", () => true)).toBeUndefined();
    expect(candidatePowerShellPaths({}, "linux")).toStrictEqual([]);
  });

  test("should prefer an explicit PWSH_PATH", () => {
    const env = { PWSH_PATH: "D:\\pwsh\\pwsh.exe" };
    expect(resolvePowerShell(env, "win32", () => true)).toBe(
      "D:\\pwsh\\pwsh.exe"
    );
  });

  test("should prefer PowerShell 7 over the Windows PowerShell fallback", () => {
    const env = {
      ProgramFiles: "C:\\Program Files",
      SystemRoot: "C:\\Windows",
    };
    const candidates = candidatePowerShellPaths(env, "win32");
    expect(candidates[0]).toBe("C:\\Program Files\\PowerShell\\7\\pwsh.exe");
    expect(candidates.at(-1)).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
    );
  });

  test("should fall back to Windows PowerShell when pwsh is absent", () => {
    const env = {
      ProgramFiles: "C:\\Program Files",
      SystemRoot: "C:\\Windows",
    };
    const fallback =
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    expect(resolvePowerShell(env, "win32", (path) => path === fallback)).toBe(
      fallback
    );
  });
});

describe("shell argv", () => {
  test("should pass a bash command as one -c argument", () => {
    expect(bashArgv("/bin/bash", "echo hi")).toStrictEqual([
      "/bin/bash",
      "-c",
      "echo hi",
    ]);
  });

  test("should pass a PowerShell command as one -Command argument", () => {
    const argv = powerShellArgv("pwsh", "Write-Output hi");
    expect(argv[0]).toBe("pwsh");
    expect(argv).toContain("-NoProfile");
    expect(argv).toContain("-NonInteractive");
    expect(argv.at(-1)).toContain("Write-Output hi");
    expect(argv.at(-1)).toContain("OutputEncoding");
  });
});
