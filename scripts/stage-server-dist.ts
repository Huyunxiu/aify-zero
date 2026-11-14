import { existsSync } from "node:fs";
import { chmod, cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { MIGRATIONS_DIRECTORY, WORKSPACE_ROOT } from "../packages/db/src/paths";
import { stageRipgrep } from "./stage-ripgrep";

// `vp build` 只产出 JS。这一步补上打包器带不走的东西，让输出目录可以独立部署：
//
//   - `node_modules/@libsql/`：打包后的客户端在运行期加载的原生绑定，没法内联
//     进 JS；
//   - `node_modules/@lydell/`：PTY 原生绑定和它的平台包；`spawn-helper` 必须是
//     包外的可执行文件；
//   - `bin/rg`：agent 的 grep/glob 工具要执行的 ripgrep 二进制，不能从包里跑；
//   - `migrations/`：启动迁移要应用的 SQL，放在 `index.js` 旁边，
//     `@workspace/db` 不用环境变量就能找到；
//   - `package.json`：让输出目录在仓库之外也被当成 ESM。
//
// 调用方式：在 `apps/server` 下执行 `tsx ../../scripts/stage-server-dist.ts dist`。
const outputDirectory = path.resolve(process.argv[2] ?? "dist");
const libsqlSource = path.join(WORKSPACE_ROOT, "node_modules", "@libsql");
const ptySource = path.join(WORKSPACE_ROOT, "node_modules", "@lydell");

if (!existsSync(libsqlSource)) {
  throw new Error(
    `@libsql packages missing at ${libsqlSource}; run \`vp install\` first.`
  );
}

if (!existsSync(ptySource)) {
  throw new Error(
    `@lydell packages missing at ${ptySource}; run \`vp install\` first.`
  );
}

if (!existsSync(MIGRATIONS_DIRECTORY)) {
  throw new Error(
    `migration files missing at ${MIGRATIONS_DIRECTORY}; run \`vp run db#db:generate\` if the schema changed.`
  );
}

await mkdir(outputDirectory, { recursive: true });

await cp(libsqlSource, path.join(outputDirectory, "node_modules", "@libsql"), {
  recursive: true,
  preserveTimestamps: true,
});

const ptyDestination = path.join(outputDirectory, "node_modules", "@lydell");
await cp(ptySource, ptyDestination, {
  recursive: true,
  preserveTimestamps: true,
});

// npm 会保留这个权限位，但复制出来的目录树在不同平台上不保证。原生模块直接
// 执行这个辅助程序。
const spawnHelper = path.join(
  ptyDestination,
  `node-pty-${process.platform}-${process.arch}`,
  "prebuilds",
  `${process.platform}-${process.arch}`,
  "spawn-helper"
);
if (existsSync(spawnHelper)) {
  await chmod(spawnHelper, 0o755);
}

await stageRipgrep(path.join(outputDirectory, "bin"));

// 启动迁移在本模块附近找 `migrations/`：把这个规则对这个产物也成立，就不用
// 环境变量。
await cp(MIGRATIONS_DIRECTORY, path.join(outputDirectory, "migrations"), {
  preserveTimestamps: true,
  recursive: true,
});

// 没有这个文件，Node 会把复制出来的 `dist/*.js` 当成 CommonJS。
await writeFile(
  path.join(outputDirectory, "package.json"),
  `${JSON.stringify({ type: "module", private: true }, null, 2)}\n`
);
