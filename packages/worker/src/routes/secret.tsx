import { secretClaimSchema, type SecretEnvelope } from "@artifact/shared";
import { Hono, type Context } from "hono";
import { raw } from "hono/html";
import type { AppEnv } from "../app-env.ts";
import { recordAuditEvent } from "../db/audit.ts";
import { claimSecret, finishSecret, markSecretOpened, secretByTokenHash, secretOpen, secretStatus, type SecretRow } from "../db/secrets.ts";
import { fromBase64url, sha256Hex } from "../lib/encoding.ts";
import { Page, formatTime } from "../ui/layout.tsx";
import { pageSecurity } from "../ui/security.ts";

/**
 * The recipient's side of a secret handoff, at /secret/:token. No sign-in: whoever opens the link
 * first makes a key pair in their browser and registers the public key; only that browser can
 * decrypt what the sender puts. The page's script (/assets/secret.js) does all the cryptography.
 */
export const secretPages = new Hono<AppEnv>();
secretPages.use(pageSecurity);
secretPages.use(async (c, next) => {
  await next();
  c.header("x-robots-tag", "noindex, nofollow, noarchive");
});

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

const STRINGS = {
  en: {
    title: "Receive a secret",
    expires: "Link expires",
    loading: "Loading…",
    noscript: "Turn on JavaScript to receive the secret.",
    about: "The secret is encrypted for this browser only. The server keeps only the encrypted copy and deletes it when you are done.",
    preparing: "Preparing a key in this browser…",
    waiting: "This browser is ready. Waiting for the sender to put the secret. Keep this page open, or open this link again later in the same browser.",
    fingerprint: "Key fingerprint",
    fingerprintHint: "If the sender asks, read these digits to them.",
    otherBrowser: "This link was opened in another browser, and only that browser can show the secret. If that was not you, tell the person who sent it.",
    ready: "Here is the secret. Save what you need, then delete it from the server.",
    show: "Show",
    hide: "Hide",
    copy: "Copy",
    copied: "Copied",
    done: "Saved — delete it from the server",
    finished: "Deleted. You can close this page.",
    gone: "This link has expired or was already used. Ask the person who sent it for a new one.",
    storage: "This browser cannot keep the key (private browsing, or site data is blocked). Open the link in a normal window.",
    decryptFailed: "This browser could not decrypt the secret. Ask the sender for a new link.",
    error: "Something went wrong. Reload the page.",
  },
  ja: {
    title: "秘密の受け取り",
    expires: "リンクの期限",
    loading: "読み込んでいます…",
    noscript: "受け取るには JavaScript を有効にしてください。",
    about: "秘密は、このブラウザだけが読めるように暗号化されています。サーバーには暗号化したものだけが置かれ、受け取りが終わると消えます。",
    preparing: "このブラウザで鍵を用意しています…",
    waiting: "準備ができました。送る人が秘密を置くのを待っています。このページを開いたままにするか、あとで同じブラウザでこのリンクを開いてください。",
    fingerprint: "鍵の指紋",
    fingerprintHint: "送る人に聞かれたら、この数字を読み上げてください。",
    otherBrowser: "このリンクは別のブラウザで開かれていて、秘密を表示できるのはそのブラウザだけです。心当たりがなければ、送った人に知らせてください。",
    ready: "秘密が届きました。必要なものを保存してから、サーバーから消してください。",
    show: "表示",
    hide: "隠す",
    copy: "コピー",
    copied: "コピーしました",
    done: "保存した（サーバーから消す）",
    finished: "消しました。このページは閉じてかまいません。",
    gone: "このリンクは期限が切れたか、すでに使われています。送った人に新しいリンクを頼んでください。",
    storage: "このブラウザでは鍵を保存できません（プライベートブラウズか、サイトのデータがブロックされています）。通常のウィンドウで開いてください。",
    decryptFailed: "このブラウザでは復号できませんでした。送った人に新しいリンクを頼んでください。",
    error: "うまくいきませんでした。ページを読み込み直してください。",
  },
} as const;

type Lang = keyof typeof STRINGS;

function langOf(c: Context<AppEnv>): Lang {
  const first = (c.req.header("accept-language") ?? "").split(",")[0]?.trim().toLowerCase() ?? "";
  return first.startsWith("ja") ? "ja" : "en";
}

