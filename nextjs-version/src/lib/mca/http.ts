import { ZodError, type ZodType } from "zod";
import { AppError } from "./errors";
import { newId } from "./db";

export async function readJson<T>(request: Request, schema: ZodType<T>): Promise<T> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new AppError(400, "invalid_json", "Request body must be valid JSON.");
  }
  try {
    return schema.parse(value);
  } catch (error) {
    if (!(error instanceof ZodError)) throw error;
    const fieldErrors: Record<string, string[]> = {};
    for (const issue of error.issues) {
      const key = issue.path.join(".") || "request";
      (fieldErrors[key] ??= []).push(issue.message);
    }
    throw new AppError(400, "validation_failed", "Review the highlighted fields.", fieldErrors);
  }
}

export function requestCorrelationId(request: Request): string {
  const supplied = request.headers.get("x-request-id");
  return supplied && /^[a-zA-Z0-9._-]{1,100}$/.test(supplied) ? supplied : newId();
}

export function appOrigin(request: Request): string {
  return (process.env.MCA_APP_ORIGIN || new URL(request.url).origin).replace(/\/$/, "");
}
