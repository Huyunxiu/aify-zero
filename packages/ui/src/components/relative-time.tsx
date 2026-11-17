import { cn } from "@workspace/ui/lib/utils";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { DEFAULT_LANG, isLang } from "../i18n";
import { relativeTimeBucket } from "../lib/relative-time";

/** 一分钟一跳，和阶梯第一档对齐。 */
const TICK_MS = 60_000;

let clock = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function tick() {
  clock = Date.now();

  for (const listener of listeners) {
    listener();
  }
}

/** 后台标签页的定时器会被浏览器降频，回到前台时立刻对一次表。 */
function handleVisibilityChange() {
  if (document.visibilityState === "visible") {
    tick();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  if (timer === undefined) {
    clock = Date.now();
    timer = setInterval(tick, TICK_MS);
    document.addEventListener("visibilitychange", handleVisibilityChange);
  }

  return () => {
    listeners.delete(listener);

    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    }
  };
}

function getClock(): number {
  return clock;
}

/**
 * 一分钟一跳的共享时钟。
 *
 * 只有一个 interval，所有行读同一个快照；订阅的叶子各自重渲染，会话列表本身
 * 不跟着重渲染。`useElapsedMs` 那种「谁用谁起定时器」在这里会让整列会话每秒
 * 重渲染一次。
 */
function useMinuteClock(): number {
  return React.useSyncExternalStore(subscribe, getClock);
}

/**
 * 「多久以前」。
 *
 * 只读 `at` 和共享时钟，不读任何列表状态：两处会话列表都用它，换一处不影响
 * 另一处。
 */
export function RelativeTime({
  at,
  className,
}: {
  at: Date;
  className?: string;
}) {
  const { t, i18n } = useTranslation();
  const now = useMinuteClock();
  const lang = isLang(i18n.language) ? i18n.language : DEFAULT_LANG;
  const bucket = relativeTimeBucket(at.getTime(), now, lang);

  let text: string;

  switch (bucket.kind) {
    case "justNow": {
      text = t("relativeTime.justNow");
      break;
    }
    case "minutes": {
      text = t("relativeTime.minutesAgo", { count: bucket.count });
      break;
    }
    case "hours": {
      text = t("relativeTime.hoursAgo", { count: bucket.count });
      break;
    }
    case "yesterday": {
      text = t("relativeTime.yesterday");
      break;
    }
    case "days": {
      text = t("relativeTime.daysAgo", { count: bucket.count });
      break;
    }
    case "date": {
      text = bucket.text;
      break;
    }
  }

  return (
    <span
      className={cn(
        "shrink-0 text-xs text-sidebar-foreground/60 tabular-nums",
        className
      )}
    >
      {text}
    </span>
  );
}
