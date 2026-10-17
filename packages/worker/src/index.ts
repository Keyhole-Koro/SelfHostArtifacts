import { Hono } from "hono";
import type { AppEnv } from "./app-env.ts";
import { cleanup } from "./cron.ts";
import { loadConfig, type Env } from "./env.ts";
import { api } from "./routes/api.ts";
import { auth, invites } from "./routes/auth.tsx";
import { content } from "./routes/content.ts";
import { pages } from "./routes/pages.tsx";
import { PASSKEY_CLIENT_JS } from "./ui/passkey-client.ts";

export const app = new Hono<AppEnv>();

app.use(async (c, next) => {
  c.set("config", loadConfig(c.env));
  const host = new URL(c.req.url).host.toLowerCase();
  if (host !== c.get("config").host) return c.text(`This deployment answers on ${c.get("config").host}.`, 421);
  await next();
});

app.onError((err, c) => {
  console.error("unhandled", err);
  if (c.req.path.startsWith("/api/")) {
    return c.json({ error: { code: "internal", message: "The server failed. Try again; if it keeps failing, check the Worker logs." } }, 500);
  }
  return c.text("Something went wrong.", 500);
});

app.get("/health", (c) => c.text("ok"));
app.route("/api/v1", api);
app.route("/c", content);
app.get("/assets/passkey.js", (c) =>
  c.body(PASSKEY_CLIENT_JS, 200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=300" }),
);
app.route("/auth", auth);
app.route("/invite", invites);
app.route("/", pages);

export default {
  fetch: app.fetch,
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      cleanup(env, loadConfig(env)).then((report) => console.log("cleanup", JSON.stringify(report))),
    );
  },
} satisfies ExportedHandler<Env>;
