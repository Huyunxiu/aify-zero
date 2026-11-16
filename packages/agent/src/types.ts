export type { AgentToolSet } from "@workspace/agent-client";

/**
 * 一个工具怎么让模型看见。
 *
 * `direct` 随每一步请求一起声明给模型；`deferred` 不给模型，只进工具目录，
 * 模型搜到之后靠转调去调它。
 */
export type ToolExposure = "direct" | "deferred";
