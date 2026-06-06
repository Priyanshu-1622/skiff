import type { ApiResult, ApiErrorCode } from "@skiff/shared";

export function ok<T>(data: T): ApiResult<T> {
  return { ok: true, data };
}

export function err(code: ApiErrorCode, message: string): ApiResult<never> {
  return { ok: false, error: { code, message } };
}
