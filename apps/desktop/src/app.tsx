import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { LangProvider } from "@workspace/ui/components/lang-provider";
import { ThemeProvider } from "@workspace/ui/components/theme-provider";
import { TooltipProvider } from "@workspace/ui/components/tooltip";
import { LayoutProvider } from "@workspace/ui/elements/layout-provider";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@workspace/ui/styles/globals.css";
import { queryClient } from "@/utils/orpc";

import { routeTree } from "./routeTree.gen";

export const router = createRouter({
  defaultPendingMinMs: 0,
  history: createMemoryHistory({
    initialEntries: ["/"],
  }),
  routeTree,
  scrollRestoration: true,
});

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
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
            <App />
          </TooltipProvider>
        </LayoutProvider>
      </LangProvider>
    </ThemeProvider>
  </StrictMode>
);
