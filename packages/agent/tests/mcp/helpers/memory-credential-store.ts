import type {
  McpCredentialKind,
  McpCredentialRecord,
  McpCredentialStore,
} from "../../../src/mcp/oauth/store.js";

type Row = { value: unknown; generation: number };

/** 内存实现；测试里要能直接看见代次，所以把 `rows` 一起给出去。 */
export type MemoryCredentialStore = McpCredentialStore & {
  rows: Map<string, Row>;
};

/** 一份凭据在一张表里的位置。 */
function key(serverId: string, kind: McpCredentialKind): string {
  return `${serverId}:${kind}`;
}

export function createMemoryCredentialStore(): MemoryCredentialStore {
  const rows = new Map<string, Row>();

  return {
    rows,

    read<T>(
      serverId: string,
      kind: McpCredentialKind
    ): Promise<McpCredentialRecord<T> | undefined> {
      const row = rows.get(key(serverId, kind));

      return Promise.resolve(
        row === undefined
          ? undefined
          : { value: row.value as T, generation: row.generation }
      );
    },

    write<T>(
      serverId: string,
      kind: McpCredentialKind,
      value: T
    ): Promise<McpCredentialRecord<T>> {
      const generation = (rows.get(key(serverId, kind))?.generation ?? 0) + 1;
      rows.set(key(serverId, kind), { value, generation });

      return Promise.resolve({ value, generation });
    },

    delete(
      serverId: string,
      kind: McpCredentialKind,
      expectedGeneration?: number
    ): Promise<boolean> {
      const rowKey = key(serverId, kind);
      const row = rows.get(rowKey);

      if (row === undefined) {
        return Promise.resolve(false);
      }

      if (
        expectedGeneration !== undefined &&
        row.generation !== expectedGeneration
      ) {
        return Promise.resolve(false);
      }

      rows.delete(rowKey);

      return Promise.resolve(true);
    },

    deleteAll(serverId: string): Promise<void> {
      // Map 的迭代器支持边遍历边删。
      for (const rowKey of rows.keys()) {
        if (rowKey.startsWith(`${serverId}:`)) {
          rows.delete(rowKey);
        }
      }

      return Promise.resolve();
    },
  };
}
