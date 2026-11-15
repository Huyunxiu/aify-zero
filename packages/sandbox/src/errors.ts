/**
 * 沙箱层只有两类抛错：能力缺失和策略拒绝。其余都是结果字段——命令跑完、超时、
 * 取消都通过 `ExecResult` 表达。区分的理由是调用方要不要换策略：能力缺失要换
 * 工具，策略拒绝要换路径，两者都不该被当成「命令失败」。
 *
 * 环境死掉（容器被删、远端实例过期）将来也要一类错误。现在没有适配器会检测它，
 * 所以不加：等第一个真的需要区分「死了」和「没权限」的适配器出现时再加。
 */

/**
 * 路径越界：目标不在沙箱的根目录里。
 *
 * 这不是命令失败，也不是能力缺失，而是策略拒绝。调用方要把它原样交给模型看，
 * 否则模型会反复重试同一条路径。
 *
 * 读和写共用一类：对容器适配器来说，挂载集之外既不可写也不可读，一个「越界」
 * 概念就够了；`operation` 说明是哪一次调用被拒绝。
 */
export class SandboxPathDeniedError extends Error {
  readonly operation: string;
  readonly path: string;
  readonly roots: readonly string[];

  constructor(properties: {
    operation: string;
    path: string;
    roots: readonly string[];
  }) {
    super(
      `${properties.operation} is not allowed: ${properties.path} is outside the sandbox roots (${properties.roots.join(", ")})`
    );
    this.name = "SandboxPathDeniedError";
    this.operation = properties.operation;
    this.path = properties.path;
    this.roots = properties.roots;
  }
}

/**
 * 适配器不支持某个动词的某个选项。
 *
 * 必须在改动环境之前抛：调用方重试或换路，都不该看到一份写了一半的状态。
 */
export class SandboxOperationUnsupportedError extends Error {
  readonly operation: string;
  readonly backend: string;
  readonly options: readonly string[];

  constructor(properties: {
    operation: string;
    backend: string;
    options: readonly string[];
  }) {
    super(
      `${properties.backend} does not support ${properties.options.join(", ")} on ${properties.operation}`
    );
    this.name = "SandboxOperationUnsupportedError";
    this.operation = properties.operation;
    this.backend = properties.backend;
    this.options = properties.options;
  }
}
