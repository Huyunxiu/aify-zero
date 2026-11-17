import { tool } from "ai";
import { z } from "zod";

import type { AgentContext } from "../agent-context";
import type { ToolEnvironment } from "../extensions/capabilities";
import { TimerError } from "../timers/error";
import { formatAge } from "../timers/notice";
import { recurrenceDraftSchema, renderRecurrence } from "../timers/recurrence";
import type { RecurrenceRule } from "../timers/recurrence";
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
List the timers this session is still waiting on: follow-ups and schedules.

- A follow-up is listed until it fires. A schedule is listed until it is cancelled.
- Use it when you no longer remember a timer id, or before setting another one.
`;

const TIMER_CANCEL_DESCRIPTION = `
Cancel a follow-up or a schedule.

- A follow-up that already fired is gone and cannot be cancelled.
- A schedule stays until you cancel it. Cancelling stops every future firing.
`;

const SCHEDULE_SET_DESCRIPTION = `
Wake this session on a cadence, until you cancel it.

- Use it when the user wants to be woken again and again: every day at nine, every weekday, every two hours. For a single wake-up later, use timer-set.
- \`daily\` and \`weekly\` take a local time and an IANA time zone. Omit the time zone to use the user's own.
- \`weekly\` takes ISO weekdays; \`[1,2,3,4,5]\` is every weekday.
- \`interval\` repeats on an absolute cadence. It does not follow the wall clock, so a daylight-saving change moves it.
- It fires on time and up to one minute late. After downtime, missed firings collapse into one.
- Write the note for your future self — what this schedule is for.
`;

/** 给界面看的定时器快照；不带 payload。 */
type PublicTimer = {
  id: string;
  note: string;
  dueAt: number;
  /** 周期规则；跟进是 null。 */
  recurrence: RecurrenceRule | null;
};

const publicTimer = (timer: Timer): PublicTimer => ({
  id: timer.id,
  note: timer.note,
  dueAt: timer.dueAt,
  recurrence: timer.recurrence,
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
  timerId: z
    .string()
    .min(1)
    .describe("Timer id returned by timer-set or schedule-set."),
});

const SCHEDULE_SET_INPUT = z.object({
  note: z
    .string()
    .min(1)
    .max(MAX_NOTE_CHARS)
    .describe(
      "What this schedule is for, and what to do when it fires. It comes back verbatim on every firing."
    ),
  recurrence: recurrenceDraftSchema.describe(
    "When to fire. Use daily or weekly for a local time of day; use interval for an absolute cadence."
  ),
});

type TimerSetInput = z.infer<typeof TIMER_SET_INPUT>;
type TimerListInput = z.infer<typeof TIMER_LIST_INPUT>;
type TimerCancelInput = z.infer<typeof TIMER_CANCEL_INPUT>;
type ScheduleSetInput = z.infer<typeof SCHEDULE_SET_INPUT>;

type TimerSetMetadata = { timer: PublicTimer };
type TimerListMetadata = { count: number };
type TimerCancelMetadata = { removed: boolean };
type ScheduleSetMetadata = { schedule: PublicTimer };

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

const createScheduleSetTool = ({ agentContext }: TimerToolDeps) => {
  const timers = requireTimers(agentContext);

  return tool<
    ScheduleSetInput,
    ToolOutput<string, ScheduleSetMetadata>,
    AgentContext
  >({
    description: SCHEDULE_SET_DESCRIPTION,
    inputSchema: SCHEDULE_SET_INPUT,
    execute: async ({ note, recurrence }, { toolCallId }) => {
      try {
        // toolCallId 是幂等键：重试同一步不会排第二个日程。
        const schedule = await timers.setSchedule({
          toolCallId,
          note,
          recurrence,
        });

        if (schedule.recurrence === null) {
          throw new Error("schedule insert produced a follow-up");
        }

        return {
          output: `schedule ${schedule.id} set (${renderRecurrence(
            schedule.recurrence
          )}). First firing in ${formatAge(
            schedule.dueAt - Date.now()
          )}, up to one minute late.`,
          code: "ok" as const,
          metadata: { schedule: publicTimer(schedule) },
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

/** 列表里每条带什么：日程要说得出自己的规则，否则几行 id 分不清谁是谁。 */
const describeTimer = (timer: Timer, now: number): string => {
  const rule =
    timer.recurrence === null ? "" : `${renderRecurrence(timer.recurrence)} — `;

  return `${timer.id} — ${rule}in ${formatAge(timer.dueAt - now)} — ${timer.note}`;
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
            : pending.map((timer) => describeTimer(timer, now)).join("\n"),
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
 * 四个定时器工具。
 *
 * 它们只认会话上绑好的那份视图，拿不到会话 id 也拿不到起跑配置：排进来的
 * 定时器一定属于当前会话，用的一定是当前模型。设定分成两个工具，因为「一次」
 * 和「按周期」的入参语言不同；列表和撤销只有一个，因为库里只有一个 id 空间。
 * @param props - 持有工具环境的上下文。
 */
export const createTimerTools = (props: TimerToolDeps) => ({
  "timer-set": createTimerSetTool(props),
  "timer-list": createTimerListTool(props),
  "timer-cancel": createTimerCancelTool(props),
  "schedule-set": createScheduleSetTool(props),
});

export type TimerTools = ReturnType<typeof createTimerTools>;
