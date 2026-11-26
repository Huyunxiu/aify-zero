import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { withoutHopByHop } from "./headers.js";
import { Recorder, ReplayBook } from "./record.js";
import { RuleBook } from "./rules.js";
import { loadScenario } from "./scenario.js";
import type { Rule, Scenario } from "./scenario.js";
import { writeChatCompletions } from "./writers/chat-completions.js";

/** 一次进来的请求里，场景与断言关心的部分。 */
export type { Rule, Scenario } from "./scenario.js";

export type FakeProviderRequest = {
  readonly method: string;
  readonly path: string;
  readonly stream: boolean;
  readonly model?: string;
  /**
   * The JSON body the request carried, parsed.
   *
   * An assertion reads it to see what the protocol made of the messages: the body is the
   * only place that shows the shape a provider receives.
   */
  readonly body: unknown;
};

export type FakeProvider = {
  /** `http://127.0.0.1:<port>/v1`；直接填进设置里的 baseURL。 */
  readonly baseURL: string;
  /** 到目前为止收到的请求，按顺序。断言「真的发了几次」用。 */
  readonly requests: readonly FakeProviderRequest[];
  close(): Promise<void>;
};

export type FakeProviderRecordOptions = {
  /** 真供应商的地址，例如 `https://api.deepseek.com/v1`。 */
  readonly url: string;
  /** 录制文件写到哪。 */
  readonly out: string;
  /** 追加到已有文件：跨审批暂停续录时用。 */
  readonly append?: boolean;
  /** 转发时额外带的头，例如 `authorization`。 */
  readonly headers?: Readonly<Record<string, string>>;
};

export type FakeProviderOptions = {
  /** 场景对象，或包根 `scenarios/` 里的名字 / 一个路径。 */
  readonly scenario?: Scenario | string;
  /** 开了就是代理模式：转发给真供应商，并把响应录下来。 */
  readonly record?: FakeProviderRecordOptions;
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
  const recording = options.record
    ? {
        record: options.record,
        recorder: new Recorder(options.record.out, options.record.append),
      }
    : undefined;
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

  const handle = async (
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

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
      body: parsed,
    };
    requests.push(seen);
    options.log?.(
      `${seen.method} ${seen.path} stream=${seen.stream} model=${seen.model ?? "-"}`
    );

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
    recorder: Recorder
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

    const captured: Buffer[] = [];
    for await (const piece of upstream.body ?? []) {
      captured.push(Buffer.from(piece));
      input.response.write(piece);
    }

    // 客户端读到响应结束时就会返回，之后可能立刻读录制文件；所以先落盘，再结束响应。
    try {
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
