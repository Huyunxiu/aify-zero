/**
 * 会话面板里的终端视图。
 *
 * 终端不是浏览器里的模拟器：它通过 `/api/terminal` 连接服务端的真实 PTY。
 * 核心用 Ghostty WASM，渲染和输入交给 `@wterm/react`；传输用
 * `WebSocketTransport`，这样发送队列、背压和关闭行为都由它统一处理。
 *
 * 面板切换标签和收起面板时，这个组件不会卸载。隐藏期间必须关掉 WTerm 的
 * 自动 fit：`ResizeObserver` 在 `display: none` 时上报 0 尺寸，否则会把 PTY
 * 改成 1×1。重新显示时再 fit 一次。
 */
import {
  encodeTerminalControl,
  encodeTerminalInput,
  parseTerminalServerControl,
} from "@workspace/shared/terminal-protocol";
import type { TerminalClientControl } from "@workspace/shared/terminal-protocol";
import { Button } from "@workspace/ui/components/button";
import { WebSocketTransport } from "@wterm/core";
import type { WTerm } from "@wterm/dom";
import { GhosttyCore } from "@wterm/ghostty";
import ghosttyWasmUrl from "@wterm/ghostty/ghostty-vt.wasm?url";
import { Terminal, useTerminal } from "@wterm/react";
import { RotateCcwIcon } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { resolveTerminalUrl } from "../../lib/terminal-socket";

import "@wterm/dom/css";

import "./terminal-view.css";

/** 传输建立之前最多缓存这么多输入字节。 */
const PENDING_INPUT_LIMIT = 64 * 1024;

type TerminalStatus =
  | "loading"
  | "connecting"
  | "open"
  | "exited"
  | "closed"
  | "error";

export interface TerminalViewProps {
  /** 当前标签是否可见，并且面板没有收起。 */
  readonly active: boolean;
  readonly sessionId: string;
}

interface TerminalRuntimeProps extends TerminalViewProps {
  readonly onRestart: () => void;
}

/**
 * 终端视图的入口。
 *
 * 重启靠换 key 重建整个运行时：旧的 WebSocket、WTerm 和 Ghostty 实例一起
 * 释放，不会留下上一只 shell 的监听器。
 */
export function TerminalView({ active, sessionId }: TerminalViewProps) {
  const [generation, setGeneration] = React.useState(0);

  return (
    <TerminalRuntime
      active={active}
      key={generation}
      onRestart={() => setGeneration((value) => value + 1)}
      sessionId={sessionId}
    />
  );
}

/**
 * 一次终端生命周期：加载核心、建立连接、把 PTY 输出写进 WTerm。
 */
