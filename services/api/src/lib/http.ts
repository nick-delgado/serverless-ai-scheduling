/**
 * Buffered (non-streaming) JSON responses for REST API proxy handlers, e.g. `GET /api/session` (#18).
 * Error bodies follow the `ApiError` contract; the chat stream's equivalents are in `errors.ts`.
 */
import { ApiError, type ChatErrorCode } from "@sched/contracts";

/** The REST API Lambda proxy result (payload v1). */
export interface ProxyResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export const JSON_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "application/json; charset=utf-8",
  // Patient data: never cached by CloudFront or the browser (ADR-007 notes CloudFront and GET).
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

export function jsonResponse(statusCode: number, body: unknown): ProxyResult {
  return { statusCode, headers: { ...JSON_HEADERS }, body: JSON.stringify(body) };
}

/** An `ApiError` body (validated against the contract). */
export function errorResponse(statusCode: number, code: ChatErrorCode, message: string): ProxyResult {
  return jsonResponse(statusCode, ApiError.parse({ error: { code, message } }));
}
