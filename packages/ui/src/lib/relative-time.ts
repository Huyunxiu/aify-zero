import type { Lang } from "../i18n";

/**
 * 相对时间的显示档位。
 *
 * 只算「属于哪一档」，不产出文案：文案在词条里，时区判断在这里。这样档位能
 * 单测，翻译能交给 i18next。
 */
export type RelativeTimeBucket =
  | { kind: "justNow" }
  | { kind: "minutes"; count: number }
  | { kind: "hours"; count: number }
  | { kind: "yesterday" }
  | { kind: "days"; count: number }
  | { kind: "date"; text: string };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 阶梯的第一档：比这更近的时刻一律是「刚刚」。 */
const JUST_NOW_MS = MINUTE;

/** 超过这个天数改用日期，不再说「N 天前」。 */
const DATE_AFTER_DAYS = 7;

export function relativeTimeBucket(
  at: number,
  now: number,
  lang: Lang
): RelativeTimeBucket {
  const elapsed = now - at;

  // 设备的钟可以比服务端慢，未来的时刻按「刚刚」处理，不显示负数。
  if (elapsed < JUST_NOW_MS) {
    return { kind: "justNow" };
  }

  if (elapsed < HOUR) {
    return { kind: "minutes", count: Math.floor(elapsed / MINUTE) };
  }

  if (elapsed < DAY) {
    return { kind: "hours", count: Math.floor(elapsed / HOUR) };
  }

  const days = calendarDayGap(at, now);

  // 超过 24 小时之后按日历日判断：「昨天」指昨天那一格，不是「24 到 48 小时
  // 之间」。夏令时的一天可以是 23 或 25 小时，所以这里按日界线相减再四舍五入，
  // 不拿毫秒数除 24 小时。
  if (days === 1) {
    return { kind: "yesterday" };
  }

  // 25 小时的那一天里，相隔 24 小时以上的两个时刻可能仍落在同一个日历日，
  // 日差算出来是 0。这时说「1 天前」，不能说「昨天」——它不是昨天。
  if (days < 1) {
    return { kind: "days", count: 1 };
  }

  if (days < DATE_AFTER_DAYS) {
    return { kind: "days", count: days };
  }

  return { kind: "date", text: formatDate(at, now, lang) };
}

/**
 * 七天以前的时刻改用日期。
 *
 * 中文写 `11-09`，不用 `Intl` 的 `11月9日`：这一列会挤掉标题的宽度，日期越
 * 短越好。英文用 `Intl` 自己的写法 `Nov 9`。写成 `Record<Lang, ...>` 是为了
 * 新增语言时这里必须补一条，而不是悄悄落进英文分支。
 */
const DATE_FORMATTERS: Record<Lang, (at: Date, now: Date) => string> = {
  "en-US": (at, now) =>
    new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
    }).format(at),
  "zh-CN": (at, now) => {
    const month = String(at.getMonth() + 1).padStart(2, "0");
    const day = String(at.getDate()).padStart(2, "0");
    const date = `${month}-${day}`;

    return at.getFullYear() === now.getFullYear()
      ? date
      : `${at.getFullYear()}-${date}`;
  },
};

function formatDate(at: number, now: number, lang: Lang): string {
  return DATE_FORMATTERS[lang](new Date(at), new Date(now));
}

/** 两个时刻之间差几个日历日，按本机时区的日界线算。 */
function calendarDayGap(at: number, now: number): number {
  return Math.round((startOfDay(now) - startOfDay(at)) / DAY);
}

function startOfDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}
