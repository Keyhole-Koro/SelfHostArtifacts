import type { Child } from "hono/jsx";
import { raw } from "hono/html";

/**
 * Design tokens, shared with the viewer bar. They match skills/selfhost-artifact-design so the
 * app and the pages it shows look like one product.
 */
export const TOKENS = `
:root {
  color-scheme: light;
  --bg: #f8f8f7; --surface: #ffffff; --surface-2: #f1f1ef;
  --text: #1a1a19; --text-2: #5f5e5a; --text-3: #8b8a85;
  --border: #e4e3df; --border-strong: #cfcdc7;
  --accent: #2f5bd3; --accent-text: #ffffff; --accent-soft: #e8eefc;
  --positive: #1d7a46; --negative: #c0362c; --warning: #8f5407;
  --font-sans: system-ui, -apple-system, "Segoe UI", Roboto, "Hiragino Sans", "Noto Sans JP", "Noto Sans CJK JP", sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Noto Sans Mono", monospace;
  --text-xs: 0.75rem; --text-sm: 0.875rem; --text-md: 1rem; --text-lg: 1.25rem; --text-xl: 1.5rem; --text-2xl: 2rem;
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px; --space-5: 24px; --space-6: 32px; --space-7: 48px; --space-8: 64px;
  --radius: 10px; --radius-sm: 6px;
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --bg: #141413; --surface: #1c1c1b; --surface-2: #262624;
    --text: #ecebe8; --text-2: #a9a8a2; --text-3: #75746f;
    --border: #2f2f2c; --border-strong: #42413d;
    --accent: #7c9dff; --accent-text: #0e1220; --accent-soft: #1d2540;
    --positive: #4cc27e; --negative: #f0756a; --warning: #e3a447;
  }
}
`;

const STYLES = `
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--text); font: 400 var(--text-md)/1.6 var(--font-sans); }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
code { font: var(--text-sm)/1.5 var(--font-mono); background: var(--surface-2); padding: 1px 5px; border-radius: 4px; overflow-wrap: anywhere; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

/* ---- Header ---- */
.top { position: sticky; top: 0; z-index: 10; background: color-mix(in srgb, var(--bg) 88%, transparent); backdrop-filter: blur(8px); border-bottom: 1px solid var(--border); }
.top-inner { max-width: 960px; margin: 0 auto; padding: 0 var(--space-4); height: 56px; display: flex; align-items: center; gap: var(--space-4); }
.brand { display: flex; align-items: center; gap: var(--space-2); font-weight: 650; color: var(--text); }
.brand:hover { text-decoration: none; }
.brand-mark { width: 22px; height: 22px; border-radius: 6px; background: var(--accent); display: grid; place-items: center; color: var(--accent-text); font-size: 13px; font-weight: 700; }
.menu { margin-left: auto; position: relative; }
.menu > summary { list-style: none; cursor: pointer; display: flex; align-items: center; gap: var(--space-2); padding: var(--space-1) var(--space-2); border-radius: var(--radius-sm); color: var(--text-2); font-size: var(--text-sm); }
.menu > summary::-webkit-details-marker { display: none; }
.menu > summary:hover { background: var(--surface-2); color: var(--text); }
.avatar { width: 26px; height: 26px; border-radius: 50%; background: var(--accent-soft); color: var(--accent); display: grid; place-items: center; font-weight: 650; font-size: var(--text-xs); }
.menu-panel { position: absolute; right: 0; top: calc(100% + 6px); min-width: 200px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: 0 4px 16px rgb(0 0 0 / 0.12); padding: var(--space-1); }
.menu-panel a, .menu-panel button { display: block; width: 100%; text-align: left; padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm); color: var(--text); font: inherit; font-size: var(--text-sm); background: none; border: 0; cursor: pointer; }
.menu-panel a:hover, .menu-panel button:hover { background: var(--surface-2); text-decoration: none; }
.menu-panel hr { border: 0; border-top: 1px solid var(--border); margin: var(--space-1) 0; }
.menu-who { padding: var(--space-2) var(--space-3); font-size: var(--text-xs); color: var(--text-2); }

/* ---- Page ---- */
main { max-width: 760px; margin: 0 auto; padding: var(--space-6) var(--space-4) var(--space-8); }
h1 { font-size: var(--text-xl); line-height: 1.3; font-weight: 700; letter-spacing: -0.01em; margin: 0 0 var(--space-2); }
h2 { font-size: var(--text-md); font-weight: 650; margin: 0; }
p { margin: 0 0 var(--space-3); }
.muted { color: var(--text-2); }
.small { font-size: var(--text-sm); }
.page-head { display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap; margin-bottom: var(--space-5); }
.page-head h1 { margin: 0; }
.page-head .lead { margin: var(--space-1) 0 0; color: var(--text-2); font-size: var(--text-sm); }

/* ---- Sections (settings, account) ---- */
.section { padding: var(--space-6) 0; border-top: 1px solid var(--border); }
.section:first-of-type { border-top: 0; padding-top: var(--space-2); }
.section-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4); margin-bottom: var(--space-4); }
.section-head p { margin: var(--space-1) 0 0; color: var(--text-2); font-size: var(--text-sm); max-width: 56ch; }

/* ---- Rows: hairline-separated lists ---- */
.rows { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--border); }
.rows > li { display: flex; align-items: center; gap: var(--space-4); padding: var(--space-3) var(--space-1); border-bottom: 1px solid var(--border); position: relative; }
.rows .main { flex: 1; min-width: 0; }
.rows .title { font-weight: 600; color: var(--text); }
.rows .desc { color: var(--text-2); font-size: var(--text-sm); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.rows .side { display: flex; align-items: center; gap: var(--space-3); flex-shrink: 0; color: var(--text-2); font-size: var(--text-sm); font-variant-numeric: tabular-nums; white-space: nowrap; }
.rows.links > li:hover { background: var(--surface-2); }
.rows.links .title::after { content: ""; position: absolute; inset: 0; } /* the whole row is the link */
.rows .empty { color: var(--text-2); font-size: var(--text-sm); padding: var(--space-4) var(--space-1); }
@media (max-width: 560px) {
  .rows > li { flex-wrap: wrap; gap: var(--space-1) var(--space-3); }
  .rows .side { width: 100%; }
}

/* ---- Controls ---- */
button, .button { display: inline-flex; align-items: center; justify-content: center; gap: var(--space-2); font: inherit; font-size: var(--text-sm); font-weight: 600; padding: 7px var(--space-4); border-radius: var(--radius-sm); border: 1px solid var(--border-strong); background: var(--surface); color: var(--text); cursor: pointer; text-decoration: none; }
button:hover, .button:hover { background: var(--surface-2); text-decoration: none; }
button.primary, .button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
button.primary:hover, .button.primary:hover { background: color-mix(in srgb, var(--accent) 88%, var(--text)); }
button.quiet { border-color: transparent; background: none; color: var(--text-2); padding: 4px var(--space-2); font-weight: 500; }
button.quiet:hover { color: var(--text); background: var(--surface-2); }
button.danger { border-color: transparent; background: none; color: var(--negative); padding: 4px var(--space-2); font-weight: 500; }
button.danger:hover { background: color-mix(in srgb, var(--negative) 10%, transparent); }
button:disabled { opacity: 0.6; cursor: default; }
input[type=text], input[type=email], input[type=search] { width: 100%; font: inherit; font-size: var(--text-md); padding: 7px var(--space-3); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); background: var(--surface); color: var(--text); }
input::placeholder { color: var(--text-3); }
label { display: block; font-size: var(--text-sm); font-weight: 500; color: var(--text-2); margin-bottom: var(--space-1); }
form.inline { display: inline; }
.field-row { display: flex; gap: var(--space-2); }
.field-row input { flex: 1; }
input.search { width: min(260px, 100%); }
@media (max-width: 560px) { input.search { width: 100%; } }
.badge { display: inline-block; font-size: var(--text-xs); font-weight: 600; padding: 1px var(--space-2); border-radius: 999px; background: var(--surface-2); color: var(--text-2); vertical-align: 2px; }
.badge.warn { background: color-mix(in srgb, var(--warning) 14%, var(--surface)); color: var(--warning); }
.badge.accent { background: var(--accent-soft); color: var(--accent); }

/* ---- Pieces used by sign-in, invites and pairing ---- */
.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: var(--space-5); }
.narrow { max-width: 420px; margin: var(--space-6) auto 0; }
.stack { display: grid; gap: var(--space-3); }
.code { font: 600 28px/1.2 var(--font-mono); letter-spacing: 2px; }
.passkey-error { color: var(--negative); font-size: var(--text-sm); margin: var(--space-2) 0 0; }
.qr { background: #ffffff; padding: var(--space-3); border-radius: var(--radius); width: min(280px, 100%); margin: var(--space-4) 0; border: 1px solid var(--border); }
.qr svg { display: block; width: 100%; height: auto; }
.link-box { font: var(--text-sm)/1.5 var(--font-mono); word-break: break-all; background: var(--surface-2); border-radius: var(--radius-sm); padding: var(--space-3); }
`;

