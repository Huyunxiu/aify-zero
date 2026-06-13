type ToolOutputCode = "ok" | "error";

type ToolOutput<TOutput = string, TMetadata = Record<string, unknown>> = {
  title?: string;
  metadata?: TMetadata;
  output: TOutput;
  code: ToolOutputCode;
};

export { type ToolOutput, type ToolOutputCode };
