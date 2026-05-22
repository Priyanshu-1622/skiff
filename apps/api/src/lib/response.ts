/**
 * Uniform response envelope used by every API endpoint.
 *
 * The shape is defined in `@skiff/shared` as `ApiResult<T>`. Every
 * handler returns either `ok(data)` or `err(code, message)`. The
 * client knows it can always read `result.ok` first.
 */

import type { ApiResult, ApiErrorCode } from "@skiff/shared";

export function ok<T>(data: T): ApiResult<T> {
  return { ok: true, data };
}

export function err(code: ApiErrorCode, message: string): ApiResult<never> {
  return { ok: false, error: { code, message } };
}
