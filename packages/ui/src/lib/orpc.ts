import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { QueryCache, QueryClient } from "@tanstack/react-query";
import type { AppRouterClient } from "@workspace/server/routers/index";
import { toastManager } from "@workspace/ui/components/toast";

import { i18n } from "../i18n";
import { getErrorMessage } from "./errors";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 0,
      refetchOnWindowFocus: false,
    },
  },
  queryCache: new QueryCache({
    // Nothing renders a failed query unless a component happens to read its
    // `isError` state, so surface every one of them globally. The toast uses
    // the i18n instance rather than a hook because this runs outside React.
    onError: (error, query) => {
      toastManager.add({
        description: getErrorMessage(error, i18n.t),
        title: i18n.t("errors.retry"),
        type: "error",
        onClose() {
          query.invalidate();
        },
      });
    },
  }),
});

export const link = new RPCLink({
  url: `http://localhost:18086/rpc`,
});

export const client: AppRouterClient = createORPCClient(link);

export const orpc = createTanstackQueryUtils(client);
