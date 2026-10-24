import type { ApiServerStatus } from "@workspace/shared/api-status";
import { useEffect, useState } from "react";

/**
 * 订阅主进程推送的 API server 状态。
 *
 * 浏览器里没有 `aifyDesktop`，返回 undefined，调用方据此不渲染状态条。
 */
export const useServerStatus = (): ApiServerStatus | undefined => {
  const [status, setStatus] = useState<ApiServerStatus | undefined>(() =>
    typeof window === "undefined"
      ? undefined
      : window.aifyDesktop?.getServerStatus()
  );

  useEffect(() => {
    const bridge = window.aifyDesktop;

    if (bridge === undefined) {
      return;
    }

    // 订阅之前可能已经错过一次推送，先补读当前值。
    setStatus(bridge.getServerStatus());

    const listenerId = bridge.onServerStatus((next) => {
      setStatus(next);
    });

    return () => {
      bridge.offServerStatus(listenerId);
    };
  }, []);

  return status;
};
