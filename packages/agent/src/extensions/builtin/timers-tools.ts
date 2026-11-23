import { createTimerTools } from "../../tools/timers";
import type { ExtensionAPI, ExtensionOptions } from "../types";
import { Extension } from "../types";

const DEFAULT_OPTIONS: ExtensionOptions = { id: "timers-tools" };

/** The heading every variant of this section carries. */
const HEADING = "## Timers";

/** 定时器的使用说明；只在绑定了会话定时器时出现。 */
const TIMERS_GUIDANCE = `${HEADING}

A timer wakes this session later. Set one with timer-set when the next step depends on something that has not happened yet — a deploy, a build, a reply. Set a schedule with schedule-set when the user wants to be woken on a cadence, such as every day at nine. Do not sleep or poll waiting for either: end the turn and it brings you back.`;

/** A subagent inherits this section, but a timer it sets is not its own. */
const SUBAGENT_OWNERSHIP = `${HEADING}

A timer you set from here wakes the parent session, not this subagent.`;

/**
 * The timers extension.
 *
 * With no timer store bound to the session there is nothing to schedule, so the
 * tools are absent rather than registered and always failing. A subagent does not
 * register extensions: it inherits these tools from the parent's tool set, so the
 * timer it sets lands in the parent session, and {@link SUBAGENT_OWNERSHIP} says so.
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
      render: () => TIMERS_GUIDANCE,
      // 子 agent 继承父的工具集，排出来的定时器落在父会话里。
      renderForSubagent: () => SUBAGENT_OWNERSHIP,
    });
  }
}
