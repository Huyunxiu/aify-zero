import type { McpServerConfig } from "../config";

/** 待完成的授权流程；十分钟还没回来就当用户放弃了。 */
const DEFAULT_TTL_MS = 10 * 60 * 1000;

type Flow = {
  /**
   * 发起授权时那份配置的快照。
   *
   * 回调不带身份，只认 `state`；把配置放在这里，回调就不必再去读设置，
   * 也能保证换令牌用的是发起时的那份地址。
   */
  server: McpServerConfig;
  createdAt: number;
};

/**
 * `state` 到配置快照的待授权表。
 *
 * 只放内存：一次浏览器授权最多十分钟，进程重启后让用户再点一次，比给临时
 * 状态建一张表、再写一套过期清理便宜。回环回调靠它找回是哪个服务器。
 */
export class McpAuthorizationFlows {
  readonly #flows = new Map<string, Flow>();
  readonly #ttlMs: number;

  constructor(options: { ttlMs?: number } = {}) {
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  register(state: string, server: McpServerConfig): void {
    this.#flows.set(state, { server, createdAt: Date.now() });
  }

  /** 取走并作废一条；过期与未知一律当不存在。 */
  take(state: string): McpServerConfig | undefined {
    const flow = this.#flows.get(state);
    if (flow === undefined) {
      return undefined;
    }

    this.#flows.delete(state);

    return Date.now() - flow.createdAt > this.#ttlMs ? undefined : flow.server;
  }

  /** 某个服务器重新发起或撤销授权时，把它的旧流程一起作废。 */
  forget(serverId: string): void {
    for (const [state, flow] of this.#flows) {
      if (flow.server.id === serverId) {
        this.#flows.delete(state);
      }
    }
  }

  get size(): number {
    return this.#flows.size;
  }
}
