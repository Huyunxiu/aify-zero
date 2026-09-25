import type { AgentStreamEvent } from "@workspace/agent-client";
import { JsonToSseTransformStream, UI_MESSAGE_STREAM_HEADERS } from "ai";
import type { HeadersInit } from "undici-types";

export function prepareHeaders(
  headers: HeadersInit | undefined,
  defaultHeaders: Record<string, string>
): Headers {
  const responseHeaders = new Headers(headers ?? {});

  for (const [key, value] of Object.entries(defaultHeaders)) {
    if (!responseHeaders.has(key)) {
      responseHeaders.set(key, value);
    }
  }

  return responseHeaders;
}

/**
 * Options for creating a UI message stream response.
 * Extends the standard `ResponseInit` with additional streaming options.
 */
export type AgentMessageStreamResponseInit = ResponseInit & {
  /**
   * Optional callback to consume a copy of the SSE stream independently.
   * This is useful for logging, debugging, or processing the stream in parallel.
   * The callback receives a tee'd copy of the stream and does not block the response.
   */
  consumeSseStream?: (options: {
    stream: ReadableStream<string>;
  }) => PromiseLike<void> | void;
};

/**
 * Creates a Response object from a UI message stream.
 * The stream is transformed to Server-Sent Events (SSE) format.
 *
 * @param options.status - The HTTP status code for the response.
 * @param options.statusText - The HTTP status text for the response.
 * @param options.headers - Additional HTTP headers to include in the response.
 * @param options.stream - The UI message chunk stream to send.
 * @param options.consumeSseStream - Optional callback to consume a copy of the SSE stream independently.
 *
 * @returns A `Response` object with the UI message stream as the body.
 */
export function createUIMessageStreamResponse({
  status,
  statusText,
  headers,
  stream,
  consumeSseStream,
}: AgentMessageStreamResponseInit & {
  stream: ReadableStream<AgentStreamEvent<any>>;
}): Response {
  let sseStream = stream.pipeThrough(new JsonToSseTransformStream());

  // when the consumeSseStream is provided, we need to tee the stream
  // and send the second part to the consumeSseStream function
  // so that it can be consumed by the client independently
  if (consumeSseStream) {
    const [stream1, stream2] = sseStream.tee();
    sseStream = stream1;
    // no await (do not block the response)
    consumeSseStream({ stream: stream2 });
  }

  return new Response(sseStream.pipeThrough(new TextEncoderStream()), {
    status,
    statusText,
    headers: prepareHeaders(headers, UI_MESSAGE_STREAM_HEADERS),
  });
}
