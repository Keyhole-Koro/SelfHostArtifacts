import type { Child } from "hono/jsx";
import { raw } from "hono/html";

const STYLES = `
:root {
  --bg: #fafaf9; --surface: #ffffff; --text: #1c1917; --muted: #78716c; --border: #e7e5e4;
  --accent: #2563eb; --accent-text: #ffffff; --danger: #b91c1c; --badge-bg: #fef3c7; --badge-text: #92400e;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0c0a09; --surface: #1c1917; --text: #f5f5f4; --muted: #a8a29e; --border: #292524;
    --accent: #60a5fa; --accent-text: #0c0a09; --danger: #f87171; --badge-bg: #422006; --badge-text: #fcd34d;
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
a { color: var(--accent); }
header.top { display: flex; align-items: center; gap: 16px; padding: 12px 16px; border-bottom: 1px solid var(--border); background: var(--surface); }
header.top .brand { font-weight: 600; color: var(--text); text-decoration: none; }
header.top nav { margin-left: auto; display: flex; gap: 16px; align-items: center; font-size: 14px; }
main { max-width: 880px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 22px; margin: 0 0 16px; }
h2 { font-size: 17px; margin: 32px 0 12px; }
.muted { color: var(--muted); }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 16px; }
.list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.list li { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 12px 16px; }
.list .title { font-weight: 600; text-decoration: none; color: var(--text); }
.list .meta { font-size: 13px; color: var(--muted); }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.row .grow { flex: 1; min-width: 0; }
.badge { display: inline-block; font-size: 12px; padding: 1px 8px; border-radius: 999px; background: var(--badge-bg); color: var(--badge-text); }
input[type=text], input[type=email], input[type=search] { width: 100%; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--text); font: inherit; }
button { padding: 7px 14px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface); color: var(--text); font: inherit; cursor: pointer; }
button.primary { background: var(--accent); color: var(--accent-text); border-color: var(--accent); }
a.button { display: inline-block; text-align: center; text-decoration: none; padding: 7px 14px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface); color: var(--text); }
button:disabled { opacity: 0.6; cursor: default; }
button.danger { color: var(--danger); }
form.inline { display: inline; }
code { font-size: 13px; }
.code { font: 600 28px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 2px; }
.stack { display: grid; gap: 12px; max-width: 420px; }
.passkey-error { color: var(--danger); margin: 8px 0 0; }
.link-box { font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; }
`;

export interface PageViewer {
  name: string;
  role: "root" | "viewer";
  csrf: string;
}

export function Page(props: { title: string; viewer?: PageViewer; passkeys?: boolean; children: Child }) {
  const viewer = props.viewer;
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="referrer" content="same-origin" />
        {viewer && <meta name="csrf" content={viewer.csrf} />}
        <title>{props.title}</title>
        <style>{raw(STYLES)}</style>
        {props.passkeys && <script src="/assets/passkey.js" defer></script>}
      </head>
      <body>
        <header class="top">
          <a class="brand" href="/">Artifacts</a>
          {viewer && (
            <nav>
              {viewer.role === "root" && <a href="/settings">Settings</a>}
              <a href="/account" class="muted">{viewer.name}</a>
              <form class="inline" method="post" action="/auth/logout">
                <CsrfField token={viewer.csrf} />
                <button type="submit">Sign out</button>
              </form>
            </nav>
          )}
        </header>
        <main>{props.children}</main>
      </body>
    </html>
  );
}

export function CsrfField(props: { token: string }) {
  return <input type="hidden" name="csrf" value={props.token} />;
}

export function formatTime(iso: string): string {
  return iso.replace("T", " ").slice(0, 16) + " UTC";
}
