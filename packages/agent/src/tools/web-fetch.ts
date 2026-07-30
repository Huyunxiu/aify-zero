import { tool } from "ai";
import type { InferUITool, Tool } from "ai";
import { z } from "zod";

import type { AgentContext } from "../context";
import { getErrorMessage } from "../utils/error";
import { convertHtmlToMarkdown, extractTextFromHtml } from "../utils/html";
import { truncateContent } from "../utils/truncate";
import type { ToolOutput } from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024;
// 30 second
const DEFAULT_TIMEOUT_MS = 30_000;
// 2 minutes
const MAX_TIMEOUT_MS = 120_000;

/** Maximum total output bytes before truncation (50 KB). */
const MAX_OUTPUT_BYTES = 50 * 1024;

/** Maximum output lines. */
const MAX_OUTPUT_LINES = 2000;

type Format = "html" | "markdown" | "text";

/**
 * Browser-like User-Agent used for the initial request so servers return
 * full-fidelity content rather than bot-degraded pages.
 */
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

// ---------------------------------------------------------------------------
// Input / Output schemas
// ---------------------------------------------------------------------------

const WEB_FETCH_TOOL_INPUT_SCHEMA = z.object({
  format: z
    .enum(["markdown", "text", "html"])
    .optional()
    .default("markdown")
    .describe(
      'The format to return the content in (text, markdown, or html). HTML responses are automatically converted to the requested format. Defaults to "markdown".'
    ),
  timeout: z.coerce
    .number()
    .positive()
    .optional()
    .describe("Optional timeout in seconds. Defaults to 30, max 120."),
  url: z
    .url()
    .describe(
      "The fully-formed URL to fetch content from. Must start with http:// or https://."
    ),
});

type WebFetchToolInput = z.infer<typeof WEB_FETCH_TOOL_INPUT_SCHEMA>;

type WebFetchToolOutputMetadata = {
  title: string;
  url: string;
  contentType: string;
  truncated: boolean;
};

type WebFetchToolOutput = ToolOutput<string, WebFetchToolOutputMetadata>;

// ---------------------------------------------------------------------------
// Description
// ---------------------------------------------------------------------------

const DESCRIPTION = [
  "Fetch a webpage and return its content in the requested format. Use this to retrieve and analyze content from URLs.",
  "",
  "Usage notes:",
  "- The URL must be a fully-formed valid URL starting with http:// or https://",
  "- HTML responses are automatically converted to markdown or plain text based on the requested format",
  '- Format options: "markdown" (default), "text", or "html"',
  `- Default timeout is ${DEFAULT_TIMEOUT_MS / 1000} seconds (max ${MAX_TIMEOUT_MS / 1000} seconds)`,
  `- Maximum response size is ${MAX_RESPONSE_SIZE / 1024 / 1024} MB`,
  "- This tool is read-only and does not modify any files",
].join("\n");

