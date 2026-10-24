/**
 * API server 的生命周期管理。
 *
 * 两种模式共用同一个“origin”概念：
 * - `owned`：在 `utilityProcess` 里启动随包携带的 `server-entry.js`；
 * - `attach`：连接一个已经在跑的 server（`apps/server` 或别的机器）。
 *
 * 默认 `auto`：`AIFY_API_ORIGIN` 优先；否则先探测默认端口，已经有 server
 * 就直接 attach，没有再启动内置的。这样开发期 `dev:server` 和
 * `dev:desktop` 可以同时开，打包后则默认自带 server。
 */
import { existsSync } from "node:fs";

import type { ApiServerStatus } from "@workspace/shared/api-status";
import { API_TOKEN_ENV } from "@workspace/shared/api-token";
import { utilityProcess } from "electron";
import type { UtilityProcess } from "electron";

import { parseServerReadyLine } from "./ready-line";
import {
  defaultServerOrigin,
  isLoopbackOrigin,
  isServerHealthy,
  normalizeServerOrigin,
} from "./server-origin";

export type ServerMode = "auto" | "attach" | "owned";

/** 启动内置 server 子进程所需的信息。 */
export interface ServerProcessOptions {
  /** 打包后的 server 入口（Forge 的第二个 main 产物）。 */
  readonly entry: string;
  /** 子进程工作目录：开发期是仓库根，打包后是 userData。 */
  readonly cwd: string;
  /** 完整环境变量；调用方负责补 `DATABASE_URL` / `AIFY_MIGRATIONS_DIR`。 */
  readonly env: NodeJS.ProcessEnv;
  /**
   * 注入子进程的 `AIFY_API_PORT`。传 0 让系统分配；省略时沿用 `env` 里的
   * 值。桌面转发不需要固定端口，所以默认由调用方传 0。
   */
  readonly port?: number;
}

/** 日志出口由主进程注入，便于复用 electron-log 的 scope。 */
export type ServerLogger = (message: string) => void;

/** `DesktopServer` 的依赖。 */
export interface DesktopServerOptions {
  readonly log: ServerLogger;
  /**
   * 每次需要时解析 per-install bearer token。用函数而不是字符串：模块加载
   * 阶段不应该读写用户目录，失败也要等到 `whenReady` 里统一弹窗。
   */
  readonly token: () => string;
  /**
   * `auto` 模式探测固定 origin 的次数。开发期多试几次，避免 `dev:server`
   * 还在 `tsx` 启动时被误判为“没有 server”；打包后保持 1 次，不拖慢启动。
   */
  readonly probeAttempts?: number;
  /** 两次探活之间的等待。 */
  readonly probeDelayMs?: number;
  /** 生命周期的状态推送；主进程据此更新渲染端的状态条。 */
  readonly onStatus?: (status: ApiServerStatus) => void;
}

const READY_TIMEOUT_MS = 20_000;
/** 优雅退出的上限；超过后升级成 SIGKILL，避免 App 退出被一个卡死的子进程拖住。 */
const STOP_TIMEOUT_MS = 5000;
const MAX_DIAGNOSTIC_CHARS = 8000;
const DEFAULT_PROBE_ATTEMPTS = 1;
const DEFAULT_PROBE_DELAY_MS = 250;
/** 本地探活不需要 1.5s；短超时让重试循环有上界。 */
const PROBE_TIMEOUT_MS = 500;
/** 意外退出后的重试次数与退避基数。 */
const MAX_RESTARTS = 3;
const RESTART_BASE_MS = 500;
/** 稳定运行超过这个时间后，重新计数；避免偶发崩溃累积到上限。 */
const RESTART_RESET_MS = 60_000;

/**
 * 一个由本类 fork 出来的 server 进程。
 *
 * 把“退出过一次”和 exit promise 放在一起，`stop()` 才能既等待正常退出，
 * 又不会在子进程已经退出时白等一个超时。
 */
interface OwnedChild {
  readonly process: UtilityProcess;
  readonly exited: Promise<void>;
  exitedAlready: boolean;
  /** 是否已经报告过 ready；只有 ready 之后的退出才自动重启。 */
  ready: boolean;
}

/** 读取并校验 `AIFY_SERVER_MODE`。 */
const readMode = (): ServerMode => {
  const raw = process.env.AIFY_SERVER_MODE ?? "auto";

  if (raw === "auto" || raw === "attach" || raw === "owned") {
    return raw;
  }

  throw new Error(
    `Invalid AIFY_SERVER_MODE: ${raw} (expected auto, attach, or owned)`
  );
};

/** 等待一段时间，不阻止 Node 退出。 */
const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });

