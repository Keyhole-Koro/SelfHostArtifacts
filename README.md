# SelfHostArtifacts

Private HTML pages for coding agents, on your own Cloudflare account. Codex CLI, Gemini CLI and
Claude Code publish a page with one MCP tool call and get back a URL that only you (and the
viewers you add) can open — like Claude's Artifacts, but self-hosted and for any agent.

![An artifact open in the viewer: a cost estimate with stat tiles and a chart](docs/images/viewer.png)

```
Agent ──stdio MCP──▶ artifact (CLI on your computer) ──signed HTTPS──▶ Worker ── D1 + R2
                                                                        │
                       Browser ◀── passkey sign-in, sandboxed viewer ───┘
```

- **One hostname**, e.g. `artifacts.example.com`: `/` lists pages, `/a/<id>` shows one,
  `/settings` manages viewers and devices.
- **People** sign in with a passkey (fingerprint, face or screen lock). No OAuth app, no
  passwords. The owner invites viewers with single-use links, and a QR code on the account page
  signs in your phone.
- **Agents** never hold a password: each computer gets its own Ed25519 key, approved once in the
  browser (`artifact login`), and signs every request.
- **Pages are isolated**: they run in a CSP sandbox with an opaque origin, so a page's scripts
  cannot read your session, call the API as you, or reach other hosts unless you allow it.
- **Costs**: within Cloudflare's free tiers for personal use (estimate in [docs/design.md](docs/design.md)).

## What it looks like

You ask an agent for a page; it writes the HTML following the bundled design skill and publishes it.
Roughly, in Claude Code:

```text
> Make a page comparing our Cloudflare costs for personal and heavier use.

● selfhost-artifact-design (skill)
● Write examples/cost-estimate/index.html
● artifact.publish({ file_path: ".../cost-estimate/index.html" })
  ⎿ Published: https://artifacts.example.com/a/kfrxazsjwefc1xnf (version 1, private)

The page is at https://artifacts.example.com/a/kfrxazsjwefc1xnf
```

Ask for a change and it republishes to the same URL as version 2; older versions stay under
**Versions**.

<table>
<tr>
<td width="32%"><img src="docs/images/phone-dark.png" alt="The same page on a phone in dark mode"></td>
<td><img src="docs/images/tool-dark.png" alt="An interactive page: a contrast checker with tabs and a table, in dark mode"></td>
</tr>
<tr>
<td align="center">Phone, dark mode</td>
<td align="center">Interactive pages work too (scripts run in the sandbox)</td>
</tr>
</table>

| Your pages | Settings |
|---|---|
| ![The list of published artifacts with titles, descriptions, versions and search](docs/images/list.png) | ![Settings: people with their passkeys, invite links and devices](docs/images/settings.png) |

The sample pages are in [`examples/`](examples); publish one yourself with
`artifact publish examples/cost-estimate`.

## Deploy

You need a Cloudflare account with a zone (domain) for the hostname, Node 20+ and pnpm.

```bash
git clone https://github.com/Keyhole-Koro/SelfHostArtifacts.git
cd SelfHostArtifacts && pnpm install
cd packages/worker
npx wrangler login
pnpm run deploy
```

The script asks for the hostname, creates the D1 database and the R2 bucket, applies migrations,
deploys and generates the secrets. Nothing outside Cloudflare is needed. At the end it prints a
**one-time owner link**: open it and create a passkey, and you own the deployment.

```
Open this link to create the owner's passkey (works once, for 1 day):

  https://artifacts.example.com/invite/…
```

Then, in **Settings → People → Create invite link**, invite viewers. Each link works once; the
person opening it creates their own passkey. Add a passkey for each of your devices under
**Account** (passkeys synced by iCloud Keychain or Google Password Manager follow you anyway).

Pages are grouped by **project**: a new page goes into the project named after the git
repository the agent works in, and the list has a button for each project. Inside a project,
pages form a tree: publish a page with `parent` to put it under another, and the project shows as
that tree, with the tree beside each page and a trail above it. Move a page from its **Move** menu
or with `artifact move`. In a project's settings you describe it and choose who sees it: every
viewer, or only the members you add (editors among them may also rearrange its pages).

Every page is searchable by its text, Japanese included: use the box at the top, or `search` from
an agent. The CLI reads a page's text and links when it publishes, so a page shows which pages
link to it (**Links**), a link to another page opens it in the viewer, and **Versions → Compare
versions** shows what changed in the text.

To show a page to someone without an account, open it and choose **Share → Create public link**:
anyone with that link can view the latest version, without signing in, for 30 days. You can extend
it, replace it with a new link or turn it off; agents cannot make pages public.

To hand someone a password or an API key, an agent can make a **share link** (`secret_share`):
it encrypts the values on your computer and puts the key after the `#` of the link, which browsers
never send to the server. The first browser that opens the link and presses Show reads them; from
then on no other browser can, even with the link. If you want to compare key fingerprints before
anything is sent, use a **secret request** instead (`secret_request`, then `secret_send` once the
recipient has opened it). Either way the Worker only ever stores ciphertext, which is deleted when
the recipient is done or the link expires (72 hours by default). **Settings → Secrets** shows who
opened each link.

Lost every passkey? Run `pnpm run deploy --owner-link` for a new owner link. `artifact open`
creates a view-only browser session and cannot change passkeys, people or devices.

