import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { TapeFrame, TapeRecorderOptions } from "../tape/index.js";
import {
  encodeFrameBytes,
  TapePlayer,
  TapeRecorder,
  tapeInputSchema,
  wallClock,
} from "../tape/index.js";
import { withoutHopByHop } from "./headers.js";
import { Recorder, ReplayBook } from "./record.js";
import { RuleBook } from "./rules.js";
import { loadScenario } from "./scenario.js";
import type { Rule, Scenario } from "./scenario.js";
import { writeChatCompletions } from "./writers/chat-completions.js";

/** 一次进来的请求里，场景与断言关心的部分。 */
export type FakeProviderRequest = {
  readonly method: string;
  readonly path: string;
  readonly stream: boolean;
  readonly model?: string;
};

export type FakeProvider = {
  /** `http://127.0.0.1:<port>/v1`；直接填进设置里的 baseURL。 */
  readonly baseURL: string;
  /** 到目前为止收到的请求，按顺序。断言「真的发了几次」用。 */
  readonly requests: readonly FakeProviderRequest[];
  /** 播放器状态；没开 `play` 就是 undefined。 */
  readonly tape?: TapePlaybackState;
  close(): Promise<void>;
};

export type FakeProviderRecordOptions = {
  /** 真供应商的地址，例如 `https://api.deepseek.com/v1`。 */
  readonly url: string;
  /** 旧格式（整条响应）写到哪；不给就只写录制带。 */
  readonly out?: string;
  /** 追加到已有文件：跨审批暂停续录时用。 */
  readonly append?: boolean;
  /** 转发时额外带的头，例如 `authorization`。 */
  readonly headers?: Readonly<Record<string, string>>;
};

export type FakeProviderPlaybackOptions = {
  /** 录制带路径。 */
  readonly path: string;
  /** 播放倍速；2 就是两倍速。 */
  readonly speed?: number;
  /** 相邻帧的最大等待；空闲超过它就截断。 */
  readonly capMs?: number;
  /** 播到第几帧就挂起；0 基。`POST /__tape/resume` 放行。 */
  readonly pauseAt?: number;
};

/** 播放器的状态；没开播放时 `FakeProvider.tape` 是 undefined。 */
export type TapePlaybackState = {
  readonly paused: boolean;
  readonly frames: number;
  readonly position: number;
  readonly remaining: number;
  readonly mode: "run" | "hold" | "step";
};

export type FakeProviderOptions = {
  /** 场景对象，或包根 `scenarios/` 里的名字 / 一个路径。 */
  readonly scenario?: Scenario | string;
  /** 开了就是代理模式：转发给真供应商，并把响应录下来。 */
  readonly record?: FakeProviderRecordOptions;
  /**
   * 录制带：把每条往返按帧写成一个 JSONL 文件。
   *
   * 只在代理模式里有内容。P0 不录场景模式生成的流。
   */
  readonly tape?: TapeRecorderOptions;
  /**
   * 播放录制带：请求按顺序换回录制里的响应。
   *
   * 与 `record` 互斥：一个回放，一个录制。
   */
  readonly play?: FakeProviderPlaybackOptions;
  /** 端口；缺省是 0，由系统挑一个。 */
  readonly port?: number;
  /**
   * 每处理一次请求喊一声。
   *
   * 手动验的时候，人最想知道的是「应用到底发了几次、每次拿到什么」；测试不传它。
   */
  readonly log?: (message: string) => void;
};

/**
 * 起一个假供应商。
 *
 * 它只说一种协议：chat completions。场景决定每一次请求得到什么，录制模式把真
 * 供应商的响应原样留下，之后 `replay` 动作按顺序放回来。
 */