export class DesktopServer {
  readonly #log: ServerLogger;
  readonly #onStatus: ((status: ApiServerStatus) => void) | undefined;
  readonly #resolveToken: () => string;
  readonly #probeAttempts: number;
  readonly #probeDelayMs: number;
  #token: string | undefined;
  #owned: OwnedChild | undefined;
  /** 正在进行的终止流程；并发的 stop() 要一起等它，而不是提前返回。 */
  #stopTask: Promise<void> | undefined;
  #origin: string | undefined;
  #lastSpawnOptions: ServerProcessOptions | undefined;
  #restartTimer: NodeJS.Timeout | undefined;
  #restartAttempts = 0;
  #readyAt: number | undefined;
  /** `stop()` / `attach()` 之后禁止任何在途的自动重启。 */
  #restartEnabled = true;
  #restarting = false;

  constructor({
    log,
    onStatus,
    probeAttempts = DEFAULT_PROBE_ATTEMPTS,
    probeDelayMs = DEFAULT_PROBE_DELAY_MS,
    token,
  }: DesktopServerOptions) {
    this.#log = log;
    this.#onStatus = onStatus;
    this.#resolveToken = token;
    this.#probeAttempts = Math.max(1, probeAttempts);
    this.#probeDelayMs = Math.max(0, probeDelayMs);
  }

  /** 当前转发目标；未就绪时为 undefined（协议 handler 返回 503）。 */
  get origin(): string | undefined {
    return this.#origin;
  }

  /**
   * 按 `AIFY_SERVER_MODE`（以及 `AIFY_API_ORIGIN`）决定 attach 还是自启。
   *
   * `owned` 优先于 `AIFY_API_ORIGIN`：模式说“始终自启”就不要再被一个
   * 遗留的 origin 环境变量悄悄改掉。
   *
   * @param options - 内置 server 的入口、目录与环境变量。
   * @returns 可用的 API origin。
   */
  async start(options: ServerProcessOptions): Promise<string> {
    this.#cancelRestart();
    this.#restartAttempts = 0;
    this.#restartEnabled = true;
    this.#restarting = false;
    this.#emitStatus({ state: "starting" });

    const mode = readMode();
    const configured = process.env.AIFY_API_ORIGIN?.trim();

    if (mode === "owned") {
      if (configured !== undefined && configured !== "") {
        this.#log("AIFY_API_ORIGIN is ignored because AIFY_SERVER_MODE=owned");
      }

      return await this.#spawn(options);
    }

    if (configured !== undefined && configured !== "") {
      return await this.attach(configured);
    }

    const origin = defaultServerOrigin();

    if (mode === "attach") {
      if (origin === undefined) {
        throw new Error(
          "AIFY_SERVER_MODE=attach needs a fixed port: AIFY_API_PORT=0 cannot be attached to"
        );
      }

      return await this.attach(origin);
    }

    // `AIFY_API_PORT=0` 时端口由系统分配，没有可探测的固定 origin，只能自启。
    if (origin !== undefined && (await this.#probe(origin))) {
      this.#log(`Attaching to the API server on ${origin}`);

      return await this.attach(origin);
    }

    return await this.#spawn(options);
  }

  /**
   * 切换到外部 server：健康检查通过后停掉内置子进程。
   *
   * @param origin - 外部 server 的 http(s) origin。
   * @returns 规范化后的 origin。
   */
  async attach(origin: string): Promise<string> {
    const normalized = normalizeServerOrigin(origin);

    this.#assertRemoteTokenAllowed(normalized);

    if (!(await this.#isHealthy(normalized))) {
      throw new Error(
        `No Aify Zero API server is listening on ${normalized} (GET /health failed)`
      );
    }

    this.#cancelRestart();
    this.#restartEnabled = false;
    await this.#stopOwned();
    this.#origin = normalized;
    this.#restarting = false;
    this.#emitStatus({ state: "ready", origin: normalized });
    this.#log(`Using API server ${normalized}`);

    return normalized;
  }

  /**
   * 停止内置 server；attach 目标只是被清空。
   *
   * 调用方可以 `await`：`before-quit` 靠它保证端口、数据库连接和子进程在
   * Electron 退出前已经收尾。
   */
  async stop(): Promise<void> {
    this.#cancelRestart();
    this.#restartEnabled = false;
    this.#restarting = false;
    this.#origin = undefined;
    await this.#stopOwned();
    this.#emitStatus({ state: "stopped" });
  }

  #isHealthy(origin: string): Promise<boolean> {
    return isServerHealthy(origin, this.#apiToken);
  }

  /**
   * 探活固定 origin，开发期允许短暂重试。
   *
   * `dev:server` 和 `dev:desktop` 同时启动时，tsx 往往比 Electron 慢一点；
   * 只探一次会让桌面端误判“没有外部 server”，转而自启一个临时端口的实例，
   * 之后 dev 期间的代码改动就不会经过 tsx watch。
   */
  async #probe(origin: string): Promise<boolean> {
    for (let attempt = 0; attempt < this.#probeAttempts; attempt++) {
      // A local server answers in milliseconds; a short timeout keeps the
      // retry loop bounded when something is squatting on the port.
      if (await isServerHealthy(origin, this.#apiToken, PROBE_TIMEOUT_MS)) {
        return true;
      }

      if (attempt < this.#probeAttempts - 1) {
        await delay(this.#probeDelayMs);
      }
    }

    return false;
  }

  /** 取消挂起的自动重启。 */
  #cancelRestart(): void {
    if (this.#restartTimer === undefined) {
      return;
    }

    clearTimeout(this.#restartTimer);
    this.#restartTimer = undefined;
  }

  #emitStatus(status: ApiServerStatus): void {
    this.#onStatus?.(status);
  }

  /**
   * ready 之后意外退出时，按退避重启。
   *
   * 只在 `#lastSpawnOptions` 存在时生效（也就是这个 server 由本类拥有）；
   * `stop()` / `attach()` 会先取消挂起的重启，所以正常退出不会被拉回来。
   */
  #scheduleRestart(): void {
    if (
      !this.#restartEnabled ||
      this.#restartTimer !== undefined ||
      this.#owned !== undefined
    ) {
      return;
    }

    const options = this.#lastSpawnOptions;
    if (options === undefined) {
      return;
    }

    if (this.#restartAttempts >= MAX_RESTARTS) {
      this.#log(
        `API server exited ${String(MAX_RESTARTS)} times in a row; not restarting`
      );
      this.#restarting = false;
      this.#emitStatus({ state: "unavailable" });
      return;
    }

    const waitMs = RESTART_BASE_MS * 2 ** this.#restartAttempts;
    this.#restartAttempts += 1;
    this.#log(
      `Restarting the API server in ${String(waitMs)}ms (attempt ${String(this.#restartAttempts)}/${String(MAX_RESTARTS)})`
    );

    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = undefined;

