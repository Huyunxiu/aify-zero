import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { RIPGREP_PATH_ENV } from "@workspace/shared/constants";
import { afterEach, describe, expect, test, vi } from "vitest";

const RIPGREP_BINARY = process.platform === "win32" ? "rg.exe" : "rg";
const originalArgv = [...process.argv];
const temporaryDirectories: string[] = [];

/** The module caches its resolution, so every case needs a fresh copy. */
async function importRipgrep() {
  vi.resetModules();
  return await import("../../src/utils/ripgrep.js");
}

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "aify-ripgrep-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("ripgrep resolution", () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    process.argv = [...originalArgv];
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { force: true, recursive: true }))
    );
  });

  describe("getRipgrepPath", () => {
    test("should prefer the staged binary named by the env override", async () => {
      vi.stubEnv(RIPGREP_PATH_ENV, process.execPath);

      const { getRipgrepPath } = await importRipgrep();

      expect(getRipgrepPath()).toBe(process.execPath);
    });

    test("should find bin/rg next to the running entry script", async () => {
      const directory = await makeTemporaryDirectory();
      const binary = path.join(directory, "bin", RIPGREP_BINARY);

      await mkdir(path.dirname(binary), { recursive: true });
      await writeFile(binary, "");
      process.argv = [
        originalArgv[0] ?? "node",
        path.join(directory, "index.js"),
      ];

      const { getRipgrepPath } = await importRipgrep();

      expect(getRipgrepPath()).toBe(binary);
    });

    test("should fall back to rg on PATH when nothing is staged", async () => {
      vi.stubEnv(RIPGREP_PATH_ENV, "");
      process.argv = [
        originalArgv[0] ?? "node",
        path.join(tmpdir(), "aify-no-ripgrep-here", "index.js"),
      ];

      const { getRipgrepPath } = await importRipgrep();

      expect(getRipgrepPath()).toBe(RIPGREP_BINARY);
    });
  });

  describe("getRipgrepAvailable", () => {
    test("should probe the resolved binary", async () => {
      // Node exits 0 for `--version`, which is all the probe needs.
      vi.stubEnv(RIPGREP_PATH_ENV, process.execPath);

      const { getRipgrepAvailable, getRipgrepPath } = await importRipgrep();

      expect(getRipgrepPath()).toBe(process.execPath);
      await expect(getRipgrepAvailable()).resolves.toBeTruthy();
    });
  });
});
