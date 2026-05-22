import { createRouter, createRoute, createRootRoute } from "@tanstack/react-router";
import { RootLayout } from "@/routes/__root";
import { UnlockRoute } from "@/routes/unlock";
import { DashboardRoute } from "@/routes/dashboard";
import { TerminalRoute } from "@/routes/terminal";
import { SettingsRoute } from "@/routes/settings";

const rootRoute = createRootRoute({ component: RootLayout });

const unlockRoute = createRoute({ getParentRoute: () => rootRoute, path: "/unlock", component: UnlockRoute });
const dashboardRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: DashboardRoute });
const terminalRoute = createRoute({ getParentRoute: () => rootRoute, path: "/terminal/$hostId", component: TerminalRoute });
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsRoute });

const routeTree = rootRoute.addChildren([unlockRoute, dashboardRoute, terminalRoute, settingsRoute]);
export const router = createRouter({ routeTree });
declare module "@tanstack/react-router" { interface Register { router: typeof router; } }
