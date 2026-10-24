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

import { utilityProcess } from "electron";
import type { UtilityProcess } from "electron";

import {
  defaultServerOrigin,
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
}

/** 日志出口由主进程注入，便于复用 electron-log 的 scope。 */
export type ServerLogger = (message: string) => void;

const READY_TIMEOUT_MS = 20_000;
const MAX_DIAGNOSTIC_CHARS = 8000;

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

export class DesktopServer {
  readonly #log: ServerLogger;
  #child: UtilityProcess | undefined;
  #origin: string | undefined;
  #stopping = false;

  constructor(log: ServerLogger) {
    this.#log = log;
  }

  /** 当前转发目标；未就绪时为 undefined（协议 handler 返回 503）。 */
  get origin(): string | undefined {
    return this.#origin;
  }

  /**
   * 按 `AIFY_API_ORIGIN` / `AIFY_SERVER_MODE` 决定 attach 还是自启。
   *
   * @param options - 内置 server 的入口、目录与环境变量。
   * @returns 可用的 API origin。
   */
  async start(options: ServerProcessOptions): Promise<string> {
    const configured = process.env.AIFY_API_ORIGIN?.trim();

    if (configured !== undefined && configured !== "") {
      return await this.attach(configured);
    }

    const mode = readMode();
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
    if (
      mode === "auto" &&
      origin !== undefined &&
      (await isServerHealthy(origin))
    ) {
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

    if (!(await isServerHealthy(normalized))) {
      throw new Error(
        `No Aify Zero API server is listening on ${normalized} (GET /health failed)`
      );
    }

    this.#stopOwned();
    this.#origin = normalized;
    this.#log(`Using API server ${normalized}`);

    return normalized;
  }

  /** 停止内置 server；attach 目标只是被清空。 */
  stop(): void {
    this.#stopOwned();
    this.#origin = undefined;
  }

  #stopOwned(): void {
    const child = this.#child;

    if (child === undefined) {
      return;
    }

    this.#child = undefined;
    this.#stopping = true;
    child.kill();
  }

  async #spawn(options: ServerProcessOptions): Promise<string> {
    if (!existsSync(options.entry)) {
      throw new Error(
        `Bundled API server entry is missing: ${options.entry}. ` +
          "Run through `electron-forge start` (which builds it) or set AIFY_API_ORIGIN."
      );
    }

    this.#stopOwned();
    this.#stopping = false;
    this.#log(`Starting the bundled API server (${options.entry})`);

    const child = utilityProcess.fork(options.entry, [], {
      cwd: options.cwd,
      env: options.env,
      serviceName: "Aify Zero API",
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.#child = child;

    let diagnostic = "";
    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk: string) => {
      diagnostic = (diagnostic + chunk).slice(-MAX_DIAGNOSTIC_CHARS);
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
        this.#stopOwned();
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
          if (!line.startsWith("{")) {
            continue;
          }

          try {
            // 不能用前缀匹配：JSON 的键顺序由产生方决定。按字段判断。
            const ready = JSON.parse(line) as {
              origin?: unknown;
              type?: unknown;
            };

            if (
              ready.type === "ready" &&
              typeof ready.origin === "string" &&
              !settled
            ) {
              settled = true;
              clearTimeout(timer);
              resolve(ready.origin);
            }
          } catch {
            // 不是就绪行：上面已经当成普通日志转发了。
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

    this.#origin = normalized;

    // 进程在就绪后意外退出时，让请求立刻得到 503，而不是等 TCP 超时。
    child.once("exit", (code) => {
      if (this.#stopping) {
        return;
      }

      this.#origin = undefined;
      this.#log(`API server exited with code ${String(code)}`);
    });

    return normalized;
  }
}
