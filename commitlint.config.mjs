// 提交信息校验：Conventional Commits 1.0.0。
// 规则写在这里，.vite-hooks/commit-msg 调用 commitlint，不合规则就拦住这次提交。
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // 范围只收仓库里真实存在的边界：工作区包名，加上包名盖不住的改动。
    // 不写范围也合规；写了就必须在表里。
    "scope-enum": [
      2,
      "always",
      [
        "agent",
        "agent-client",
        "api",
        "config",
        "db",
        "sandbox",
        "server",
        "shared",
        "ui",
        "web",
        "desktop",
        "e2e",
        "deps",
        "docs",
        "repo",
      ],
    ],
  },
};
