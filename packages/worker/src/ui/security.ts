import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../app-env.ts";
import { randomToken } from "../lib/encoding.ts";

/**
 * Headers for our own pages (everything except /c/*): no framing by others, scripts only from
 * this origin (/assets/*) or inline with this response's nonce.
 */
export const pageSecurity: MiddlewareHandler<AppEnv> = async (c, next) => {
  const nonce = randomToken();
  c.set("nonce", nonce);
  await next();
  c.header(
    "content-security-policy",
    [
      "default-src 'self'",
      `script-src 'self' 'nonce-${nonce}'`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "frame-src 'self'",
      "form-action 'self' https://accounts.google.com",
      "frame-ancestors 'none'",
      "base-uri 'none'",
    ].join("; "),
  );
  c.header("x-frame-options", "DENY");
  c.header("referrer-policy", "same-origin");
  c.header("cache-control", "private, no-store");
};
