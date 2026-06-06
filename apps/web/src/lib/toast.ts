import { create } from "zustand";

export type ToastKind = "success" | "error" | "info" | "warning";

export interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
  description?: string;
  duration: number; // ms; 0 = stays until dismissed
}

interface ToastStore {
  toasts: Toast[];
  push: (t: Omit<Toast, "id">) => string;
  dismiss: (id: string) => void;
  clear: () => void;
}

export const useToastStore = create<ToastStore>((set, get) => ({
  toasts: [],
  push: (t) => {
    const id = `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const toast: Toast = { id, ...t };
    set((s) => ({ toasts: [...s.toasts, toast] }));
    if (toast.duration > 0) {
      setTimeout(() => get().dismiss(id), toast.duration);
    }
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  clear: () => set({ toasts: [] }),
}));

// Convenience API
export const toast = {
  success: (message: string, opts?: { description?: string; duration?: number }) =>
    useToastStore.getState().push({
      kind: "success",
      message,
      description: opts?.description,
      duration: opts?.duration ?? 3500,
    }),
  error: (message: string, opts?: { description?: string; duration?: number }) =>
    useToastStore.getState().push({
      kind: "error",
      message,
      description: opts?.description,
      duration: opts?.duration ?? 6000,
    }),
  info: (message: string, opts?: { description?: string; duration?: number }) =>
    useToastStore.getState().push({
      kind: "info",
      message,
      description: opts?.description,
      duration: opts?.duration ?? 3500,
    }),
  warning: (message: string, opts?: { description?: string; duration?: number }) =>
    useToastStore.getState().push({
      kind: "warning",
      message,
      description: opts?.description,
      duration: opts?.duration ?? 4500,
    }),
  dismiss: (id: string) => useToastStore.getState().dismiss(id),
};
