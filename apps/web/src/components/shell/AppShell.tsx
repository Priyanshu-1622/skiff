import { type ReactNode } from "react";
import { Topbar, type TopbarProps } from "./Topbar";
import { Sidebar, type SidebarProps } from "./Sidebar";

export interface AppShellProps {
  children: ReactNode;
  topbar?: Partial<TopbarProps>;
  sidebar?: Partial<SidebarProps>;
}

export function AppShell({ children, topbar = {}, sidebar = {} }: AppShellProps) {
  return (
    <div className="app">
      <Topbar
        searchValue={topbar.searchValue ?? ""}
        onSearchChange={topbar.onSearchChange ?? (() => {})}
        username={topbar.username ?? "admin"}
        hideSearch={topbar.hideSearch}
      />
      <Sidebar {...(sidebar as SidebarProps)} />
      <main className="main">{children}</main>
    </div>
  );
}

export function BareShell({ children }: { children: ReactNode }) {
  return (
    <div style={{ width: "100%", height: "100vh", background: "var(--bg-0)" }}>
      {children}
    </div>
  );
}
