import { QueryClientProvider } from "@tanstack/react-query";
import {
  createBrowserHistory,
  createHashHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { LangProvider } from "@workspace/ui/components/lang-provider";
import { ServerStatusBanner } from "@workspace/ui/components/server-status-banner";
import { ThemeProvider } from "@workspace/ui/components/theme-provider";
import {
  AnchoredToastProvider,
  ToastProvider,
} from "@workspace/ui/components/toast";
import { TooltipProvider } from "@workspace/ui/components/tooltip";
import { LayoutProvider } from "@workspace/ui/elements/layout-provider";
import { SignInGate } from "@workspace/ui/elements/sign-in-gate";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";

import "@workspace/ui/styles/globals.css";
import { isDesktopShell } from "./lib/desktop";
import { queryClient } from "./lib/orpc";
import { routeTree } from "./routeTree.gen";
import { useChannelStore } from "./stores/channel";

/**
 * The address bar follows the route, so history is the document's own.
 *
 * The desktop document comes from `aify-app://`, where the protocol handler
 * serves files by path. A hash keeps the business path out of that lookup.
 */
const history = isDesktopShell ? createHashHistory() : createBrowserHistory();

export const router = createRouter({
  defaultPendingMinMs: 0,
  history,
  routeTree,
  scrollRestoration: true,
});

export default function App() {
  // 整个应用只有一条通道：启动时建连，之后任何地方都用 useChannelStore 取。
  useEffect(() => {
    const { connect, disconnect } = useChannelStore.getState();

    connect();

    return disconnect;
  }, []);

  // 用户点了发件箱的通知：主进程把会话 id 送进来，这里负责切过去。浏览器里
  // 没有这个桥，所以整段跳过。
  useEffect(() => {
    const desktop = window.aifyDesktop;

    if (desktop?.onOpenSession === undefined) {
      return;
    }

    const id = desktop.onOpenSession((sessionId) => {
      void router.navigate({
        params: { sessionId },
        to: "/sessions/$sessionId",
      });
    });

    return () => {
      desktop.offOpenSession?.(id);
    };
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <ServerStatusBanner />
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}

const rootElement = document.querySelector("#root");

if (!rootElement) {
  throw new Error("Root element not found");
}

createRoot(rootElement).render(
  <StrictMode>
    <ThemeProvider>
      <LangProvider>
        <LayoutProvider>
          <TooltipProvider>
            <ToastProvider>
              <AnchoredToastProvider>
                {/* 登录态就是整个应用的开关：没登录时不建通道、不发查询。 */}
                <SignInGate>
                  <App />
                </SignInGate>
              </AnchoredToastProvider>
            </ToastProvider>
          </TooltipProvider>
        </LayoutProvider>
      </LangProvider>
    </ThemeProvider>
  </StrictMode>
);
