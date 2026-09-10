import { NextResponse } from "next/server";
import type { ApiErrorBody } from "./types";

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function apiError(error: unknown, correlationId?: string): NextResponse<ApiErrorBody> {
  const known = error instanceof AppError;
  const status = known ? error.status : 500;
  const body: ApiErrorBody = {
    error: {
      code: known ? error.code : "internal_error",
      message: known ? error.message : "An unexpected error occurred.",
      ...(known && error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
      ...(correlationId ? { correlationId } : {}),
    },
  };
  return NextResponse.json(body, { status });
}
