import { tool } from "ai";
import { z } from "zod";

import type { AgentContext } from "../agent-context";
import type { ToolEnvironment } from "../extensions/capabilities";
import { TimerError } from "../timers/error";
import { formatAge } from "../timers/notice";
import type { SessionTimers, Timer } from "../timers/types";
import type { ToolOutput } from "./types";

/** 最短一分钟：再短的等待用 sleep 或者直接做完。 */
const MIN_AFTER_SECONDS = 60;

/** 最长一天：更远的等待是另一期的事，不是一次跟进。 */
const MAX_AFTER_SECONDS = 86_400;

/** 备注的字符上限；它要到点原样回到模型手里，不能无限长。 */
const MAX_NOTE_CHARS = 200;

const TIMER_SET_DESCRIPTION = `
Set a one-shot timer that wakes this session later.

- It fires once, at least \`afterSeconds\` from now and up to one minute late. It is not a precise alarm.
- When it fires, a new message arrives in this session carrying your \`note\`. Do not sleep or poll for it: end the turn, or keep working on something else.
- Write the note for your future self — what you intend to check, and what to do with the result.
`;

const TIMER_LIST_DESCRIPTION = `
List the timers this session is still waiting on.

- Only timers that have not fired yet are listed.
- Use it when you no longer remember a timer id, or before setting another one.
`;

const TIMER_CANCEL_DESCRIPTION = `
Cancel a timer before it fires.

- A timer that already fired is gone and cannot be cancelled.
`;

/** 给界面看的定时器快照；不带 payload。 */
type PublicTimer = {
  id: string;
  note: string;
  dueAt: number;
};

const publicTimer = (timer: Timer): PublicTimer => ({
  id: timer.id,
  note: timer.note,
  dueAt: timer.dueAt,
});

/**
 * 把带分类码的定时器错误翻成模型可读的失败：码放在最前面，日志和测试都能按
 * 它分类，模型也仍然看得到原因。
 * @param error - 工具调用里抛出的错误。
 */
const toToolError = (error: unknown): never => {
  if (error instanceof TimerError) {
    throw new TypeError(`${error.code}: ${error.message}`);
  }
  throw error;
};

/**
 * 取工具需要的依赖。定时器工具只在绑定了会话定时器的装配里注册，缺它说明
 * 宿主装错了，直接报错比让模型看见一个永远失败的工具好。
 */
const requireTimers = (agentContext: ToolEnvironment): SessionTimers => {
  const { timers } = agentContext;
  if (timers === undefined) {
    throw new Error(
      "timer tools require session timers on the agent context (agentContext.timers)"
    );
  }
  return timers;
};

const TIMER_SET_INPUT = z.object({
  note: z
    .string()
    .min(1)
    .max(MAX_NOTE_CHARS)
    .describe(
      "What you intend to check when the timer fires, and what to do with the result. It comes back verbatim."
    ),
  afterSeconds: z
    .number()
    .int()
    .min(MIN_AFTER_SECONDS)
    .max(MAX_AFTER_SECONDS)
    .describe(
      `Delay in seconds, from ${MIN_AFTER_SECONDS} to ${MAX_AFTER_SECONDS} (one day). It fires up to 60 seconds late.`
    ),
});

const TIMER_LIST_INPUT = z.object({});

const TIMER_CANCEL_INPUT = z.object({
  timerId: z.string().min(1).describe("Timer id returned by timer-set."),
});

type TimerSetInput = z.infer<typeof TIMER_SET_INPUT>;
type TimerListInput = z.infer<typeof TIMER_LIST_INPUT>;
type TimerCancelInput = z.infer<typeof TIMER_CANCEL_INPUT>;

type TimerSetMetadata = { timer: PublicTimer };
type TimerListMetadata = { count: number };
type TimerCancelMetadata = { removed: boolean };

type TimerToolDeps = {
  agentContext: ToolEnvironment;
};

const createTimerSetTool = ({ agentContext }: TimerToolDeps) => {
  const timers = requireTimers(agentContext);

  return tool<
    TimerSetInput,
    ToolOutput<string, TimerSetMetadata>,
    AgentContext
  >({
    description: TIMER_SET_DESCRIPTION,
    inputSchema: TIMER_SET_INPUT,
    execute: async ({ note, afterSeconds }, { toolCallId }) => {
      try {
        const dueAt = Date.now() + afterSeconds * 1000;
        // toolCallId 是幂等键：重试同一步不会排第二个定时器。
        const timer = await timers.set({ toolCallId, note, dueAt });
        return {
          output: `timer ${timer.id} will fire in ${formatAge(
            timer.dueAt - Date.now()
          )}, up to one minute late.`,
          code: "ok" as const,
          metadata: { timer: publicTimer(timer) },
        };
      } catch (error: unknown) {
        return toToolError(error);
      }
    },
    toModelOutput({ output }) {
      return { type: "text", value: output.output };
    },
  });
};

const createTimerListTool = ({ agentContext }: TimerToolDeps) => {
  const timers = requireTimers(agentContext);

  return tool<
    TimerListInput,
    ToolOutput<string, TimerListMetadata>,
    AgentContext
  >({
    description: TIMER_LIST_DESCRIPTION,
    inputSchema: TIMER_LIST_INPUT,
    execute: async () => {
      const pending = await timers.list();
      const now = Date.now();
      return {
        output:
          pending.length === 0
            ? "(no pending timers)"
            : pending
                .map(
                  (timer) =>
                    `${timer.id} — in ${formatAge(timer.dueAt - now)} — ${timer.note}`
                )
                .join("\n"),
        code: "ok" as const,
        metadata: { count: pending.length },
      };
    },
    toModelOutput({ output }) {
      return { type: "text", value: output.output };
    },
  });
};

const createTimerCancelTool = ({ agentContext }: TimerToolDeps) => {
  const timers = requireTimers(agentContext);

  return tool<
    TimerCancelInput,
    ToolOutput<string, TimerCancelMetadata>,
    AgentContext
  >({
    description: TIMER_CANCEL_DESCRIPTION,
    inputSchema: TIMER_CANCEL_INPUT,
    execute: async ({ timerId }) => {
      const removed = await timers.cancel(timerId);
      return {
        output: removed
          ? `cancelled timer ${timerId}`
          : `timer ${timerId} was not found; it may have already fired`,
        code: "ok" as const,
        metadata: { removed },
      };
    },
    toModelOutput({ output }) {
      return { type: "text", value: output.output };
    },
  });
};

/**
 * 三个定时器工具。
 *
 * 它们只认会话上绑好的那份视图，拿不到会话 id 也拿不到起跑配置：排进来的
 * 定时器一定属于当前会话，用的一定是当前模型。
 * @param props - 持有工具环境的上下文。
 */
export const createTimerTools = (props: TimerToolDeps) => ({
  "timer-set": createTimerSetTool(props),
  "timer-list": createTimerListTool(props),
  "timer-cancel": createTimerCancelTool(props),
});

export type TimerTools = ReturnType<typeof createTimerTools>;
