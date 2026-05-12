import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@/renderer/components/theme-provider.tsx";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { queryClient } from "./lib/react-query-client";
import { routeTree } from "./routeTree.gen";
import "@workspace/ui/globals.css";

export const router = createRouter({
  defaultPendingMinMs: 0,
  routeTree,
  history: createMemoryHistory({
    initialEntries: ["/"],
  }),
});

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </StrictMode>,
);
