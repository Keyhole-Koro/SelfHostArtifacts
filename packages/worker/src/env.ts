export interface Env {
  DB: D1Database;
  BLOBS: R2Bucket;
  PAIR_LIMITER?: RateLimit;

  APP_HOST: string;
  KEEP_VERSIONS?: string;
  TRASH_DAYS?: string;
  /** "true" skips sign-in and signs in as the owner. Refused unless APP_HOST is localhost. */
  DEV_LOGIN?: string;

  SESSION_SECRET: string;
  CONTENT_TOKEN_SECRET: string;
}

export interface Config {
  host: string;
  origin: string;
  /** Host name without the port: the WebAuthn relying party id. */
  rpId: string;
  keepVersions: number;
  trashDays: number;
  devLogin: boolean;
}

export function isLocalHost(host: string): boolean {
  const name = host.replace(/:\d+$/, "");
  return name === "localhost" || name === "127.0.0.1" || name === "[::1]";
}

function nonNegativeInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got "${value}"`);
  return n;
}

export function loadConfig(env: Env): Config {
  const host = env.APP_HOST?.trim().toLowerCase();
  if (!host) throw new Error("APP_HOST is not set");
  const local = isLocalHost(host);
  const devLogin = env.DEV_LOGIN?.trim().toLowerCase() === "true";
  if (devLogin && !local) {
    throw new Error("DEV_LOGIN is only allowed when APP_HOST is localhost; remove it from this deployment");
  }
  if (!env.SESSION_SECRET || !env.CONTENT_TOKEN_SECRET) {
    throw new Error("SESSION_SECRET and CONTENT_TOKEN_SECRET must be set (wrangler secret put)");
  }
  return {
    host,
    origin: `${local ? "http" : "https"}://${host}`,
    rpId: host.replace(/:\d+$/, ""),
    keepVersions: nonNegativeInt(env.KEEP_VERSIONS, 0, "KEEP_VERSIONS"),
    trashDays: nonNegativeInt(env.TRASH_DAYS, 30, "TRASH_DAYS"),
    devLogin,
  };
}
