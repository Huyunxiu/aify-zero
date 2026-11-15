/**
 * 沙箱契约的入口。
 *
 * 只导出两样东西：契约本身，和装配时真正要用的那三个工厂（本机、原生隔离、
 * 假适配器）。隔离策略的构造、进程内核这些是实现细节，测试直接按路径引用，
 * 不进公开面。
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
  SandboxOperationUnsupportedError,
  SandboxWriteDeniedError,
} from "./errors";
export {
  HOST_BACKEND,
  createHostSandbox,
  createHostSandboxAdapter,
} from "./host/adapter";
export {
  ISOLATED_ADAPTER,
  createIsolatedSandboxAdapter,
  probeNativeIsolation,
} from "./isolated/adapter";
export type {
  IsolationProbeResult,
  IsolatedSandboxOptions,
} from "./isolated/adapter";
export { createFakeSandbox, createFakeSandboxAdapter } from "./testing/fake";
export type { FakeSandbox, FakeSandboxOptions } from "./testing/fake";
