import { Outlet } from "@tanstack/react-router";
import { Toaster } from "@/components/Toaster";

export function RootLayout() {
  return (
    <>
      <Outlet />
      <Toaster />
    </>
  );
}
