import type { Config, Env } from "./env.ts";

export type Role = "root" | "viewer";

export interface Viewer {
  userId: string;
  name: string;
  role: Role;
  sessionId: string;
  csrf: string;
}

export interface Device {
  id: string;
  name: string;
  /** The user who approved this device; `artifact open` signs in as them. */
  userId: string | null;
}

export interface AppEnv {
  Bindings: Env;
  Variables: {
    config: Config;
    viewer: Viewer;
    device: Device;
    /** CSP nonce for inline scripts on our own pages. */
    nonce: string;
  };
}
