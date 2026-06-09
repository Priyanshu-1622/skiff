import { create } from "zustand";
import { apiGet, apiPost } from "./api";
import type { VaultStatus, VaultMode } from "@skiff/shared";

interface VaultState {
  status: VaultStatus | null;
  loading: boolean;
  fetchStatus: () => Promise<void>;
  setup: (password: string, opts?: { mode?: VaultMode; username?: string }) => Promise<{ ok: boolean; error?: string }>;
  unlock: (password: string) => Promise<{ ok: boolean; error?: string }>;
  teamLogin: (username: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  lock: () => Promise<void>;
}

export const useVault = create<VaultState>((set, get) => ({
  status: null,
  loading: true,

  fetchStatus: async () => {
    try {
      const data = await apiGet<VaultStatus>("/api/vault/status");
      set({ status: data, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  setup: async (password: string, opts) => {
    try {
      await apiPost("/api/vault/setup", {
        password,
        mode: opts?.mode ?? "personal",
        username: opts?.username,
      });
      await get().fetchStatus();
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e.message || "Setup failed" };
    }
  },

  unlock: async (password: string) => {
    try {
      await apiPost("/api/vault/unlock", { password });
      await get().fetchStatus();
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e.message || "Incorrect password" };
    }
  },

  teamLogin: async (username: string, password: string) => {
    try {
      await apiPost("/api/team/login", { username, password });
      await get().fetchStatus();
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e.message || "Invalid credentials" };
    }
  },

  lock: async () => {
    try {
      await apiPost("/api/vault/lock");
    } catch { /* ignore */ }
    await get().fetchStatus();
  },
}));
