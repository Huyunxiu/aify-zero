import type { ServerResponse } from "node:http";

import { withoutHopByHop } from "../headers.js";
import type { ReplayBook } from "../record.js";
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

/** 一条非流式 chat completion，形状按真供应商。 */
const completion = (model: string, content: string): string =>
  JSON.stringify({
    id: "chatcmpl-fake",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    // 真供应商都带这个字段；客户端不强制要它，但形状要对得上。
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });

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

/**
 * 把一条规则写到 chat completions 的线上。
 *
 * 场景说意图（失败、慢一点、断掉、说这段话），这个函数说这种协议怎么表达它。
 * 加一种协议就写一个同形状的写手，场景不用改。
 */
export async function writeChatCompletions(options: {
  response: ServerResponse;
  rule: Rule | undefined;
  model: string;
  replay: ReplayBook;
  /** 这次请求是不是流式的；工具调用只在流上表达得出来。 */
  stream: boolean;
}): Promise<void> {
  const { response, rule, model, replay, stream } = options;

  if (!rule) {
    response.writeHead(500, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error: { message: "fake provider: the scenario ran out of rules" },
      })
    );
    return;
  }

  if (rule.fail !== undefined) {
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

  // 写手要报「不支持」，不能悄悄降级：把 SSE 块塞进非流式响应，客户端只会当成
  // 一条坏响应。这条判断必须落在写响应头之前。见 ADR-0011。
  if (rule.toolCall && !stream) {
    response.writeHead(500, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error: {
          message: "fake provider: a toolCall rule needs a streaming request",
        },
      })
    );
    return;
  }

  if (rule.reset) {
    // 直接断连接：客户端看到的是网络错误，不是一条 HTTP 响应。
    response.socket?.destroy();
    return;
  }

  // `corrupt` 在两种传输上都成立：流式断在 `data:` 帧中间，非流式断在半截 JSON 上。
  // 解析器两种都会报错，而这条路径的错误不是供应商错误。
  if (rule.corrupt) {
    if (stream) {
      startStream(response);
      response.end(
        'data: {"id":"chatcmpl-fake","object":"chat.completion.chunk"\n\n'
      );
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"id":"chatcmpl-fake","object":"chat.completion"');
    return;
  }

  if (rule.replay !== undefined) {
    const entry = await replay.take(rule.replay);
    if (!entry) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message: `fake provider: recording ${rule.replay} is used up`,
          },
        })
      );
      return;
    }

    const headers = withoutHopByHop(entry.response.headers);
    response.writeHead(entry.response.status, headers);
    response.end(entry.response.body);
    return;
  }

  // 非流式请求（会话标题就是）要一条 JSON，不是 `data:` 帧：把 SSE 塞进去，客户端
  // 只会当成一条坏响应。`failMidStream` 要靠流的分帧才成形，写手照 ADR-0011 报
  // 「不支持」，不悄悄换成一个空回答。
  if (!stream) {
    if (rule.failMidStream) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message:
              "fake provider: a failMidStream rule needs a streaming request",
          },
        })
      );
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    await wait(rule.slow?.firstChunkMs);
    response.end(completion(model, rule.answer ?? ""));
    return;
  }

  startStream(response);
  await wait(rule.slow?.firstChunkMs);

  if (rule.failMidStream) {
    response.write(chunk(model, { role: "assistant" }));
    for (const piece of rule.failMidStream.text ?? "") {
      await wait(rule.slow?.chunkMs);
      response.write(chunk(model, { content: piece }));
    }
    // 这个形状会被 `@ai-sdk/openai-compatible` 认成供应商错误，再由 `streamText`
    // 归一成 `StreamProviderError`，按 statusCode 与消息文本分类。
    const error = rule.failMidStream.error ?? { message: "overloaded" };
    response.end(`data: ${JSON.stringify({ error })}\n\n`);
    return;
  }

  response.write(chunk(model, { role: "assistant" }));

  if (rule.toolCall) {
    // 名字和 id 走第一块，之后每块只带 `arguments` 的一段前缀；客户端按 index
    // 把它们拼回一个 JSON 字符串。分块长度固定，测试才能既看到拼接、又不被块数淹掉。
    const argsJson = JSON.stringify(rule.toolCall.args ?? {});
    response.write(
      chunk(model, {
        tool_calls: [
          {
            index: 0,
            id: rule.toolCall.id ?? "call_fake_1",
            type: "function",
            function: { name: rule.toolCall.name, arguments: "" },
          },
        ],
      })
    );
    for (const piece of argsJson.match(/[\S\s]{1,8}/gu) ?? []) {
      await wait(rule.slow?.chunkMs);
      response.write(
        chunk(model, {
          tool_calls: [{ index: 0, function: { arguments: piece } }],
        })
      );
    }
    response.write(chunk(model, {}, "tool_calls"));
    response.end("data: [DONE]\n\n");
    return;
  }

  for (const piece of rule.answer ?? "") {
    await wait(rule.slow?.chunkMs);
    response.write(chunk(model, { content: piece }));
  }
  response.write(chunk(model, {}, "stop"));
  response.end("data: [DONE]\n\n");
}
