import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { router } from "@/router";
import { useTheme } from "@/lib/theme";

// CSS — order matters: tokens → globals → shell → screen-level styles
import "@/styles/tokens.css";
import "@/styles/globals.css";
import "@/styles/shell.css";
import "@/styles/unlock.css";
import "@/styles/firstrun.css";
import "@/styles/hostlist.css";
import "@/styles/addhost.css";
import "@xterm/xterm/css/xterm.css";
import "@/styles/terminal.css";
import "@/styles/settings.css";
import "@/styles/import.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

useTheme.getState().setTheme(useTheme.getState().theme);

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Missing #root element in index.html");

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
