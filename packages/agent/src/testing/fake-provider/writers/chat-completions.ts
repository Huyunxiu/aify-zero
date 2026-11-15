import type { ServerResponse } from "node:http";

import type { ReplayBook } from "../record.js";
import { copyHeaders, sendError } from "../respond.js";
import type { Rule } from "../scenario.js";

const wait = async (ms: number | undefined): Promise<void> => {
  if (ms === undefined || ms <= 0) {
    return;
  }

  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

/** 一个 SSE 数据块，形状按 chat completions。 */
const chunk = (
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null = null
): string =>
  `data: ${JSON.stringify({
    id: "chatcmpl-fake",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;

const startStream = (response: ServerResponse): void => {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
};

const failureMessage = (status: number): string => {
  switch (status) {
    case 401: {
      return "Incorrect API key provided";
    }
    case 429: {
      return "Rate limit reached for requests";
    }
    case 503: {
      return "Service Unavailable";
    }
    default: {
      return `fake provider returned ${status}`;
    }
  }
};

/** 把一段文字按字符发给客户端；`slow` 决定节奏。 */
const writeText = async (
  response: ServerResponse,
  model: string,
  text: string,
  chunkMs: number | undefined
): Promise<void> => {
  for (const piece of text) {
    await wait(chunkMs);
    response.write(chunk(model, { content: piece }));
  }
};

/**
 * 把一条规则写到 chat completions 的线上。
 *
 * 场景说意图（失败、慢一点、断掉、说这段话），这个函数说这种协议怎么表达它。
 * 加一个结果就加一个 `case`，TS 会逼着每个写手都处理它；某个协议表达不了的，
 * 就在自己的 `case` 里报「不支持」，而不是悄悄跳过。
 */
export async function writeChatCompletions(options: {
  response: ServerResponse;
  rule: Rule | undefined;
  model: string;
  replay: ReplayBook;
}): Promise<void> {
  const { response, rule, model, replay } = options;

  if (!rule) {
    sendError(response, 500, "fake provider: the scenario ran out of rules");
    return;
  }

  switch (rule.kind) {
    case "fail": {
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (rule.retryAfterMs !== undefined) {
        headers["retry-after-ms"] = String(rule.retryAfterMs);
      }
      if (rule.retryAfter !== undefined) {
        headers["retry-after"] = String(rule.retryAfter);
      }

      response.writeHead(rule.fail, headers);
      response.end(
        JSON.stringify({
          error: {
            message: failureMessage(rule.fail),
            type: "fake_provider_error",
            code: rule.fail,
          },
        })
      );
      return;
    }

    case "reset": {
      // 直接断连接：客户端看到的是网络错误，不是一条 HTTP 响应。
      response.socket?.destroy();
      return;
    }

    case "corrupt": {
      startStream(response);
      // 半截 JSON：解析器会报错，而这条路径的错误不是供应商错误。
      response.end(
        'data: {"id":"chatcmpl-fake","object":"chat.completion.chunk"\n\n'
      );
      return;
    }

    case "replay": {
      const entry = await replay.take(rule.replay);
      if (!entry) {
        sendError(
          response,
          500,
          `fake provider: recording ${rule.replay} is used up`
        );
        return;
      }

      response.writeHead(
        entry.response.status,
        copyHeaders(entry.response.headers)
      );
      response.end(entry.response.body);
      return;
    }

    case "failMidStream": {
      startStream(response);
      await wait(rule.slow?.firstChunkMs);
      response.write(chunk(model, { role: "assistant" }));
      await writeText(
        response,
        model,
        rule.failMidStream.text ?? "",
        rule.slow?.chunkMs
      );
      // 这个形状会被 `@ai-sdk/openai-compatible` 认成供应商错误，再由 `streamText`
      // 归一成 `StreamProviderError`，按 statusCode 与消息文本分类。
      const error = rule.failMidStream.error ?? { message: "overloaded" };
      response.end(`data: ${JSON.stringify({ error })}\n\n`);
      return;
    }

    case "answer": {
      startStream(response);
      await wait(rule.slow?.firstChunkMs);
      response.write(chunk(model, { role: "assistant" }));
      await writeText(response, model, rule.answer, rule.slow?.chunkMs);
      response.write(chunk(model, {}, "stop"));
      response.end("data: [DONE]\n\n");
      return;
    }

    default: {
      // 新加结果时这里会变成类型错误：写手必须表态。
      const unreachable: never = rule;
      throw new Error(
        `fake provider: unsupported result ${String(unreachable)}`
      );
    }
  }
}
