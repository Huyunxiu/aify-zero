/**
 * 一条终端会话：WebSocket 和 PTY 之间的双向泵。
 *
 * 这一层不认 `ws`，只认 `TerminalTransport`。现在它由 `/api/terminal` 的
 * 升级路径提供；以后如果多个二进制功能合到一条多路复用连接上，只需要换一个
 * 传输适配器，协议解析、背压和 PTY 生命周期都不用重写。
 */
import { logger } from "@workspace/shared/logger";
import {
  decodeTerminalFrame,
  encodeTerminalServerControl,
} from "@workspace/shared/terminal-protocol";
import type { TerminalServerControl } from "@workspace/shared/terminal-protocol";

import type { SpawnShellPty, TerminalPty, TerminalSubscription } from "./pty";

/** 会话层需要的传输能力。 */
export interface TerminalTransport {
  /** 已经排队但还没写进 socket 的字节数。 */
  readonly bufferedAmount: number;
  close(code: number, reason: string): void;
  onClose(listener: () => void): void;
  onMessage(listener: (data: Uint8Array, isBinary: boolean) => void): void;
  send(data: Uint8Array | string): void;
}

/** 建立一条终端会话需要的参数。 */
export interface TerminalSessionOptions {
  readonly cols: number;
  readonly cwd: string;
  readonly rows: number;
  readonly spawn: SpawnShellPty;
}

/** 会话句柄；关闭流程重复调用是安全的。 */
export interface TerminalSessionHandle {
  dispose(): void;
}

/** 输出积压到这个量就暂停 PTY，避免内存随输出一起涨。 */
const OUTPUT_HIGH_WATER = 1024 * 1024;

/** 降到这个量以下再恢复 PTY。 */
const OUTPUT_LOW_WATER = 256 * 1024;

/** 检查积压的间隔；16 ms 约等于一帧。 */
const OUTPUT_RESUME_INTERVAL_MS = 16;

/**
 * 接管一条已经升级的连接，并在给定的工作目录里启动 shell。
 *
 * @param transport - 连接适配器。
 * @param options - 尺寸、目录和 PTY 工厂。
 * @returns 手动关闭会话的句柄；连接自己关闭时也会走同一套清理。
 */
export function acceptTerminal(
  transport: TerminalTransport,
  options: TerminalSessionOptions
): TerminalSessionHandle {
  let disposed = false;
  let pty: TerminalPty | null = null;
  let resumeTimer: NodeJS.Timeout | null = null;
  const subscriptions: TerminalSubscription[] = [];

  const clearResumeTimer = (): void => {
    if (resumeTimer !== null) {
      clearInterval(resumeTimer);
      resumeTimer = null;
    }
  };

  const dispose = (): void => {
    if (disposed) {
      return;
    }

    disposed = true;
    clearResumeTimer();

    for (const subscription of subscriptions.splice(0)) {
      try {
        subscription.dispose();
      } catch {
        // 监听器已经随流关闭时释放可能抛错；清理路径继续往下走。
      }
    }

    const processPty = pty;
    pty = null;

    try {
      processPty?.kill();
    } catch {
      // 进程已经退出时 kill 会抛错，忽略即可。
    }
  };

  const sendControl = (control: TerminalServerControl): void => {
    if (disposed) {
      return;
    }

    try {
      transport.send(encodeTerminalServerControl(control));
    } catch (error) {
      logger.warn("[terminal] control message was not sent", error);
    }
  };

  /** 连接自己关闭时，先杀掉 shell，避免留下孤儿进程。 */
  transport.onClose(dispose);

  transport.onMessage((data, isBinary) => {
    if (disposed) {
      return;
    }

    if (!isBinary) {
      transport.close(1003, "binary frames required");

      return;
    }

    if (data.byteLength === 0) {
      return;
    }

    let frame: ReturnType<typeof decodeTerminalFrame>;

    try {
      frame = decodeTerminalFrame(data);
    } catch (error) {
      logger.warn(
        `[terminal] invalid frame: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      transport.close(1008, "invalid terminal frame");

      return;
    }

    if (frame.kind === "input") {
      if (frame.data.byteLength === 0) {
        return;
      }

      try {
        pty?.write(frame.data);
      } catch (error) {
        logger.warn("[terminal] input could not be written", error);
        transport.close(1011, "input failed");
      }

      return;
    }

    try {
      pty?.resize(frame.control.cols, frame.control.rows);
    } catch (error) {
      logger.warn("[terminal] resize failed", error);
      transport.close(1011, "resize failed");
    }
  });

  try {
    pty = options.spawn({
      cols: options.cols,
      cwd: options.cwd,
      rows: options.rows,
    });
  } catch (error) {
    logger.warn("[terminal] shell could not start", error);
    sendControl({
      message: error instanceof Error ? error.message : String(error),
      type: "error",
    });
    dispose();
    transport.close(1011, "shell failed");

    return { dispose };
  }

  const processPty = pty;

  subscriptions.push(
    processPty.onData((data) => {
      if (disposed) {
        return;
      }

      try {
        transport.send(data);
      } catch (error) {
        logger.warn("[terminal] output could not be sent", error);
        dispose();
        transport.close(1011, "output failed");

        return;
      }

      if (
        resumeTimer === null &&
        transport.bufferedAmount > OUTPUT_HIGH_WATER
      ) {
        processPty.pause();
        resumeTimer = setInterval(() => {
          if (disposed) {
            return;
          }

          if (transport.bufferedAmount <= OUTPUT_LOW_WATER) {
            clearResumeTimer();
            processPty.resume();
          }
        }, OUTPUT_RESUME_INTERVAL_MS);
        // 定时器不该拖住进程退出；连接关闭时会主动清掉。
        resumeTimer.unref();
      }
    })
  );

  subscriptions.push(
    processPty.onExit(({ exitCode }) => {
      if (disposed) {
        return;
      }

      sendControl({ exitCode, type: "exit" });
      dispose();
      transport.close(1000, "Process exited");
    })
  );

  sendControl({ cwd: options.cwd, pid: processPty.pid, type: "ready" });

  return { dispose };
}
