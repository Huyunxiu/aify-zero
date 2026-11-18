/**
 * 一句 SQL 的读库入口。
 *
 * 排障时最常问的是「那一行写了没有」。`db:studio` 要图形界面，而端到端和桌面
 * 的现场都在临时目录里，所以留一条能直接跑的：
 *
 *     vp run db:query "select id, delivered_at from outbox_item"
 *     DATABASE_URL=file:.e2e/runs/<时间戳>/db/app.db vp run db:query "select 1"
 *
 * 默认库和 `db:generate` 一样是 checkout 根部的 `local.db`：用户库
 * （`~/.aify-zero`）不是排障要看的那一个。
 */
import { createClient } from "@libsql/client";

import { resolveDevelopmentDatabaseUrl, WORKSPACE_ROOT } from "./paths";

/** 命令行拼起来的那条 SQL。 */
const sql = process.argv.slice(2).join(" ").trim();

if (sql === "") {
  console.error('usage: vp run db:query "select ..."');
  process.exit(2);
}

const url =
  process.env.DATABASE_URL === undefined || process.env.DATABASE_URL === ""
    ? resolveDevelopmentDatabaseUrl(WORKSPACE_ROOT)
    : process.env.DATABASE_URL;

const client = createClient({ url });

try {
  const { rows } = await client.execute(sql);

  // 空结果也说一声：分不清「没有这一行」和「命令没跑」是最耽误事的一种。
  console.log(rows.length === 0 ? "(no rows)" : JSON.stringify(rows, null, 2));
} catch (error) {
  console.error(
    `query failed: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exitCode = 1;
} finally {
  client.close();
}
