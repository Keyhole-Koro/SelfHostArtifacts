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
- **A vault** for API keys and passwords: values are encrypted on your computers (device keys in the
  OS keyring, plus a recovery key), opened only there, and piped straight into `gcloud`, `gh`,
  `wrangler` or `circleci`, so they never enter an agent's conversation or the server in plain text.
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

Every page is searchable by its text, Japanese included, and by meaning: a page that says the
same thing in other words is found too (Workers AI and Vectorize, within their free plans for a
personal site). Use the box at the top, or `search` from an agent. Pages published before search
existed get their text with `artifact reindex`, and **Settings → Search by meaning** indexes them. The CLI reads a page's text and links when it publishes, so a page shows which pages
link to it (**Links**), a link to another page opens it in the viewer, and **Versions → Compare
versions** shows what changed in the text.

People write pages too: **Write a page** in a project (or **Move → New page under this one**)
opens an editor in the browser, in Markdown or as you see it. Anyone who can see a page can
**comment** on it, on the whole page or on a passage they select; threads take replies and can be
resolved. Agents read them with `comments` and answer with `comment`, so "fix what the comments
say" works.

**Watch** a page or a whole project to hear about new pages, changes and comments; name someone
with `@` in a comment to tell them. The bell at the top counts what you have not read, and
**Activity** shows what changed lately (`activity` for agents).

**Labels** group pages across projects ("decision", "draft"): add them when publishing
(`--labels`), with `artifact labels`, or from a page's Labels menu; click one to see its pages,
or search with `label:decision`.

A page written in the browser can start from a **template** (meeting notes, a decision record,
a how-to, or any page of the project labeled `template`), and Markdown pages can hold
**macros**, each on a line of its own: `{{toc}}`, `{{children}}`, `{{recent}}`,
`{{label decision}}` and `{{include <page url>}}`. The editor's Insert menu adds them.

A page can be **restricted**: only some people edit it, or only some people see it. The
restriction holds for the pages under it too, and every list, search, feed and notification
leaves out what a person may not see. The owner (and so every agent) sees everything.

When two people edit the same page, each sees that the other is editing, and a page open in
the browser says when a newer version is saved. Saving after someone else merges the two:
changes to different lines are kept together, and lines both changed are marked to settle.

Pages an agent wrote in HTML can be changed in the browser too: **Edit source** opens their
text files in a code editor with a live preview, and saving makes a new version.

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
| `activity` | What changed lately: new pages, changes and comments |
| `labels` | Read a page's labels, or add and remove some |
| `comments` | Read a page's comment threads |
| `comment` | Comment on a page, or reply in a thread and resolve it |
| `delete` | Move a page to the trash (restorable in Settings for 30 days) |
| `secret_share` | Encrypt values from a local file and make a link that only the first browser to open it can read |
| `secret_request` | Make a link for handing a secret to someone |
| `secret_status` | Whether the link was opened (when, from where) and the recipient's key fingerprint |
| `secret_send` | Encrypt values from a local `.env`, JSON or text file for the recipient's browser |
| `secret_delete` | End a secret request and delete its ciphertext |
| `vault_list` | The vault's collections, or the secrets of one (names and the ledger, never values) |
| `vault_put` | Encrypt a value from a local file (or one generated on the spot) and store it as a new version |
| `vault_use` | Open a value on this computer and pipe it into `gcloud secrets versions add`, `gh secret set`, `wrangler secret put` or `circleci context store-secret`, and nothing else; output that contains the value is withheld. It writes no files: people use `artifact vault use --out` |
| `vault_create`, `vault_grant`, `vault_devices` | Make a collection; let another computer read it (after comparing key fingerprints); list computers with a vault key |
| `vault_destroy` | Destroy one version's value, or delete a secret, when the user asks |
| `vault_target`, `vault_status` | Where a value must go (`gcp://`, `circleci://`, `github://`, `wrangler://`; an `envfile://` only from a terminal), and whether the current version arrived there |
| `vault_push` | Deliver stale values to their targets (plan only, unless `apply: true`); each delivery is recorded |

### CLI

```bash
artifact publish ./report.html            # or a folder; prints the URL
artifact publish ./site --allow-connect api.example.com
artifact list [--project MediShare]       # pages are grouped by project
artifact projects                         # projects and how many pages each has
artifact search 要求の列 ring                # pages with every word, Japanese included
artifact reindex                          # send older pages' text, so search finds them
artifact comments https://artifacts.example.com/a/<id>   # open comment threads
artifact comment https://artifacts.example.com/a/<id> "Done" --reply-to <thread> --resolve
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
artifact vault init                       # this computer's key and the owner key; prints the recovery key once
artifact vault create medishare-prod      # a collection: one per project and environment
artifact vault put medishare-prod RESEND_API_KEY --from ./resend.key --used-by "Cloud Run medishare-web"
artifact vault put medishare-prod SESSION_SECRET --generate   # a new random value, never shown
artifact vault use medishare-prod RESEND_API_KEY --run -- gcloud secrets versions add resend-api-key --data-file=-
                                          # --run takes only commands that store a secret: gcloud secrets versions add,
                                          # gh secret set, wrangler secret put, circleci context store-secret
artifact vault use medishare-prod RESEND_API_KEY --out /tmp/resend.key   # a 0600 file
artifact vault grant medishare-prod my-laptop   # after comparing `artifact vault key` fingerprints
artifact vault revoke medishare-prod old-laptop # take it away and replace the collection key
artifact vault recover --recovery-key-file ./recovery.txt   # a new computer, with the recovery key
artifact vault target add medishare-prod RESEND_API_KEY gcp://medishare-492402/medishare-resend-api-key
artifact vault target add medishare-prod RESEND_API_KEY "circleci://<organization id>/medishare-prod/RESEND_API_KEY_PROD?token=tools/CIRCLECI_API_TOKEN"
artifact vault status medishare-prod      # which targets have the current version, which are stale
artifact vault push medishare-prod --dry-run && artifact vault push medishare-prod   # deliver what is stale
artifact vault import medishare-prod PAYJP_SECRET_KEY gcp://medishare-492402/medishare-payjp-secret-key   # take an existing value in
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
