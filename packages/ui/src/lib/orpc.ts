import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { QueryCache, QueryClient } from "@tanstack/react-query";
import type { AppRouterClient } from "@workspace/server/routers/index";
import { LANGUAGE_HEADER } from "@workspace/shared/constants";
import { getErrorMessage } from "@workspace/shared/errors";
import { toastManager } from "@workspace/ui/components/toast";

import { i18n } from "../i18n";

const SERVER_UNAVAILABLE_STATUS = 503;
const MAX_SERVER_RETRIES = 10;
const SERVER_RETRY_DELAY_MS = 500;

/**
 * 503 通常只出现在 server 崩溃后自动重启的窗口期：请求根本没到上游，重试
 * 是安全的。启动期则由主进程的 `waitForOrigin` 挡住，不会走这里。
 */
const isServerUnavailable = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "status" in error &&
  (error as { status?: unknown }).status === SERVER_UNAVAILABLE_STATUS;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) =>
        isServerUnavailable(error) && failureCount < MAX_SERVER_RETRIES,
      retryDelay: SERVER_RETRY_DELAY_MS,
      refetchOnWindowFocus: false,
    },
  },
  queryCache: new QueryCache({
    // Nothing renders a failed query unless a component happens to read its
    // `isError` state, so surface every one of them globally. The toast uses
    // the i18n instance rather than a hook because this runs outside React.
    onError: (error, query) => {
      toastManager.add({
        description: getErrorMessage(error),
        title: i18n.t("requestFailed"),
        type: "error",
        onClose() {
          query.invalidate();
        },
      });
    },
  }),
});

export const link = new RPCLink({
  // The UI's current language rides along on every call; the server's
  // languageDetector reads this header (see LANGUAGE_HEADER).
  headers: () => ({ [LANGUAGE_HEADER]: i18n.language }),
  // 文档相对地址：浏览器打到同源 /api/rpc，桌面打到 aify-app://app/api/rpc，
  // 由各自的文档所有者转发，渲染端不需要知道自己在哪。
  url: new URL("api/rpc", document.baseURI).href,
});

export const client: AppRouterClient = createORPCClient(link);

export const orpc = createTanstackQueryUtils(client);