function TerminalRuntime({
  active,
  onRestart,
  sessionId,
}: TerminalRuntimeProps) {
  const { t } = useTranslation();
  const { focus, ref } = useTerminal();
  const [core, setCore] = React.useState<GhosttyCore | null>(null);
  const [status, setStatus] = React.useState<TerminalStatus>("loading");
  const [cwd, setCwd] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<string | null>(null);
  const [exitCode, setExitCode] = React.useState<number | null>(null);

  const transportRef = React.useRef<WebSocketTransport | null>(null);
  const wtermRef = React.useRef<WTerm | null>(null);
  const coreRef = React.useRef<GhosttyCore | null>(null);
  const pendingFramesRef = React.useRef<Uint8Array[]>([]);
  const pendingBytesRef = React.useRef(0);
  const activeRef = React.useRef(active);
  const aliveRef = React.useRef(true);
  const exitedRef = React.useRef(false);

  const fail = React.useCallback((error: unknown): void => {
    setStatus("error");
    setDetail(error instanceof Error ? error.message : String(error));
  }, []);

  /** 关闭连接并丢掉还没送出的输入；重复调用安全。 */
  const closeTransport = React.useCallback((): void => {
    const transport = transportRef.current;

    transportRef.current = null;
    pendingFramesRef.current = [];
    pendingBytesRef.current = 0;

    try {
      transport?.close();
    } catch {
      // 连接已经关闭时 close 可能抛错；清理路径不需要再处理。
    }
  }, []);

  /**
   * 发一帧给服务端。连接还没建立时先排队；队列有上限，避免 IPC 等待期间
   * 无限积累粘贴内容。
   */
  const sendFrame = React.useCallback(
    (frame: Uint8Array): void => {
      const transport = transportRef.current;

      if (transport === null) {
        if (pendingBytesRef.current + frame.byteLength > PENDING_INPUT_LIMIT) {
          setStatus("error");
          setDetail(t("terminal.inputBufferFull"));

          return;
        }

        pendingFramesRef.current.push(frame);
        pendingBytesRef.current += frame.byteLength;

        return;
      }

      try {
        transport.send(frame);
      } catch {
        setStatus("error");
        setDetail(t("terminal.inputBufferFull"));
      }
    },
    [t]
  );

  const sendControl = React.useCallback(
    (control: TerminalClientControl): void => {
      sendFrame(encodeTerminalControl(control));
    },
    [sendFrame]
  );

  const handleTransportData = React.useCallback(
    (data: Uint8Array | string): void => {
      if (typeof data !== "string") {
        wtermRef.current?.write(data);

        return;
      }

      const control = parseTerminalServerControl(data);

      if (control === null) {
        return;
      }

      if (control.type === "ready") {
        setCwd(control.cwd);
        setStatus("open");

        return;
      }

      if (control.type === "exit") {
        exitedRef.current = true;
        setExitCode(control.exitCode);
        setStatus("exited");

        return;
      }

      setStatus("error");
      setDetail(control.message);
    },
    []
  );

  const connect = React.useCallback(
    async (wt: WTerm): Promise<void> => {
      if (transportRef.current !== null) {
        return;
      }

      let url: string;

      try {
        url = await resolveTerminalUrl({
          cols: wt.cols,
          rows: wt.rows,
          sessionId,
        });
      } catch (error) {
        fail(error);

        return;
      }

      if (transportRef.current !== null || !aliveRef.current) {
        return;
      }

      const transport = new WebSocketTransport({
        onClose: () => {
          if (!exitedRef.current) {
            setStatus((current) => (current === "error" ? current : "closed"));
          }
        },
        onData: handleTransportData,
        onError: () => {
          setStatus("error");
          setDetail(t("terminal.connectionFailed"));
        },
        onOpen: () => {
          if (!exitedRef.current) {
            setStatus((current) => (current === "error" ? current : "open"));
          }
        },
        reconnect: false,
        url,
      });

      transportRef.current = transport;

      try {
        transport.connect();

        for (const frame of pendingFramesRef.current.splice(0)) {
          transport.send(frame);
        }

        pendingBytesRef.current = 0;

        // 初始尺寸随连接一起送达；后面 onResize 只发变化。
        transport.send(
          encodeTerminalControl({
            cols: wt.cols,
            rows: wt.rows,
            type: "resize",
          })
        );
      } catch (error) {
        fail(error);

        return;
      }

      if (activeRef.current) {
        focus();
      }
    },
    [fail, focus, handleTransportData, sessionId, t]
  );

  const handleReady = React.useCallback(
    (wt: WTerm): void => {
      wtermRef.current = wt;
      wt.autoResize = activeRef.current;

      // 先用真实容器尺寸算一次，再把行列数作为 PTY 的初始大小。
      if (activeRef.current) {
        wt.fit();
      }

      void connect(wt);
    },
    [connect]
  );

  const handleData = React.useCallback(
    (data: string): void => {
      sendFrame(encodeTerminalInput(data));
    },
    [sendFrame]
  );

  const handleBinary = React.useCallback(
    (data: Uint8Array): void => {
      sendFrame(encodeTerminalInput(data));
    },
    [sendFrame]
  );

  const handleResize = React.useCallback(
    (cols: number, rows: number): void => {
      if (cols < 1 || rows < 1) {
        return;
      }

      sendControl({ cols, rows, type: "resize" });
    },
    [sendControl]
  );

  const handleWorkingDirectory = React.useCallback((uri: string): void => {
    if (uri === "") {
      setCwd(null);

      return;
    }

    try {
      setCwd(decodeURIComponent(new URL(uri).pathname));
    } catch {
      setCwd(uri);
    }
  }, []);

  const handleTerminalError = React.useCallback(
    (error: unknown): void => {
      fail(error);
    },
    [fail]
  );

  // 核心只属于这一次生命周期；重建时先关连接，再释放 WASM 实例。
  React.useEffect(() => {
    let cancelled = false;

    aliveRef.current = true;

    GhosttyCore.load({ wasmPath: ghosttyWasmUrl })
      .then((loaded) => {
        if (cancelled) {
          loaded.dispose();

          return;
        }

        coreRef.current = loaded;
        setCore(loaded);
        setStatus("connecting");
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          fail(error);
        }
      });

    return () => {
      cancelled = true;
      aliveRef.current = false;
      closeTransport();
      coreRef.current?.dispose();
      coreRef.current = null;
    };
  }, [closeTransport, fail]);

  // 隐藏时关掉自动 fit，避免 0 尺寸被当成 1×1 发给 PTY。
  React.useLayoutEffect(() => {
    activeRef.current = active;

    const wt = wtermRef.current;

    if (wt === null) {
      return;
    }

    wt.autoResize = active;

    if (!active) {
      return;
    }

    const frame = requestAnimationFrame(() => {
      wt.fit();
      focus();
    });

    return () => {
      cancelAnimationFrame(frame);
    };
  }, [active, focus]);

  const statusLabel =
    status === "exited"
      ? t("terminal.exited", { code: exitCode ?? 0 })
      : status === "closed"
        ? t("terminal.closed")
        : status === "error"
          ? t("terminal.error")
          : status === "open"
            ? null
            : t("terminal.connecting");

  return (
    <div className="terminal-view flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-4">
        <span
          className="min-w-0 flex-1 truncate text-muted-foreground text-sm"
          title={cwd ?? undefined}
        >
          {cwd ?? t("terminal.connecting")}
        </span>
        {statusLabel === null ? null : (
          <span
            aria-live="polite"
            className="shrink-0 text-muted-foreground text-xs"
            title={detail ?? undefined}
          >
            {statusLabel}
          </span>
        )}
        <Button
          aria-label={t("terminal.restart")}
          className="shrink-0"
          onClick={onRestart}
          size="icon-sm"
          variant="ghost"
        >
          <RotateCcwIcon className="size-4" />
        </Button>
      </div>
      <div className="relative min-h-0 flex-1">
        {core === null ? (
          <div className="flex h-full items-center justify-center p-6">
            <p className="max-w-md text-center text-muted-foreground text-sm">
              {status === "error"
                ? (detail ?? t("terminal.error"))
                : t("terminal.connecting")}
            </p>
          </div>
        ) : (
          <Terminal
            aria-label={t("terminal.label")}
            autoResize
            className="h-full w-full"
            core={core}
            maxImageHeight={480}
            maxImageWidth={640}
            onBinary={handleBinary}
            onData={handleData}
            onError={handleTerminalError}
            onReady={handleReady}
            onResize={handleResize}
            onWorkingDirectory={handleWorkingDirectory}
            ref={ref}
            renderingPaused={!active}
            scrollbackLines={1000}
          />
        )}
      </div>
    </div>
  );
}
