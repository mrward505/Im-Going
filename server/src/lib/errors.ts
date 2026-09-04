import { z } from "zod";
/** Shared HTTP error helpers with structured bodies: { error: { code, message } }. */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const badRequest = (message: string) => new ApiError(400, "bad_request", message);
export const unauthorized = (message = "authentication required") => new ApiError(401, "unauthorized", message);
export const forbidden = (message = "not allowed") => new ApiError(403, "forbidden", message);
export const notFound = (message = "not found") => new ApiError(404, "not_found", message);
export const conflict = (message: string) => new ApiError(409, "conflict", message);

/** Map a thrown value to { statusCode, code, message } for the error handler. */
export function toApiError(err: unknown): { statusCode: number; code: string; message: string } {
  if (err instanceof ApiError) return { statusCode: err.statusCode, code: err.code, message: err.message };
  if (err instanceof z.ZodError) {
    const first = err.issues[0];
    const message = first ? `${first.path.join(".") || "body"}: ${first.message}` : "invalid request";
    return { statusCode: 400, code: "invalid_request", message };
  }
  const pgCode = (err as { code?: string })?.code;
  if (pgCode === "23505") return { statusCode: 409, code: "conflict", message: "that value is already taken" };
  if (pgCode === "23503") return { statusCode: 400, code: "bad_request", message: "referenced row does not exist" };
  if (pgCode === "23514") return { statusCode: 400, code: "bad_request", message: "value violates a constraint" };
  return { statusCode: 500, code: "internal", message: "internal error" };
}