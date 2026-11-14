/**
 * 迁移目录与数据库地址的解析规则。
 *
 * 单独成模块是为了没有副作用：`@workspace/db` 一导入就建连接，而入口、构建
 * 脚本和 drizzle 配置只是需要路径。
 */
import { existsSync } from "node:fs";
import path from "node:path";

const here = import.meta.dirname;

/** 仓库根目录。 */
export const WORKSPACE_ROOT = path.resolve(here, "..", "..", "..");

/** 本包的迁移与 schema 目录。 */
export const MIGRATIONS_DIRECTORY = path.join(here, "migrations");
export const SCHEMA_DIRECTORY = path.join(here, "schema");

/**
 * 从 `start` 向上找带 `meta/_journal.json` 的 `migrations/` 目录。
 *
 * 只看四层：够覆盖 `<out>/assets/`、`<out>/` 和源码目录，又不会一路爬到仓库
 * 外面去撞上一个不相关的同名目录。
 */
export function findMigrationsDirectory(start: string): string | undefined {
  let directory = start;

  for (let depth = 0; depth < 4; depth += 1) {
    const candidate = path.join(directory, "migrations");

    if (existsSync(path.join(candidate, "meta", "_journal.json"))) {
      return candidate;
    }

    const parent = path.dirname(directory);

    if (parent === directory) {
      break;
    }

    directory = parent;
  }

  return undefined;
}

/**
 * 开发库地址：显式 `DATABASE_URL` 优先，否则是 checkout 根部的 `local.db`。
 *
 * CLI 和开发入口共用这一条，运行期的默认值（`~/.aify-zero`）是用户库，不能
 * 混进来。空字符串按「没有设置」处理：`.env` 里留一行空的 `DATABASE_URL=`
 * 不应该变成一个空地址。
 */
export function resolveDevelopmentDatabaseUrl(workspaceRoot: string): string {
  const url = process.env.DATABASE_URL;

  if (url !== undefined && url !== "") {
    return url;
  }

  return `file:${path.join(workspaceRoot, "local.db")}`;
}
