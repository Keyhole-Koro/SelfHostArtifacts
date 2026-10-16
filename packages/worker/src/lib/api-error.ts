import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** JSON error for the agent API. The CLI shows `message` to the agent as is, so make it actionable. */
export function apiError(c: Context, status: ContentfulStatusCode, code: string, message: string, extra: object = {}) {
  return c.json({ error: { code, message }, ...extra }, status);
}