const STYLES = `
.secret-items { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--border); }
.secret-items li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-2) var(--space-2); padding: var(--space-3) 0; border-bottom: 1px solid var(--border); align-items: center; }
.secret-items .name { grid-column: 1 / -1; font-weight: 600; overflow-wrap: anywhere; }
.secret-items .value { font: var(--text-sm)/1.5 var(--font-mono); background: var(--surface-2); border-radius: var(--radius-sm); padding: var(--space-2) var(--space-3); overflow-wrap: anywhere; user-select: all; min-width: 0; }
.secret-items .actions { display: flex; gap: var(--space-1); }
.secret-error { color: var(--negative); }
.secret-fp { margin-top: var(--space-3); }
`;

/** The request behind a link token, or undefined for a malformed or unknown token. */
async function secretFor(c: Context<AppEnv>): Promise<SecretRow | undefined> {
  const token = c.req.param("token") ?? "";
  if (!TOKEN.test(token)) return undefined;
  return (await secretByTokenHash(c.env.DB, await sha256Hex(token))) ?? undefined;
}

function sameOrigin(c: Context<AppEnv>): boolean {
  return c.req.header("origin") === c.get("config").origin;
}

function anonymousAudit(c: Context<AppEnv>, action: string, id: string) {
  return recordAuditEvent(c, { actorType: "anonymous", action, targetType: "secret", targetId: id });
}

secretPages.get("/:token", async (c) => {
  const lang = langOf(c);
  const t = STRINGS[lang];
  const row = await secretFor(c);
  if (!row || !secretOpen(row)) {
    return c.html(
      <Page title={t.title} narrow lang={lang}>
        <div class="card stack">
          <h1>{t.title}</h1>
          <p>{t.gone}</p>
        </div>
      </Page>,
      404,
    );
  }
  return c.html(
    <Page title={t.title} narrow lang={lang}>
      <style>{raw(STYLES)}</style>
      <div class="card stack" id="secret" data-id={row.id} data-strings={JSON.stringify(t)}>
        <div>
          <h1>{row.label}</h1>
          <p class="muted small">
            {t.expires}: <time datetime={row.expires_at}>{formatTime(row.expires_at)}</time>
          </p>
        </div>
        <div id="secret-view">
          <noscript>{t.noscript}</noscript>
          <p class="muted">{t.loading}</p>
        </div>
      </div>
      <p class="muted small" style="margin-top:var(--space-4)">{t.about}</p>
      <script src="/assets/secret.js" defer></script>
    </Page>,
  );
});

secretPages.get("/:token/state", async (c) => {
  const row = await secretFor(c);
  if (!row || !secretOpen(row)) return c.json({ status: "gone" }, 404);
  return c.json({ status: secretStatus(row), public_key: row.public_key });
});

secretPages.post("/:token/claim", async (c) => {
  if (!sameOrigin(c)) return c.json({ error: "Cross-origin request refused." }, 403);
  const row = await secretFor(c);
  if (!row || !secretOpen(row)) return c.json({ status: "gone" }, 404);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "The body must be JSON." }, 400);
  }
  const parsed = secretClaimSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "public_key must be a P-256 public key." }, 400);
  try {
    // Rejects bytes that are not a point on the curve.
    await crypto.subtle.importKey("raw", fromBase64url(parsed.data.public_key), { name: "ECDH", namedCurve: "P-256" }, true, []);
  } catch {
    return c.json({ error: "public_key must be a P-256 public key." }, 400);
  }
  const claimed = await claimSecret(c.env.DB, row.id, parsed.data.public_key, c.req.header("cf-connecting-ip") ?? null, c.req.header("user-agent") ?? null);
  if (!claimed) return c.json({ status: secretStatus(row) }, 409);
  await anonymousAudit(c, "secret.claim", row.id);
  return c.json({ status: "claimed" });
});

secretPages.get("/:token/sealed", async (c) => {
  const row = await secretFor(c);
  if (!row || !secretOpen(row)) return c.json({ status: "gone" }, 404);
  if (!row.ciphertext) return c.json({ status: secretStatus(row) }, 409);
  if (await markSecretOpened(c.env.DB, row.id)) await anonymousAudit(c, "secret.open", row.id);
  return c.json({ envelope: JSON.parse(row.ciphertext) as SecretEnvelope });
});

secretPages.post("/:token/received", async (c) => {
  if (!sameOrigin(c)) return c.json({ error: "Cross-origin request refused." }, 403);
  const row = await secretFor(c);
  if (!row || !secretOpen(row)) return c.json({ status: "gone" }, 404);
  if (await finishSecret(c.env.DB, row.id, "recipient")) await anonymousAudit(c, "secret.receive", row.id);
  return c.json({ status: "received" });
});
