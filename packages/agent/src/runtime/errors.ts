/** 运行器对外报告的稳定错误码。 */
export type AgentRunnerErrorCode =
  | "SESSION_NOT_FOUND"
  | "SESSION_BUSY"
  | "MESSAGE_NOT_FOUND"
  | "NOTHING_TO_FORK";

/** 运行器的业务错误；传输层按 `code` 翻译，不靠文案。 */
export class AgentRunnerError extends Error {
  readonly code: AgentRunnerErrorCode;
  readonly data?: Record<string, string>;

  constructor(code: AgentRunnerErrorCode, data?: Record<string, string>) {
    super(code);
    this.name = "AgentRunnerError";
    this.code = code;
    this.data = data;
  }
}
