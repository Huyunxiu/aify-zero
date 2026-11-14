import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
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
import { queryClient } from "./lib/orpc";
import { routeTree } from "./routeTree.gen";
import { useChannelStore } from "./stores/channel";

export const router = createRouter({
  defaultPendingMinMs: 0,
  history: createMemoryHistory({
    initialEntries: ["/sessions"],
  }),
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