export interface PageViewer {
  name: string;
  role: "root" | "viewer";
  csrf: string;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const letters = parts.length > 1 ? parts[0]![0]! + parts[1]![0]! : (parts[0]?.[0] ?? "?");
  return letters.toUpperCase();
}

export function Page(props: { title: string; viewer?: PageViewer; passkeys?: boolean; narrow?: boolean; children: Child }) {
  const viewer = props.viewer;
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="referrer" content="same-origin" />
        {viewer && <meta name="csrf" content={viewer.csrf} />}
        <title>{props.title}</title>
        <style>{raw(TOKENS + STYLES)}</style>
        {props.passkeys && <script src="/assets/passkey.js" defer></script>}
      </head>
      <body>
        <header class="top">
          <div class="top-inner">
            <a class="brand" href="/">
              <span class="brand-mark" aria-hidden="true">A</span>
              Artifacts
            </a>
            {viewer && (
              <details class="menu">
                <summary>
                  <span class="avatar" aria-hidden="true">
                    {initials(viewer.name)}
                  </span>
                  <span>{viewer.name}</span>
                </summary>
                <div class="menu-panel">
                  <div class="menu-who">{viewer.role === "root" ? "Owner" : "Viewer"}</div>
                  <a href="/account">Account</a>
                  {viewer.role === "root" && <a href="/settings">Settings</a>}
                  <hr />
                  <form method="post" action="/auth/logout">
                    <CsrfField token={viewer.csrf} />
                    <button type="submit">Sign out</button>
                  </form>
                </div>
              </details>
            )}
          </div>
        </header>
        <main>{props.narrow ? <div class="narrow">{props.children}</div> : props.children}</main>
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

/** "just now", "5 min ago", "3 h ago", "2 d ago", then the date. */
export function ago(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  if (seconds < 86400 * 30) return `${Math.floor(seconds / 86400)} d ago`;
  return iso.slice(0, 10);
}

/** A time shown relatively, with the exact time on hover. */
export function Time(props: { iso: string }) {
  return (
    <time datetime={props.iso} title={formatTime(props.iso)}>
      {ago(props.iso)}
    </time>
  );
}
