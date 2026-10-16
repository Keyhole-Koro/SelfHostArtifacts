# SelfHostArticle

Private HTML pages for coding agents, on your own Cloudflare account. Codex CLI, Gemini CLI and
Claude Code publish a page with one MCP tool call and get back a URL that only you (and the
viewers you add) can open — like Claude's Artifacts, but self-hosted and for any agent.

```
Agent ──stdio MCP──▶ article (CLI on your computer) ──signed HTTPS──▶ Worker ── D1 + R2
                                                                        │
                       Browser ◀── Google sign-in, sandboxed viewer ────┘
```

- **One hostname**, e.g. `article.example.com`: `/` lists pages, `/a/<id>` shows one,
  `/settings` manages viewers and devices.
- **People** sign in with Google. `ROOT_EMAIL` owns the deployment and adds viewers in Settings.
- **Agents** never hold a password: each computer gets its own Ed25519 key, approved once in the
  browser (`article login`), and signs every request.
- **Pages are isolated**: they run in a CSP sandbox with an opaque origin, so a page's scripts
  cannot read your session, call the API as you, or reach other hosts unless you allow it.
- **Costs**: within Cloudflare's free tiers for personal use (estimate in [docs/design.md](docs/design.md)).

## Deploy

You need a Cloudflare account with a zone (domain) for the hostname, Node 20+ and pnpm.

```bash
git clone https://github.com/Keyhole-Koro/SelfHostArticle.git
cd SelfHostArticle && pnpm install
cd packages/worker
npx wrangler login
pnpm run deploy
```

The script asks for the hostname and the owner's Google account, creates the D1 database and the
R2 bucket, applies migrations, deploys, and sets the secrets. For Google sign-in it asks for an
OAuth client:

1. Google Cloud console → APIs & Services → Credentials → **Create credentials → OAuth client ID**
2. Application type **Web application**, authorized redirect URI `https://<your host>/auth/callback`
3. Paste the client ID and secret when the script asks.

Run `pnpm run deploy` again to update. It reuses `wrangler.local.toml` (git-ignored) and only sets
secrets that are missing. All Cloudflare resources are declared in `wrangler.toml`.

## Use it from your agents

On each computer:

```bash
npm i -g @keyhole-koro/article
article setup --host article.example.com
```

`setup` pairs the computer (approve it in the browser as the owner), registers the MCP server with
every agent it finds (`codex mcp add`, `gemini mcp add --scope user`, `claude mcp add --scope user`)
and installs two skills, `article-design` (how to write a good page) and `article-publish` (when
and how to publish), into `~/.agents/skills` and `~/.claude/skills`. Restart the agents afterwards.

Then ask an agent for a page — "turn this CSV into a dashboard page" — and it writes the HTML,
calls `publish` and gives you the link. Ask for a change and it republishes to the same URL.

### MCP tools

| Tool | What it does |
|---|---|
| `publish` | Publish a local `.html` file, or a folder with `index.html`; the same file again updates the same URL |
| `read` | Read a published page or one of its files |
| `list` | Recent pages |
| `delete` | Move a page to the trash (restorable in Settings for 30 days) |

### CLI

```bash
article publish ./report.html            # or a folder; prints the URL
article publish ./site --allow-connect api.example.com
article list
article read https://article.example.com/a/<id> data.json
article delete https://article.example.com/a/<id>
article status
article uninstall                        # remove the MCP registrations and skills
```

`--profile <name>` keeps a separate deployment or key; `--json` gives machine-readable output.

## Development

```bash
pnpm install
pnpm test          # Worker tests run in workerd with D1 and R2
pnpm typecheck

cd packages/worker
cp .dev.vars.example .dev.vars
npx wrangler d1 migrations apply article --local
pnpm dev           # http://localhost:8787, signs you in as DEV_LOGIN_EMAIL

cd ../cli
node src/cli.ts login --host localhost:8787
```

`DEV_LOGIN_EMAIL` skips Google sign-in and is refused unless `APP_HOST` is localhost.

The design (in Japanese) is in [docs/design.md](docs/design.md).

## License

MIT
