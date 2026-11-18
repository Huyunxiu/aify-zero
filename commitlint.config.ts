// 提交信息校验：Conventional Commits 1.0.0。
// 规则写在这里，.vite-hooks/commit-msg 调用 commitlint，不合规则就拦住这次提交。
import { readdirSync } from "node:fs";

/** 一套子目录的名字：`packages/` 或 `apps/`。 */
const directories = (name: "apps" | "packages"): string[] =>
  readdirSync(new URL(`${name}/`, import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

/**
 * 目录名和 scope 不一致的地方。
 *
 * `apps/server` 是 HTTP 服务的宿主，`packages/server` 是服务端包；两边都叫
 * `server` 就分不清改动落在哪一层，所以应用那一侧记作 `api`。
 */
const APP_SCOPES: Record<string, string> = { server: "api" };

/** 包名盖不住的改动：仓库根部的目录与工具链。 */
const OTHER_SCOPES = ["deps", "docs", "e2e", "repo"];

const scopes = [
  ...new Set([
    ...directories("packages"),
    ...directories("apps").map((name) => APP_SCOPES[name] ?? name),
    ...OTHER_SCOPES,
  ]),
].toSorted((left, right) => left.localeCompare(right));

export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // 范围只收仓库里真实存在的边界：工作区包名，加上包名盖不住的改动。名单从
    // 目录派生，所以新加一个包不用回来改这里。不写范围也合规；写了就必须在表里。
    "scope-enum": [2, "always", scopes],
  },
};
