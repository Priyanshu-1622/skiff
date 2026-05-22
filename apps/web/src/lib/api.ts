/**
 * Typed fetch wrapper. Every endpoint returns an ApiResult<T> envelope.
 * Globally handles 401 VAULT_LOCKED by redirecting to /unlock.
 */

import type { ApiResult, ApiErrorCode } from "@skiff/shared";

export class ApiError extends Error {
  constructor(
    public code: ApiErrorCode | string,
    message: string,
    public httpStatus: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function handleResponse<T>(res: Response, path: string): Promise<T> {
  let body: ApiResult<T>;
  try {
    body = (await res.json()) as ApiResult<T>;
  } catch {
    throw new ApiError("INTERNAL", `Non-JSON response from ${path} (status ${res.status})`, res.status);
  }
  if (!body.ok) {
    // Global auth guard: vault locked/expired → redirect to unlock
    if (body.error.code === "VAULT_LOCKED" && !path.includes("/vault/")) {
      window.location.href = "/unlock";
    }
    throw new ApiError(body.error.code, body.error.message, res.status);
  }
  return body.data;
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, { method: "GET", credentials: "include" });
  return handleResponse<T>(res, path);
}

export async function apiPost<T = unknown>(path: string, payload?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return handleResponse<T>(res, path);
}

export async function apiPut<T = unknown>(path: string, payload?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "PUT", credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return handleResponse<T>(res, path);
}

export async function apiDelete<T = unknown>(path: string): Promise<T> {
  const res = await fetch(path, { method: "DELETE", credentials: "include" });
  return handleResponse<T>(res, path);
}

export interface HealthResponse {
  status: "ok";
  version: string;
  schemaVersion: number;
  uptimeSeconds: number;
  db: string;
}
