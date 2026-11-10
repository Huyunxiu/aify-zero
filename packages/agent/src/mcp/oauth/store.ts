/**
 * 授权凭据的存储接口。
 *
 * 形状按语义给，不按键值给：`invalidateCredentials` 需要「代次没变才删」，
 * 通用的 get/set 会把这个语义丢给调用方拼，拼错时的表现是并发刷新时令牌被
 * 误删——不报错，只偶发。
 */

/** 一类凭据：令牌、动态注册信息、PKCE 与 state。 */
export type McpCredentialKind = "tokens" | "client" | "verifier";

export type McpCredentialRecord<T> = {
  value: T;
  /** 每次写入加一；删除时带上它，晚到的删除会落空。 */
  generation: number;
};

export interface McpCredentialStore {
  read<T>(
    serverId: string,
    kind: McpCredentialKind
  ): Promise<McpCredentialRecord<T> | undefined>;

  write<T>(
    serverId: string,
    kind: McpCredentialKind,
    value: T
  ): Promise<McpCredentialRecord<T>>;

  /**
   * 删除一类凭据。
   *
   * @param expectedGeneration - 给了就只在代次仍相同时删；返回是否真删掉。
   */
  delete(
    serverId: string,
    kind: McpCredentialKind,
    expectedGeneration?: number
  ): Promise<boolean>;

  /** 清掉一个服务器的全部凭据。 */
  deleteAll(serverId: string): Promise<void>;
}
