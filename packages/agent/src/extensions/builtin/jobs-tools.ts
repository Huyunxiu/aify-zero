import { createJobTools } from "../../tools/jobs";
import type { ExtensionAPI, ExtensionOptions } from "../types";
import { Extension } from "../types";

const DEFAULT_OPTIONS: ExtensionOptions = { id: "jobs-tools" };

/** 后台任务的使用说明；只在有注册表时出现。 */
const JOBS_GUIDANCE = `Track every background job id you start. A completion notice arrives when a job finishes — do not poll or sleep on one; keep working on independent steps and do not duplicate a running job's work. Before a final answer, collect every still-relevant job with job-output (set wait: true only when you are blocked on it), and job-kill jobs that no longer matter.`;

/**
 * 后台任务控制扩展。
 *
 * 没有任务注册表就没有可控制的任务，所以这三个工具一起缺席，而不是注册成
 * 一个永远失败的工具。有注册表时再补一段提示，告诉模型任务结束后会收到通知。
 */
export class JobsToolsExtension extends Extension {
  constructor(options: ExtensionOptions = DEFAULT_OPTIONS) {
    super(options);
  }

  init(api: ExtensionAPI): void {
    if (api.environment.jobs === undefined) {
      return;
    }

    const tools = createJobTools({ agentContext: api.environment });
    for (const [name, tool] of Object.entries(tools)) {
      api.tool(name, tool);
    }

    api.instructionsSection({
      id: `${this.id}:guidance`,
      // 排在资源类片段之后：它讲的是这一轮的工具行为。
      priority: 50,
      render: (prompt) =>
        prompt ? `${prompt}\n\n${JOBS_GUIDANCE}` : JOBS_GUIDANCE,
    });
  }
}
