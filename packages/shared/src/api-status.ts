/**
 * API server 的生命周期状态。
 *
 * 主进程在启动、重启、失败时推给渲染端；桌面壳用它显示状态条，浏览器里
 * 没有这个桥接，状态始终是 undefined。
 */
export type ApiServerState =
  | "starting"
  | "ready"
  | "restarting"
  | "unavailable"
  | "stopped";

export interface ApiServerStatus {
  readonly state: ApiServerState;
  /** ready 时是实际 origin；其他状态通常为空。 */
  readonly origin?: string;
  /** 可选的人类可读原因，用于 unavailable。 */
  readonly message?: string;
}
