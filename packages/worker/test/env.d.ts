import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import type { Env } from "../src/env.ts";

declare global {
  namespace Cloudflare {
    interface Env extends Omit<import("../src/env.ts").Env, never> {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
export type { Env };
