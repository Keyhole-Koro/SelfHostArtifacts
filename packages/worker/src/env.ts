export interface Env {
  DB: D1Database;
  BLOBS: R2Bucket;
  PAIR_LIMITER?: RateLimit;

  APP_HOST: string;
  ROOT_EMAIL: string;
  KEEP_VERSIONS?: string;
  TRASH_DAYS?: string;
  DEV_LOGIN_EMAIL?: string;

  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  SESSION_SECRET: string;
  CONTENT_TOKEN_SECRET: string;
}

export interface Config {
  host: string;
  origin: string;
  rootEmail: string;
  keepVersions: number;
  trashDays: number;
  devLoginEmail: string | undefined;
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
  const rootEmail = env.ROOT_EMAIL?.trim().toLowerCase();
  if (!rootEmail?.includes("@")) throw new Error("ROOT_EMAIL is not set");
  const local = isLocalHost(host);
  const devLoginEmail = env.DEV_LOGIN_EMAIL?.trim().toLowerCase() || undefined;
  if (devLoginEmail && !local) {
    throw new Error("DEV_LOGIN_EMAIL is only allowed when APP_HOST is localhost; remove it from this deployment");
  }
  if (!env.SESSION_SECRET || !env.CONTENT_TOKEN_SECRET) {
    throw new Error("SESSION_SECRET and CONTENT_TOKEN_SECRET must be set (wrangler secret put)");
  }
  return {
    host,
    origin: `${local ? "http" : "https"}://${host}`,
    rootEmail,
    keepVersions: nonNegativeInt(env.KEEP_VERSIONS, 0, "KEEP_VERSIONS"),
    trashDays: nonNegativeInt(env.TRASH_DAYS, 30, "TRASH_DAYS"),
    devLoginEmail,
  };
}
