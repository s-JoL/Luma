import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ApiError } from "@shared/types.ts";

/** Every failure leaves through here, so the envelope has exactly one shape. */
export function fail(
  context: Context,
  status: ContentfulStatusCode,
  code: string,
  message: string,
  details?: unknown,
) {
  const body: ApiError = { error: { code, message, details } };
  return context.json(body, status);
}

/** Status for the codes the generation layer already classifies for itself. */
const GENERATION_STATUS: Record<string, ContentfulStatusCode> = {
  invalid_request: 400,
  not_found: 404,
  cancelled: 409,
  timeout: 504,
  upstream_error: 502,
};

/**
 * Turns a thrown error into the standard envelope without leaking stack traces.
 *
 * A `GenerationError` states its own code, and that is used. Everything else
 * falls back to reading the message, which is a guess and is treated as one: an
 * upstream body that happens to contain the words "not found" becomes a 404 for
 * a request that was really a bad gateway. The way to shrink that guess is to
 * throw errors that carry a code, not to add another pattern here.
 */
export function failFromError(context: Context, error: unknown, fallbackCode = "internal_error") {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown })?.code;
  if (typeof code === "string" && GENERATION_STATUS[code]) {
    return fail(context, GENERATION_STATUS[code], code, message);
  }
  if (/not configured|no API key/i.test(message)) return fail(context, 422, "not_configured", message);
  if (/not found/i.test(message)) return fail(context, 404, "not_found", message);
  if (/already has an active run/i.test(message)) return fail(context, 409, "run_active", message);
  if (/Unknown or disabled model/i.test(message)) return fail(context, 400, "unknown_model", message);
  return fail(context, 500, fallbackCode, message);
}
