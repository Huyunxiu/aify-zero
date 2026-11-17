import { createTimerTools } from "../../tools/timers";
import type { ExtensionAPI, ExtensionOptions } from "../types";
import { Extension } from "../types";

const DEFAULT_OPTIONS: ExtensionOptions = { id: "timers-tools" };

/** 定时器的使用说明；只在绑定了会话定时器时出现。 */
const TIMERS_GUIDANCE = `A timer wakes this session later. Set one with timer-set when the next step depends on something that has not happened yet — a deploy, a build, a reply. Set a schedule with schedule-set when the user wants to be woken on a cadence, such as every day at nine. Do not sleep or poll waiting for either: end the turn and it brings you back.`;

/**
 * 定时器控制扩展。
 *
 * 没有绑定会话定时器就没有可排的定时器，所以这几个工具一起缺席，而不是注册成
 * 一个永远失败的工具。子会话属于这一类：它没有收件箱，排了也不会触发。
 */
export class TimersToolsExtension extends Extension {
  constructor(options: ExtensionOptions = DEFAULT_OPTIONS) {
    super(options);
  }

  init(api: ExtensionAPI): void {
    if (api.environment.timers === undefined) {
      return;
    }

    const tools = createTimerTools({ agentContext: api.environment });
    for (const [name, tool] of Object.entries(tools)) {
      api.tool(name, tool);
    }

    api.instructionsSection({
      id: `${this.id}:guidance`,
      // 和任务提示同档：它讲的是这一轮的工具行为。
      priority: 50,
      render: (prompt) =>
        prompt ? `${prompt}\n\n${TIMERS_GUIDANCE}` : TIMERS_GUIDANCE,
    });
  }
}
