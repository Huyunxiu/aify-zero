type ToolOutputCode = "ok" | "error";

type ToolOutput<TOutput = string, TMetadata = Record<string, unknown>> = {
  metadata?: TMetadata;
  output: TOutput;
  code: ToolOutputCode;
  message?: string | null;
};

export { type ToolOutput, type ToolOutputCode };
