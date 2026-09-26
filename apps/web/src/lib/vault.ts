import { create } from "zustand";
import { apiGet, apiPost } from "./api";
import type { VaultStatus, VaultMode } from "@skiff/shared";

interface VaultState {
  status: VaultStatus | null;
  loading: boolean;
  fetchStatus: () => Promise<void>;
  setup: (password: string, opts?: { mode?: VaultMode; username?: string; setupToken?: string }) => Promise<{ ok: boolean; error?: string }>;
  unlock: (password: string) => Promise<{ ok: boolean; error?: string }>;
  teamLogin: (username: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  lock: () => Promise<void>;
}

/**
 * Vault-wide actions (settings, backup, deleting recordings) belong to the
 * owner: the one person in personal mode, admins in team mode. Mirrors the
 * API's requireVaultOwner guard.
 */
export function isVaultOwner(status: VaultStatus | null): boolean {
  if (!status?.unlocked) return false;
  return status.mode !== "team" || !!status.user?.isAdmin;
}

export const useVault = create<VaultState>((set, get) => ({
  status: null,
  loading: true,

  fetchStatus: async () => {
    set({ loading: true });
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
      }, opts?.setupToken ? { "x-skiff-setup-token": opts.setupToken } : undefined);
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
    } catch { /* ignore — we lock the UI regardless */ }
    // Immediately reflect the locked state locally so the redirect effect
    // fires without waiting on (or depending on) the status refetch.
    const prev = get().status;
    set({ status: prev ? { ...prev, unlocked: false, user: null } : prev, loading: false });
    // Then reconcile with the server.
    await get().fetchStatus();
  },
}));
