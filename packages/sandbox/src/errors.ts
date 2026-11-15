/**
 * 沙箱层的错误只有两类，其余都是结果字段。区分的理由是调用方要不要换策略：
 * 环境死了要重建，能力不支持要换工具，两者都不该被当成「命令失败」。
 */

/** 适配器那一侧的环境没了：容器被删、远端实例过期。 */
export class SandboxDiedError extends Error {
  readonly operation: string;
  readonly reason: "stopped" | "unreachable";

  constructor(properties: {
    operation: string;
    reason: "stopped" | "unreachable";
    cause?: unknown;
  }) {
    super(`Sandbox died during ${properties.operation}: ${properties.reason}`, {
      cause: properties.cause,
    });
    this.name = "SandboxDiedError";
    this.operation = properties.operation;
    this.reason = properties.reason;
  }
}

/**
 * 写入越界：目标不在沙箱的可写根里。
 *
 * 这不是命令失败，也不是能力缺失，而是策略拒绝。调用方要把它原样交给模型看，
 * 否则模型会反复重试同一条路径。
 */
export class SandboxWriteDeniedError extends Error {
  readonly operation: string;
  readonly path: string;
  readonly roots: readonly string[];

  constructor(properties: {
    operation: string;
    path: string;
    roots: readonly string[];
  }) {
    super(
      `${properties.operation} is not allowed: ${properties.path} is outside the sandbox's writable roots (${properties.roots.join(", ")})`
    );
    this.name = "SandboxWriteDeniedError";
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
