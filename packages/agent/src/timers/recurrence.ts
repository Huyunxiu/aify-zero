import { Temporal } from "temporal-polyfill";
import { z } from "zod";

import { isTimeZone } from "../utils/time-zone";

/**
 * 周期的规则与它的算术。
 *
 * 一个日程的周期只做一件事：给出「严格晚于某个时刻的第一次发生」。补发只投一次、
 * 间隔相位不漂，都由这一个函数给出（ADR 0018）。
 */

/** 当地墙上时间，`09:00`。 */
const CLOCK_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * 固定间隔的下限，秒。
 *
 * 扫描 60 秒一轮，比这更密的日程换不来更多精度，只是每分钟起一次运行。
 */
const MIN_INTERVAL_SECONDS = 300;

/** 星期的编号和 ISO 一致：1 是周一，7 是周日。 */
const weekdaySchema = z.number().int().min(1).max(7);

const clockTimeSchema = z
  .string()
  .regex(CLOCK_TIME_PATTERN, 'expected a local time like "09:00"');

const timeZoneSchema = z
  .string()
  .min(1)
  .refine(isTimeZone, "unknown IANA time zone")
  .describe("IANA time zone, for example Asia/Shanghai");

const dailyRuleSchema = z
  .object({
    type: z.literal("daily"),
    at: clockTimeSchema,
    timeZone: timeZoneSchema,
  })
  .strict();

const weeklyRuleSchema = z
  .object({
    type: z.literal("weekly"),
    at: clockTimeSchema,
    weekdays: z.array(weekdaySchema).min(1),
    timeZone: timeZoneSchema,
  })
  .strict();

const intervalRuleSchema = z
  .object({
    type: z.literal("interval"),
    everySeconds: z.number().int().min(MIN_INTERVAL_SECONDS),
  })
  .strict();

/**
 * 存进库里的周期规则。
 *
 * 日历规则一定带时区：写入时把解析后的值固化下来，之后这一行的含义不再随设置
 * 漂移（ADR 0018）。
 */
const recurrenceRuleSchema = z.discriminatedUnion("type", [
  dailyRuleSchema,
  weeklyRuleSchema,
  intervalRuleSchema,
]);

export type RecurrenceRule = z.infer<typeof recurrenceRuleSchema>;

/**
 * 模型写下的周期规则。
 *
 * 和 {@link recurrenceRuleSchema} 的唯一区别是日历规则的时区可省略：省略时由
 * 装配处补上，模型不必知道用户设置在哪。
 */
export const recurrenceDraftSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("daily").describe("Fire once every day."),
      at: clockTimeSchema.describe(
        'Local time of day, 24-hour "HH:MM", for example "09:00".'
      ),
      timeZone: timeZoneSchema
        .optional()
        .describe("IANA time zone. Omit it to use the user's own."),
    })
    .strict(),
  z
    .object({
      type: z.literal("weekly").describe("Fire on some days of every week."),
      at: clockTimeSchema.describe(
        'Local time of day, 24-hour "HH:MM", for example "09:00".'
      ),
      weekdays: z
        .array(weekdaySchema)
        .min(1)
        .describe(
          "ISO weekdays: 1 is Monday, 7 is Sunday. [1,2,3,4,5] is every weekday."
        ),
      timeZone: timeZoneSchema
        .optional()
        .describe("IANA time zone. Omit it to use the user's own."),
    })
    .strict(),
  z
    .object({
      type: z
        .literal("interval")
        .describe("Fire on an absolute cadence, not on the wall clock."),
      everySeconds: z
        .number()
        .int()
        .min(MIN_INTERVAL_SECONDS)
        .describe(
          `Cadence in seconds, at least ${MIN_INTERVAL_SECONDS}. It does not follow a local time, so a daylight-saving change shifts it.`
        ),
    })
    .strict(),
]);

export type RecurrenceDraft = z.infer<typeof recurrenceDraftSchema>;

const normalizeWeekdays = (days: readonly number[]): number[] =>
  [...new Set(days)].toSorted((left, right) => left - right);

/**
 * 把模型写下的规则补成能存进库的那一份。
 *
 * 时区只在这一个地方补齐：日历规则的 `timeZone` 缺省取 `fallbackTimeZone`。
 * @param draft - 模型给的规则。
 * @param fallbackTimeZone - 没写时区时用的那一个。
 * @returns 时区已经确定的规则。
 */
export const resolveRecurrence = (
  draft: RecurrenceDraft,
  fallbackTimeZone: string
): RecurrenceRule => {
  switch (draft.type) {
    case "daily": {
      return {
        type: "daily",
        at: draft.at,
        timeZone: draft.timeZone ?? fallbackTimeZone,
      };
    }
    case "weekly": {
      return {
        type: "weekly",
        at: draft.at,
        weekdays: normalizeWeekdays(draft.weekdays),
        timeZone: draft.timeZone ?? fallbackTimeZone,
      };
    }
    case "interval": {
      return { type: "interval", everySeconds: draft.everySeconds };
    }
    default: {
      throw new Error(`unknown recurrence rule: ${JSON.stringify(draft)}`);
    }
  }
};