function buildHeaders(format: Format): Record<string, string> {
  let accept: string;

  if (format === "markdown") {
    accept =
      "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1";
  } else if (format === "text") {
    accept =
      "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1";
  } else {
    accept =
      "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1";
  }

  return {
    Accept: accept,
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent": BROWSER_USER_AGENT,
  };
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

type CreateWebFetchToolProps = {
  agentContext: AgentContext;
};

const createWebFetchTool = ({
  agentContext: _agentContext,
}: CreateWebFetchToolProps): Tool<
  WebFetchToolInput,
  WebFetchToolOutput,
  AgentContext
> =>
  tool<WebFetchToolInput, WebFetchToolOutput, AgentContext>({
    description: DESCRIPTION,
    inputSchema: WEB_FETCH_TOOL_INPUT_SCHEMA,
    execute: async (input, { abortSignal }) => {
      const { url, format, timeout } = input;

      // Validate URL scheme.
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        return {
          output: `URL must start with http:// or https://. Received: "${url}".`,
          code: "error",
          metadata: {
            title: url,
            url,
            contentType: "",
            truncated: false,
          },
        };
      }

      const timeoutMs = Math.min(
        timeout !== undefined ? timeout * 1000 : DEFAULT_TIMEOUT_MS,
        MAX_TIMEOUT_MS
      );

      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal =
        abortSignal === undefined
          ? timeoutSignal
          : AbortSignal.any([abortSignal, timeoutSignal]);

      const headers = buildHeaders(format);

      let response: Response;
      try {
        response = await fetch(url, { headers, signal });
      } catch (error) {
        // Re-throw abort/timeout errors so the agent framework handles them.
        if (error instanceof DOMException && error.name === "AbortError") {
          return {
            output: abortSignal?.aborted
              ? "Web fetch was aborted by user."
              : `Request timed out after ${timeoutMs / 1000} seconds.`,
            code: "error",
            metadata: {
              title: url,
              url,
              contentType: "",
              truncated: false,
            },
          };
        }
        return {
          output: `Web fetch failed: ${getErrorMessage(error)}`,
          code: "error",
          metadata: {
            title: url,
            url,
            contentType: "",
            truncated: false,
          },
        };
      }

      if (!response.ok) {
        return {
          output: `Request failed with status code: ${response.status}`,
          code: "error",
          metadata: {
            title: url,
            url,
            contentType: response.headers.get("content-type") ?? "",
            truncated: false,
          },
        };
      }

      // Check declared content-length before reading.
      const declaredLength = response.headers.get("content-length");
      if (
        declaredLength !== null &&
        Number.parseInt(declaredLength, 10) > MAX_RESPONSE_SIZE
      ) {
        return {
          output: `Response too large (Content-Length: ${declaredLength} bytes exceeds ${MAX_RESPONSE_SIZE / 1024 / 1024} MB limit).`,
          code: "error",
          metadata: {
            title: url,
            url,
            contentType: response.headers.get("content-type") ?? "",
            truncated: false,
          },
        };
      }

      // Read the response body.
      let buffer: ArrayBuffer;
      try {
        buffer = await response.arrayBuffer();
      } catch (error) {
        return {
          output: `Failed to read response body: ${getErrorMessage(error)}`,
          code: "error",
          metadata: {
            title: url,
            url,
            contentType: response.headers.get("content-type") ?? "",
            truncated: false,
          },
        };
      }

      if (buffer.byteLength > MAX_RESPONSE_SIZE) {
        return {
          output: `Response too large (${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB exceeds ${MAX_RESPONSE_SIZE / 1024 / 1024} MB limit).`,
          code: "error",
          metadata: {
            title: url,
            url,
            contentType: response.headers.get("content-type") ?? "",
            truncated: false,
          },
        };
      }

      const contentType = response.headers.get("content-type") ?? "";
      const isHtml =
        contentType.includes("text/html") ||
        contentType.includes("application/xhtml+xml");
      const body = new TextDecoder().decode(buffer);

      let rawContent: string;

      if (format === "markdown" && isHtml) {
        rawContent = convertHtmlToMarkdown(body);
      } else if (format === "text" && isHtml) {
        rawContent = extractTextFromHtml(body);
      } else {
        rawContent = body;
      }

      // Truncate output to budget.
      const truncated = truncateContent({
        content: rawContent,
        maxBytes: MAX_OUTPUT_BYTES,
        maxLines: MAX_OUTPUT_LINES,
        direction: "head",
      });

      const output =
        truncated.truncatedByBytes || truncated.truncatedByLines
          ? truncated.lines.join("\n") +
            `\n\n[Output truncated: ${truncated.outputLines} lines / ${truncated.outputBytes} bytes returned.]`
          : truncated.lines.join("\n");

      return {
        output,
        code: "ok",
        metadata: {
          title: url,
          url,
          contentType,
          truncated: truncated.truncatedByBytes || truncated.truncatedByLines,
        },
      };
    },
    toModelOutput({ output }) {
      if (output.code === "error") {
        return { type: "error-text", value: output.output };
      }
      return { type: "text", value: output.output };
    },
  });

type WebFetchToolType = InferUITool<ReturnType<typeof createWebFetchTool>>;

export { createWebFetchTool, type WebFetchToolType };
