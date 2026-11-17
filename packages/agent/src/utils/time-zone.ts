/**
 * 时区：宿主的、配置里的，以及两者之间那条取舍。
 *
 * 这里只回答「用哪个时区」。真正按它算日历的是定时器的周期规则
 * （`timers/recurrence.ts`），别把这两件事混在一处。
 */

/** 宿主的时区；取不到时按 UTC。 */
export const hostTimeZone = (): string =>
  Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** 这个字符串是不是一个可用的 IANA 时区。 */
export const isTimeZone = (value: string): boolean => {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

/**
 * 生效的时区：配置里写了就用写的，没写就跟随宿主。
 *
 * 三处装配共用这一条规则——会话装配、日历规则的缺省、只读状态里的那个数。
 * 各自写一遍 `?? hostTimeZone()` 就有三种写法可以漂。
 * @param preferred - 配置里那一个；空值表示没配。
 * @returns 一个可用的 IANA 时区。
 */
export const timeZoneOrHost = (preferred: string | null | undefined): string =>
  preferred ?? hostTimeZone();
