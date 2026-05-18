import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { LangProvider } from "@/renderer/components/lang-provider.tsx";
import { ThemeProvider } from "@/renderer/components/theme-provider.tsx";
import { queryClient } from "@/utils/orpc";

import "@workspace/ui/globals.css";
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
        <App />
      </LangProvider>
    </ThemeProvider>
  </StrictMode>
);
