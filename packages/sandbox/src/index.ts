/**
 * 沙箱契约的入口。
 *
 * 只导出契约本身与本机适配器；`@workspace/sandbox/paths` 保持可达，供需要
 * 单独归一化路径的调用方使用。
 */
export type {
  AcquireSandboxInput,
  DirEntry,
  ExecOptions,
  ExecResult,
  ExistsOptions,
  FileStat,
  Sandbox,
  SandboxAdapter,
  SandboxDescription,
  SandboxHandle,
  ShellKind,
} from "./types";
export {
  SandboxDiedError,
  SandboxOperationUnsupportedError,
  SandboxWriteDeniedError,
} from "./errors";
export {
  HOST_BACKEND,
  createHostSandbox,
  createHostSandboxAdapter,
} from "./host/adapter";
export { runShell } from "./exec";
export {
  ISOLATED_ADAPTER,
  createIsolatedSandboxAdapter,
  probeNativeIsolation,
} from "./isolated/adapter";
export type {
  IsolationProbeResult,
  IsolatedSandboxOptions,
} from "./isolated/adapter";
export type { IsolationBackend } from "./isolated/policy";
export {
  SEATBELT_BINARY,
  buildBwrapInvocation,
  buildSeatbeltInvocation,
  buildSeatbeltProfile,
  buildWritePolicy,
  detectBackend,
  isWritablePath,
} from "./isolated/policy";
export type { WritePolicyInput } from "./isolated/policy";
export { createFakeSandbox, createFakeSandboxAdapter } from "./testing/fake";
export type { FakeSandbox, FakeSandboxOptions } from "./testing/fake";
export type { ShellRunOptions, ShellRunResult } from "./exec";
