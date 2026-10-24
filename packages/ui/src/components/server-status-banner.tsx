import { useTranslation } from "react-i18next";

import { useServerStatus } from "@workspace/ui/hooks/use-server-status";

/**
 * 桌面壳的 API server 状态条。
 *
 * 启动/重启期间显示在底部；ready 或浏览器环境不渲染。请求本身由主进程的
 * `waitForOrigin` 和 query 重试兜底，这个组件只负责让用户知道发生了什么。
 */
export const ServerStatusBanner = () => {
  const { t } = useTranslation();
  const status = useServerStatus();

  if (
    status === undefined ||
    status.state === "ready" ||
    status.state === "stopped"
  ) {
    return null;
  }

  const unavailable = status.state === "unavailable";
  const labelKey =
    status.state === "restarting"
      ? "serverStatus.restarting"
      : unavailable
        ? "serverStatus.unavailable"
        : "serverStatus.starting";

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center"
      role="status"
    >
      <div className="flex items-center gap-2 rounded-full border bg-background/95 px-4 py-2 text-sm shadow-lg backdrop-blur">
        <span
          className={
            unavailable
              ? "size-2 rounded-full bg-destructive"
              : "size-2 animate-pulse rounded-full bg-amber-500"
          }
        />
        {t(labelKey)}
      </div>
    </div>
  );
};
