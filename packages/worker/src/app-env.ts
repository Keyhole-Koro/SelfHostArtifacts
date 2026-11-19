import type { Config, Env } from "./env.ts";

export type Role = "root" | "viewer";
export type SessionKind = "full" | "device";

export interface Viewer {
  userId: string;
  name: string;
  role: Role;
  sessionId: string;
  /** Device-link sessions can view artifacts but cannot change account or owner settings. */
  sessionKind: SessionKind;
  csrf: string;
  /** Notifications not read yet. */
  unread: number;
}

export interface Device {
  id: string;
  name: string;
  /** The user who approved this device; `artifact open` creates a view-only session as them. */
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