export async function startFakeProvider(
  options: FakeProviderOptions = {}
): Promise<FakeProvider> {
  const scenario =
    typeof options.scenario === "string"
      ? await loadScenario(options.scenario)
      : options.scenario;
  const book = scenario ? new RuleBook(scenario.rules) : undefined;
  const replay = new ReplayBook();
  const tape =
    options.tape === undefined ? undefined : new TapeRecorder(options.tape);
  const recording = options.record
    ? {
        record: options.record,
        recorder:
          options.record.out === undefined
            ? undefined
            : new Recorder(options.record.out, options.record.append),
      }
    : undefined;
  const loadPlayer = async (
    play: FakeProviderPlaybackOptions
  ): Promise<TapePlayer> =>
    await TapePlayer.load({
      path: play.path,
      clock: wallClock({
        ...(play.speed === undefined ? {} : { speed: play.speed }),
        ...(play.capMs === undefined ? {} : { capMs: play.capMs }),
      }),
      ...(play.pauseAt === undefined ? {} : { pauseAt: play.pauseAt }),
      onHold: (frame) => {
        options.log?.(`paused at frame ${String(frame)}`);
      },
    });

  let player =
    options.play === undefined ? undefined : await loadPlayer(options.play);
  const requests: FakeProviderRequest[] = [];
  const fallbackModel = scenario?.models?.[0] ?? scenario?.name ?? "fake-model";

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      // 响应已经走完（比如录制失败）时不能再掐连接：客户端已经拿到完整响应，
      // 剩下要说的只是日志里那一行。
      if (response.writableEnded) {
        return;
      }

      if (response.headersSent) {
        response.destroy();
        return;
      }

      response.writeHead(500, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message: error instanceof Error ? error.message : String(error),
          },
        })
      );
    });
  });

  /** 控制面：一切 `/__tape/*` 都从这里走。 */
  const handleTape = async (
    action: string,
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> => {
    const fail = (status: number, message: string): void => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message } }));
    };

    if (action === "input") {
      if (tape === undefined) {
        fail(404, "no tape");
        return;
      }

      const raw = (await readBody(request)) ?? "{}";
      await tape.recordInput(tape.at(), tapeInputSchema.parse(JSON.parse(raw)));
      response.writeHead(204);
      response.end();
      return;
    }

    if (action === "load") {
      if (options.play === undefined) {
        fail(404, "no tape");
        return;
      }

      if (player?.busy === true) {
        fail(409, "tape is playing");
        return;
      }

      const raw = (await readBody(request)) ?? "{}";
      const parsed = JSON.parse(raw) as { path?: unknown };

      if (typeof parsed.path !== "string") {
        fail(400, "path is required");
        return;
      }

      player = await loadPlayer({
        ...options.play,
        path: parsed.path,
        pauseAt: undefined,
      });
      options.log?.(`loaded tape ${parsed.path}`);
      response.writeHead(204);
      response.end();
      return;
    }

    if (action === "state") {
      if (player === undefined) {
        fail(404, "no tape");
        return;
      }

      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          tape: player.path,
          position: player.position,
          remaining: player.remaining,
          frames: player.frames,
          mode: player.mode,
          paused: player.paused,
        })
      );
      return;
    }

    if (player === undefined) {
      fail(404, "no tape");
      return;
    }

    switch (action) {
      case "pause": {
        player.pause();
        break;
      }
      case "step": {
        player.step();
        break;
      }
      case "resume": {
        player.resume();
        break;
      }
      default: {
        fail(404, "not found");
        return;
      }
    }

    options.log?.(action);
    response.writeHead(204);
    response.end();
  };

  const handle = async (
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    if (url.pathname.startsWith("/__tape/")) {
      await handleTape(
        url.pathname.slice("/__tape/".length),
        request,
        response
      );
      return;
    }

    if (request.method === "GET" && url.pathname.endsWith("/models")) {
      const models = scenario?.models ?? [fallbackModel];
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          object: "list",
          data: models.map((id) => ({
            id,
            object: "model",
            created: 0,
            owned_by: "fake",
          })),
        })
      );
      return;
    }

    if (
      request.method !== "POST" ||
      !url.pathname.endsWith("/chat/completions")
    ) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }

    const body = (await readBody(request)) ?? "";
    const parsed =
      body === "" ? {} : (JSON.parse(body) as Record<string, unknown>);
    const seen: FakeProviderRequest = {
      method: request.method,
      path: url.pathname,
      stream: parsed.stream === true,
      ...(typeof parsed.model === "string" ? { model: parsed.model } : {}),
    };
    requests.push(seen);
    options.log?.(
      `${seen.method} ${seen.path} stream=${seen.stream} model=${seen.model ?? "-"}`
    );

    if (player !== undefined) {
      await player.play(response);
      return;
    }

    if (recording) {
      await proxy(
        { response, body, seen, url },
        recording.record,
        recording.recorder
      );
      return;
    }

    const rule = book?.take({ stream: seen.stream, model: seen.model });
    options.log?.(describeRule(rule));
    await writeChatCompletions({
      response,
      rule,
      model: seen.model ?? fallbackModel,
      replay,
      stream: seen.stream,
    });
  };

  /** 代理模式：转发给真供应商，边转发边把响应录下来。 */
  const proxy = async (
    input: {
      response: ServerResponse;
      body: string;
      seen: FakeProviderRequest;
      url: URL;
    },
    record: FakeProviderRecordOptions,
    recorder: Recorder | undefined
  ): Promise<void> => {
    const target = `${record.url.replace(/\/$/, "")}${input.url.pathname}${input.url.search}`;
    const upstream = await fetch(target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...record.headers,
      },
      body: input.body,
    });

    // 自己分帧：上游那些「由连接决定长度」的头不能跟着走，否则客户端收满上游
    // 声明的字节数就认为读完，不等本条连接结束 —— 录制还来不及落盘。
    const headers = withoutHopByHop(
      Object.fromEntries(upstream.headers.entries())
    );

    input.response.writeHead(upstream.status, headers);

    const startedAt = performance.now();
    const captured: Buffer[] = [];
    const frames: TapeFrame[] = [];
    for await (const piece of upstream.body ?? []) {
      const bytes = Buffer.from(piece);
      captured.push(bytes);
      frames.push({
        at: Math.round(performance.now() - startedAt),
        bytes: encodeFrameBytes(bytes),
      });
      input.response.write(piece);
    }

    const lastAt = frames.at(-1)?.at ?? 0;
    const tailMs = Math.max(
      0,
      Math.round(performance.now() - startedAt) - lastAt
    );

    // 客户端读到响应结束时就会返回，之后可能立刻读录制文件；所以先落盘，再结束响应。
    try {
      if (tape !== undefined) {
        await tape.recordRequest({
          at: tape.at(),
          method: input.seen.method,
          path: input.seen.path,
          stream: input.seen.stream,
          ...(input.seen.model === undefined
            ? {}
            : { model: input.seen.model }),
          body: input.body,
          status: upstream.status,
          headers,
          frames,
          tailMs,
        });
      }

      if (recorder !== undefined) {
        await recorder.add({
          request: {
            method: input.seen.method,
            path: input.seen.path,
            ...(input.seen.stream ? { stream: true } : {}),
            ...(input.seen.model ? { model: input.seen.model } : {}),
          },
          response: {
            status: upstream.status,
            headers,
            body: Buffer.concat(captured).toString("utf-8"),
          },
        });
      }
    } catch (error) {
      options.log?.(
        `record failed: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    } finally {
      input.response.end();
    }
  };

  await new Promise<void>((resolve) => {
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    get tape(): TapePlaybackState | undefined {
      if (player === undefined) {
        return undefined;
      }

      return {
        paused: player.paused,
        frames: player.frames,
        position: player.position,
        remaining: player.remaining,
        mode: player.mode,
      };
    },
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

/** 一条规则在终端里怎么念；场景用完时也要说清楚。 */
const describeRule = (rule: Rule | undefined): string => {
  if (!rule) {
    return "-> no rule left";
  }
  if (rule.fail !== undefined) {
    return `-> fail ${rule.fail}`;
  }
  if (rule.failMidStream) {
    return "-> fail mid-stream";
  }
  if (rule.replay !== undefined) {
    return `-> replay ${rule.replay}`;
  }
  if (rule.reset) {
    return "-> reset";
  }
  if (rule.corrupt) {
    return "-> corrupt";
  }
  if (rule.toolCall) {
    return `-> toolCall ${rule.toolCall.name}`;
  }

  return "-> answer";
};

const readBody = async (
  request: IncomingMessage
): Promise<string | undefined> => {
  const chunks: Buffer[] = [];
  for await (const piece of request) {
    chunks.push(Buffer.from(piece));
  }

  return chunks.length === 0
    ? undefined
    : Buffer.concat(chunks).toString("utf-8");
};
