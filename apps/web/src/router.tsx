import { createRouter, createRoute, createRootRoute } from "@tanstack/react-router";
import { RootLayout } from "@/routes/__root";
import { UnlockRoute } from "@/routes/unlock";
import { DashboardRoute } from "@/routes/dashboard";
import { TerminalRoute } from "@/routes/terminal";
import { SettingsRoute } from "@/routes/settings";
import { TeamLoginRoute } from "@/routes/team-login";
import { TeamAdminRoute } from "@/routes/team-admin";
import { SetupRoute } from "@/routes/setup";

const rootRoute = createRootRoute({ component: RootLayout });

const unlockRoute = createRoute({ getParentRoute: () => rootRoute, path: "/unlock", component: UnlockRoute });
const dashboardRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: DashboardRoute });
const terminalRoute = createRoute({ getParentRoute: () => rootRoute, path: "/terminal/$hostId", component: TerminalRoute });
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsRoute });
const teamLoginRoute = createRoute({ getParentRoute: () => rootRoute, path: "/login", component: TeamLoginRoute });
const teamAdminRoute = createRoute({ getParentRoute: () => rootRoute, path: "/admin", component: TeamAdminRoute });
const setupRoute = createRoute({ getParentRoute: () => rootRoute, path: "/setup", component: SetupRoute });

const routeTree = rootRoute.addChildren([unlockRoute, dashboardRoute, terminalRoute, settingsRoute, teamLoginRoute, teamAdminRoute, setupRoute]);
export const router = createRouter({ routeTree });
declare module "@tanstack/react-router" { interface Register { router: typeof router; } }
