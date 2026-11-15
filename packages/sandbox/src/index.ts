/**
 * 沙箱契约的入口。
 *
 * 只导出两样东西：契约本身，和装配时真正要用的那几个工厂（本机、原生隔离、
 * Apple 容器、假适配器）。隔离策略的构造、容器 CLI 的细节这些是实现细节，测试
 * 直接按路径引用，不进公开面。
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
  SandboxPathDeniedError,
} from "./errors";
export {
  DEFAULT_APPLE_CONTAINER_IMAGE,
  createAppleContainerSandboxAdapter,
} from "./apple-container/adapter";
export type { AppleContainerOptions } from "./apple-container/adapter";
export {
  APPLE_CONTAINER_ADAPTER,
  createAppleContainerRuntime,
} from "./apple-container/runtime";
export type {
  ContainerCommandOptions,
  ContainerMount,
  ContainerProbeResult,
  ContainerRuntime,
  ContainerSpec,
} from "./apple-container/runtime";
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
