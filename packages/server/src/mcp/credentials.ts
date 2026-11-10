import type {
  McpCredentialKind,
  McpCredentialRecord,
  McpCredentialStore,
} from "@workspace/agent";
import { db, mcp_credential_table } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";

/** 读写 `mcp_credential`。写入方只有 server 进程，所以代次递增可以放在 SQL 里。 */
export class SqliteMcpCredentialStore implements McpCredentialStore {
  async read<T>(
    serverId: string,
    kind: McpCredentialKind
  ): Promise<McpCredentialRecord<T> | undefined> {
    const [row] = await db
      .select()
      .from(mcp_credential_table)
      .where(
        and(
          eq(mcp_credential_table.serverId, serverId),
          eq(mcp_credential_table.kind, kind)
        )
      )
      .limit(1);

    if (row === undefined) {
      return undefined;
    }

    return { value: row.content as T, generation: row.generation };
  }

  async write<T>(
    serverId: string,
    kind: McpCredentialKind,
    value: T
  ): Promise<McpCredentialRecord<T>> {
    const [row] = await db
      .insert(mcp_credential_table)
      .values({
        serverId,
        kind,
        content: value,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [mcp_credential_table.serverId, mcp_credential_table.kind],
        set: {
          content: value,
          // 代次在 SQL 里加一：读改写两步之间可能有一次新的写入。
          generation: sql`${mcp_credential_table.generation} + 1`,
          updatedAt: new Date(),
        },
      })
      .returning();

    if (row === undefined) {
      throw new Error("Failed to store an MCP credential");
    }

    return { value: row.content as T, generation: row.generation };
  }

  async delete(
    serverId: string,
    kind: McpCredentialKind,
    expectedGeneration?: number
  ): Promise<boolean> {
    const condition =
      expectedGeneration === undefined
        ? and(
            eq(mcp_credential_table.serverId, serverId),
            eq(mcp_credential_table.kind, kind)
          )
        : and(
            eq(mcp_credential_table.serverId, serverId),
            eq(mcp_credential_table.kind, kind),
            eq(mcp_credential_table.generation, expectedGeneration)
          );

    const rows = await db
      .delete(mcp_credential_table)
      .where(condition)
      .returning({ kind: mcp_credential_table.kind });

    return rows.length > 0;
  }

  async deleteAll(serverId: string): Promise<void> {
    await db
      .delete(mcp_credential_table)
      .where(eq(mcp_credential_table.serverId, serverId));
  }
}

/** 进程内唯一的一份：管理器与回调路由必须看到同一份凭据。 */
export const mcpCredentialStore = new SqliteMcpCredentialStore();

/** 这个服务器有没有存过授权令牌；设置页据此决定「撤销」能不能点。 */
export async function hasMcpTokens(serverId: string): Promise<boolean> {
  return (await mcpCredentialStore.read(serverId, "tokens")) !== undefined;
}

/** 清掉一个服务器的全部凭据。改地址、删除服务器、撤销授权都走这里。 */
export async function clearMcpCredentials(serverId: string): Promise<void> {
  await mcpCredentialStore.deleteAll(serverId);
}