Run `pnpm run deploy` again to update. It reuses `wrangler.local.toml` (git-ignored) and only sets
secrets that are missing. All Cloudflare resources are declared in `wrangler.toml`.


### Deploy from GitHub Actions

After the first deploy, pushing the `publish` branch releases from GitHub Actions:
`deploy-worker.yml` deploys the Worker (tests first, then migrations, deploy and a health check),
and `publish-cli.yml` publishes the CLI to npm when `packages/cli/package.json` has a version that
is not on npm yet. `main` only runs the tests. To release, push `main` into `publish`:

```bash
git push origin main:publish
```

In your fork, add under Settings → Secrets and variables → Actions:

| Kind | Name | Value |
|---|---|---|
| Secret | `CLOUDFLARE_API_TOKEN` | API token from the "Edit Cloudflare Workers" template, plus **D1: Edit** |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | Your account id (`npx wrangler whoami`) |
| Variable | `APP_HOST` | Your hostname |
| Variable | `D1_DATABASE_ID` | `database_id` from `wrangler.local.toml` |

Without `APP_HOST` the deploy job is skipped, so forks do not try to deploy. The CLI is published
with npm trusted publishing, so no npm token is stored; register `publish-cli.yml` as the
package's trusted publisher on npmjs.com.

## Use it from your agents

On each computer:

```bash
npm i -g @keyhole-koro/artifacts
artifact setup --host artifacts.example.com
```

`setup` pairs the computer (approve it in the browser as the owner), registers the MCP server with
every agent it finds (`codex mcp add`, `gemini mcp add --scope user`, `claude mcp add --scope user`)
and installs two skills, `selfhost-artifact-design` (how to write a good page) and `selfhost-artifact-publish` (when
and how to publish), into `~/.agents/skills` and `~/.claude/skills`. Restart the agents afterwards.

Then ask an agent for a page — "turn this CSV into a dashboard page" — and it writes the HTML,
calls `publish` and gives you the link. Ask for a change and it republishes to the same URL.

### MCP tools

| Tool | What it does |
|---|---|
| `publish` | Publish a local `.html` file, or a folder with `index.html`; the same file again updates the same URL |
| `read` | Read a published page or one of its files |
| `list` | Recent pages, optionally of one project |
| `move` | Move a page to another project, under another page, or to another place among its siblings |
| `search` | Find pages by words in their title, description or text |
| `delete` | Move a page to the trash (restorable in Settings for 30 days) |
| `secret_share` | Encrypt values from a local file and make a link that only the first browser to open it can read |
| `secret_request` | Make a link for handing a secret to someone |
| `secret_status` | Whether the link was opened (when, from where) and the recipient's key fingerprint |
| `secret_send` | Encrypt values from a local `.env`, JSON or text file for the recipient's browser |
| `secret_delete` | End a secret request and delete its ciphertext |

### CLI

```bash
artifact publish ./report.html            # or a folder; prints the URL
artifact publish ./site --allow-connect api.example.com
artifact list [--project MediShare]       # pages are grouped by project
artifact projects                         # projects and how many pages each has
artifact search 要求の列 ring                # pages with every word, Japanese included
artifact move https://artifacts.example.com/a/<id> MediShare
artifact publish ./setup.html --parent https://artifacts.example.com/a/<id>   # a page under another
artifact move https://artifacts.example.com/a/<id> --parent top --position 1
artifact read https://artifacts.example.com/a/<id> data.json
artifact delete https://artifacts.example.com/a/<id>
artifact status
artifact open [url]                       # open a view-only browser session with this computer's key
artifact secret share ./mail.env --label "Mail passwords" --key SMTP_PASSWORD=notify@example.com
                                                         # prints the link, with its key after #
artifact secret request --label "Mail passwords"        # prints the recipient's link
artifact secret status <id>                              # opened? key fingerprint
artifact secret send <id> ./mail.env --key SMTP_PASSWORD=notify@example.com
artifact uninstall                        # remove the MCP registrations and skills
```

`--profile <name>` keeps a separate deployment or key; `--json` gives machine-readable output;
`--browser chrome` (or `ARTIFACT_BROWSER=chrome`) picks the browser for `login` and `open`, Flatpak
browsers included; `ARTIFACT_BROWSER=none` only prints the link.

## Development

```bash
pnpm install
pnpm test          # Worker tests run in workerd with D1 and R2
pnpm typecheck

cd packages/worker
cp .dev.vars.example .dev.vars
npx wrangler d1 migrations apply artifacts --local
pnpm dev           # http://localhost:8787, DEV_LOGIN signs you in as the owner

cd ../cli
node src/cli.ts login --host localhost:8787
```

`DEV_LOGIN` skips sign-in (you become the owner) and is refused unless `APP_HOST` is localhost.

To retake the screenshots in this README after changing the UI:

```bash
npx playwright install chromium   # once
pnpm screenshots                  # or: pnpm screenshots list settings
```

It starts a throwaway local deployment, adds sample people, publishes the pages in `examples/`
through the real CLI and writes `docs/images/*.png`. The shots are listed at the top of
`scripts/screenshots.mjs`.

The design (in Japanese) is in [docs/design.md](docs/design.md).

## License

MIT