/** 把 `09:00` 拆成小时和分钟；不合法就抛，别让 NaN 流进日历算术。 */
const parseClockTime = (at: string): { hour: number; minute: number } => {
  const [hour, minute] = at.split(":").map(Number);

  if (
    hour === undefined ||
    minute === undefined ||
    Number.isNaN(hour) ||
    Number.isNaN(minute)
  ) {
    throw new Error(`invalid clock time: ${JSON.stringify(at)}`);
  }

  return { hour, minute };
};

/** 某个时刻在那个时区里的当地日期。 */
const localDateOf = (epochMs: number, timeZone: string): Temporal.PlainDate =>
  Temporal.Instant.fromEpochMilliseconds(epochMs)
    .toZonedDateTimeISO(timeZone)
    .toPlainDate();

/**
 * 某个当地日期的 `at` 时刻对应的绝对时刻。
 *
 * 夏令时的两条约定都在这里：落在空档里顺延到空档之后（02:30 → 03:30），落在
 * 重复段里取第一次。`compatible` 正好是这两条。
 */
const wallClockInstant = (
  date: Temporal.PlainDate,
  at: string,
  timeZone: string
): number => {
  const { hour, minute } = parseClockTime(at);

  return Temporal.ZonedDateTime.from({
    timeZone,
    year: date.year,
    month: date.month,
    day: date.day,
    hour,
    minute,
  }).epochMilliseconds;
};

/**
 * 严格晚于 `after` 的第一次发生，毫秒时间戳。
 *
 * `from` 是这一行当前的到期时刻，只有 `interval` 用它：相位钉在原来的格点上，
 * 所以错过几次之后再算，下一次仍然落在原来的节拍上。日历规则由墙钟决定相位，
 * 从 `after` 往后找就够了——这也是「停机期间错过多次只补一次」的来源。
 * @param rule - 周期规则。
 * @param input.from - 当前的到期时刻。
 * @param input.after - 从这里之后找下一次。
 * @returns 下一次发生的毫秒时间戳。
 */
export const nextOccurrence = (
  rule: RecurrenceRule,
  { from, after }: { from: number; after: number }
): number => {
  switch (rule.type) {
    case "interval": {
      const step = rule.everySeconds * 1000;
      const elapsed = Math.max(0, after - from);

      return from + (Math.floor(elapsed / step) + 1) * step;
    }
    case "daily": {
      const start = localDateOf(after, rule.timeZone);

      // 一天最多因为夏令时抖动一次；看三天足够，不会漏。
      for (let offset = 0; offset <= 2; offset += 1) {
        const instant = wallClockInstant(
          start.add({ days: offset }),
          rule.at,
          rule.timeZone
        );

        if (instant > after) {
          return instant;
        }
      }

      throw new Error(`daily rule produced no instant after ${after}`);
    }
    case "weekly": {
      const start = localDateOf(after, rule.timeZone);

      for (let offset = 0; offset <= 7; offset += 1) {
        const date = start.add({ days: offset });

        if (!rule.weekdays.includes(date.dayOfWeek)) {
          continue;
        }

        const instant = wallClockInstant(date, rule.at, rule.timeZone);

        if (instant > after) {
          return instant;
        }
      }

      throw new Error(`weekly rule produced no instant after ${after}`);
    }
    default: {
      throw new Error(`unknown recurrence rule: ${JSON.stringify(rule)}`);
    }
  }
};

const WEEKDAY_NAMES = [
  "",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

const sameDays = (
  days: readonly number[],
  expected: readonly number[]
): boolean =>
  days.length === expected.length &&
  days.every((day, index) => day === expected[index]);

const intervalLabel = (seconds: number): string => {
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;

    return hours === 1 ? "every hour" : `every ${hours} hours`;
  }

  const minutes = seconds / 60;

  return minutes === 1 ? "every minute" : `every ${minutes} minutes`;
};

/**
 * 把规则写成一句话。
 *
 * 通知正文、工具输出和 `timer-list` 共用同一份说法：读者要看得出「多久之后再醒」
 * 的形状，而不是一串自己的字段名。工作日和周末各有一个说法，用户说的是这两个词。
 * @param rule - 周期规则。
 * @returns 例如 `daily 09:00 Asia/Shanghai`、`every weekday 09:00 Asia/Shanghai`。
 */
export const renderRecurrence = (rule: RecurrenceRule): string => {
  switch (rule.type) {
    case "daily": {
      return `daily ${rule.at} ${rule.timeZone}`;
    }
    case "weekly": {
      const days = rule.weekdays;
      const label = sameDays(days, [1, 2, 3, 4, 5])
        ? "every weekday"
        : sameDays(days, [6, 7])
          ? "every weekend"
          : days.length === 1
            ? `every ${WEEKDAY_NAMES[days[0] ?? 1] ?? "unknown day"}`
            : `every ${days.map((day) => WEEKDAY_NAMES[day] ?? "unknown day").join(", ")}`;

      return `${label} ${rule.at} ${rule.timeZone}`;
    }
    case "interval": {
      return intervalLabel(rule.everySeconds);
    }
    default: {
      // 渲染只服务于正文，不该抛：读不懂的规则来自更旧的版本，正文仍然要发出，
      // 把「算不出来」留给推进那一步去判断。
      return "an unknown rule";
    }
  }
};
