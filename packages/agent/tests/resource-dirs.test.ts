import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  getGlobalResourceRoots,
  getProjectResourceRoots,
} from "../src/resource-dirs.js";

describe(getGlobalResourceRoots, () => {
  test("joins every dir under home in the given order", () => {
    expect(
      getGlobalResourceRoots([".aify-studio", ".agents"], "/home/user")
    ).toStrictEqual([
      { dir: ".aify-studio", root: join("/home/user", ".aify-studio") },
      { dir: ".agents", root: join("/home/user", ".agents") },
    ]);
  });
});

describe(getProjectResourceRoots, () => {
  test("joins every dir under the projectDir in the given order", () => {
    expect(
      getProjectResourceRoots("/repo", [".aify-studio", ".agents"])
    ).toStrictEqual([
      { dir: ".aify-studio", root: join("/repo", ".aify-studio") },
      { dir: ".agents", root: join("/repo", ".agents") },
    ]);
  });
});
