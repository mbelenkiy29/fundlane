import { logApiFailure } from "./operations/telemetry";
import { NextResponse } from "next/server";
import { describeUnexpectedError } from "./error-diagnostics";
import type { ApiErrorBody } from "./types";

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly fieldErrors?: Record<string, string[]>,
    public readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function apiError(error: unknown, correlationId?: string): NextResponse<ApiErrorBody> {
  const known = error instanceof AppError;
  const extra = known && error.extra ? error.extra : undefined;
  const status = known ? error.status : 500;
  if (status >= 500) logApiFailure(correlationId, known ? undefined : describeUnexpectedError(error));
  const body: ApiErrorBody = {
    error: {
      code: known ? error.code : "internal_error",
      message: known ? error.message : "An unexpected error occurred.",
      ...(known && error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
      ...(correlationId ? { correlationId } : {}),
      ...extra,
    },
    ...(known && error.code === "merchant_exists" ? extra : {}),
  };
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
