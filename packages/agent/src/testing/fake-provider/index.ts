import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { failRecord, proxyAndRecord, Recorder, ReplayBook } from "./record.js";
import { sendError } from "./respond.js";
import type { FakeProviderRequest } from "./rules.js";
import { RuleBook } from "./rules.js";
import { loadScenario, scenarioSchema } from "./scenario.js";
import type { Rule, Scenario, ScenarioInput } from "./scenario.js";
import { writeChatCompletions } from "./writers/chat-completions.js";

export type { FakeProviderRequest } from "./rules.js";

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
  /** 录制文件写到哪；目录不存在会自己建。 */
  readonly out: string;
  /** 追加到已有文件：跨审批暂停续录时用。 */
  readonly append?: boolean;
  /** 转发时额外带的头，例如 `authorization`。 */
  readonly headers?: Readonly<Record<string, string>>;
};

export type FakeProviderOptions = {
  /**
   * 场景：包根 `scenarios/` 里的名字、一个路径，或者写在代码里的同一份 JSON。
   *
   * 代码里写的那份也要过同一遍校验：测试用的场景和仓库里的场景不该有两套规则。
   */
  readonly scenario?: ScenarioInput | string;
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
 * 供应商的响应原样留下，之后 `replay` 结果按顺序放回来。
 */
export async function startFakeProvider(
  options: FakeProviderOptions = {}
): Promise<FakeProvider> {
  const scenario = await resolveScenario(options.scenario);
  const book = scenario ? new RuleBook(scenario.rules) : undefined;
  const replay = new ReplayBook();
  const recorder = options.record
    ? new Recorder(options.record.out, options.record.append)
    : undefined;
  const requests: FakeProviderRequest[] = [];
  const fallbackModel = scenario?.models?.[0] ?? scenario?.name ?? "fake-model";

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      sendError(
        response,
        500,
        error instanceof Error ? error.message : String(error)
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
      sendError(response, 404, "not found");
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

    if (options.record && recorder) {
      try {
        await proxyAndRecord({
          response,
          body,
          request: seen,
          target: `${options.record.url.replace(/\/$/, "")}${url.pathname}${url.search}`,
          headers: options.record.headers ?? {},
          recorder,
        });
      } catch (error) {
        failRecord(response, error);
      }
      return;
    }

    const rule = book?.take({ stream: seen.stream, model: seen.model });
    options.log?.(`  ${describeRule(rule)}`);
    await writeChatCompletions({
      response,
      rule,
      model: seen.model ?? fallbackModel,
      replay,
    });
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

/** 名字走加载器，代码里写的那份走同一套 schema。 */
const resolveScenario = async (
  scenario: FakeProviderOptions["scenario"]
): Promise<Scenario | undefined> => {
  if (scenario === undefined) {
    return undefined;
  }

  return typeof scenario === "string"
    ? await loadScenario(scenario)
    : scenarioSchema.parse(scenario);
};

/** 一条规则在终端里怎么念；场景用完时也要说清楚。 */
const describeRule = (rule: Rule | undefined): string => {
  if (!rule) {
    return "-> no rule left";
  }

  switch (rule.kind) {
    case "answer": {
      return "-> answer";
    }
    case "fail": {
      return `-> fail ${rule.fail}`;
    }
    case "failMidStream": {
      return "-> fail mid-stream";
    }
    case "replay": {
      return `-> replay ${rule.replay}`;
    }
    case "reset": {
      return "-> reset";
    }
    case "corrupt": {
      return "-> corrupt";
    }
    default: {
      const unreachable: never = rule;
      return `-> unsupported ${String(unreachable)}`;
    }
  }
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