      if (!this.#restartEnabled || this.#origin !== undefined) {
        return;
      }

      void this.#spawn(options).catch((error: unknown) => {
        this.#log(
          `API server restart failed: ${error instanceof Error ? error.message : String(error)}`
        );
        this.#scheduleRestart();
      });
    }, waitMs);
    this.#restartTimer.unref();
  }

  /**
   * 远程 origin 必须显式提供 `AIFY_API_TOKEN`。
   *
   * 本机的 `/health` 也需要同一个令牌，所以不能拿一个自动生成的本机令牌
   * 去试远程 server——那只会得到 401，顺便把令牌发给对方。
   */
  #assertRemoteTokenAllowed(origin: string): void {
    if (isLoopbackOrigin(origin)) {
      return;
    }

    const configured = process.env[API_TOKEN_ENV]?.trim();

    if (configured === undefined || configured === "") {
      throw new Error(
        `Remote API server ${origin} requires AIFY_API_TOKEN to be set`
      );
    }
  }

  get #apiToken(): string {
    this.#token ??= this.#resolveToken();

    return this.#token;
  }

  async #stopOwned(): Promise<void> {
    const owned = this.#owned;

    if (owned === undefined) {
      // 另一个调用方（例如启动失败路径）已经在终止子进程：等它完成，
      // 否则退出流程可能先于 SIGKILL 结束。
      await this.#stopTask;
      return;
    }

    // 先断开引用，再等退出：迟到的 exit 事件看到 `#owned !== owned` 就不会
    // 去清空可能已经属于新 server 的 origin。
    this.#owned = undefined;

    const stopping = this.#terminate(owned);
    this.#stopTask = stopping;

    try {
      await stopping;
    } finally {
      if (this.#stopTask === stopping) {
        this.#stopTask = undefined;
      }
    }
  }

  async #terminate(owned: OwnedChild): Promise<void> {
    if (owned.exitedAlready) {
      return;
    }

    try {
      owned.process.kill();
    } catch {
      // 已经退出或进程尚未 spawn：下面的等待会立即看到 exit。
    }
    await this.#waitForExit(owned, STOP_TIMEOUT_MS);

    if (owned.exitedAlready) {
      return;
    }

    // utilityProcess.kill() 只发一次终止请求；迁移或 SSE 卡住时可能迟迟不退，
    // 这里升级成 SIGKILL，保证 App 能按时退出。
    const { pid } = owned.process;
    if (pid !== undefined) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // 已经退出：正常路径。
      }
    }

    await this.#waitForExit(owned, STOP_TIMEOUT_MS);
  }

  async #waitForExit(owned: OwnedChild, milliseconds: number): Promise<void> {
    await Promise.race([owned.exited, delay(milliseconds)]);
  }

  async #spawn(options: ServerProcessOptions): Promise<string> {
    this.#cancelRestart();
    this.#lastSpawnOptions = options;
    this.#readyAt = undefined;

    if (!existsSync(options.entry)) {
      throw new Error(
        `Bundled API server entry is missing: ${options.entry}. ` +
          "Run through `electron-forge start` (which builds it) or set AIFY_API_ORIGIN."
      );
    }

    await this.#stopOwned();

    // stop()/attach() 可能在上面 await 期间生效；此时不要再 fork 一个新进程。
    if (!this.#restartEnabled) {
      throw new Error("API server startup was cancelled");
    }

    this.#emitStatus({
      state: this.#restarting ? "restarting" : "starting",
    });
    this.#log(`Starting the bundled API server (${options.entry})`);

    const environment: NodeJS.ProcessEnv = {
      ...options.env,
      // The child must use the same token the main process will send, even when
      // the caller forgot to put it in `options.env`.
      [API_TOKEN_ENV]: this.#apiToken,
    };

    if (options.port !== undefined) {
      // 0 = OS-assigned. The ready line reports the real port, which is what the
      // main process forwards to; no fixed 18086 is needed in the default mode.
      environment.AIFY_API_PORT = String(options.port);
    }

    const child = utilityProcess.fork(options.entry, [], {
      cwd: options.cwd,
      env: environment,
      serviceName: "Aify Zero API",
      stdio: ["ignore", "pipe", "pipe"],
    });

    let resolveExited!: () => void;
    const exited = new Promise<void>((resolve) => {
      resolveExited = resolve;
    });
    let stderrBuffer = "";
    const owned: OwnedChild = {
      exited,
      exitedAlready: false,
      process: child,
      ready: false,
    };

    child.once("exit", (code) => {
      owned.exitedAlready = true;
      resolveExited();

      if (stderrBuffer.trim() !== "") {
        this.#log(`[stderr] ${stderrBuffer.trim()}`);
        stderrBuffer = "";
      }

      if (this.#owned !== owned) {
        return;
      }

      const wasReady = owned.ready;
      this.#owned = undefined;
      this.#origin = undefined;
      this.#log(`API server exited with code ${String(code)}`);

      if (!wasReady) {
        return;
      }

      // 稳定运行过一段时间再崩，按“新的一轮”计数，避免偶发崩溃累积到上限。
      if (
        this.#readyAt !== undefined &&
        Date.now() - this.#readyAt > RESTART_RESET_MS
      ) {
        this.#restartAttempts = 0;
      }

      this.#readyAt = undefined;
      this.#restarting = true;
      this.#emitStatus({ state: "restarting" });
      this.#scheduleRestart();
    });

    this.#owned = owned;

    let diagnostic = "";
    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk: string) => {
      diagnostic = (diagnostic + chunk).slice(-MAX_DIAGNOSTIC_CHARS);

      // stderr 也要进主进程日志：oRPC 的 onError、迁移警告都走 stderr，
      // 只留在内存里的话，服务起好之后用户和排障都看不到这些错误。
      stderrBuffer += chunk;
      const lines = stderrBuffer.split("\n");
      stderrBuffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.trim() !== "") {
          this.#log(`[stderr] ${line}`);
        }
      }
    });

    const origin = await new Promise<string>((resolve, reject) => {
      let settled = false;
      let buffer = "";
      const fail = (error: Error): void => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);
        // 超时或进程报错后不要留下一个还在跑的 server：它会占着端口，
        // 让下一次启动永久 attach 到一个半死的实例。
        void this.#stopOwned();
        reject(error);
      };
      const timer = setTimeout(() => {
        fail(
          new Error(
            `Timed out starting the API server after ${String(READY_TIMEOUT_MS)}ms` +
              (diagnostic === "" ? "" : `\n${diagnostic}`)
          )
        );
      }, READY_TIMEOUT_MS);

      child.stdout?.setEncoding("utf-8");
      child.stdout?.on("data", (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.trim() !== "") {
            this.#log(line);
          }

          const ready = parseServerReadyLine(line);

          if (ready !== undefined && !settled) {
            settled = true;
            clearTimeout(timer);
            resolve(ready.origin);
          }
        }
      });

      child.once("error", (type, location) => {
        fail(
          new Error(
            `API server process failed (${type} at ${location})${diagnostic}`
          )
        );
      });
      child.once("exit", (code) => {
        fail(
          new Error(
            `API server exited with code ${String(code)} before it became ready` +
              (diagnostic === "" ? "" : `\n${diagnostic}`)
          )
        );
      });
    });

    const normalized = normalizeServerOrigin(origin);

    owned.ready = true;
    this.#readyAt = Date.now();
    this.#restarting = false;
    this.#origin = normalized;
    this.#emitStatus({ state: "ready", origin: normalized });

    return normalized;
  }
}
