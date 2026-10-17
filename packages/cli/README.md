# @keyhole-koro/artifacts

Publish private HTML pages from Codex CLI, Gemini CLI and Claude Code to your own
[SelfHostArtifacts](https://github.com/Keyhole-Koro/SelfHostArtifacts) deployment on Cloudflare.

```bash
npm i -g @keyhole-koro/artifacts
artifact setup --host artifacts.example.com
```

`setup` pairs this computer with the deployment (you approve it in the browser), registers the
`artifact` MCP server with every agent it finds, and installs the `selfhost-artifact-design` and
`selfhost-artifact-publish` skills. Restart your agents, then ask one for a page.

## MCP tools

| Tool | What it does |
|---|---|
| `publish` | Publish a local `.html` file, or a folder with `index.html`; the same file again updates the same URL |
| `read` | Read a published page or one of its files |
| `list` | Recent pages |
| `delete` | Move a page to the trash (restorable for 30 days) |

## CLI

```bash
artifact publish ./report.html     # or a folder; prints the URL
artifact list
artifact read <url> [path]
artifact delete <url>
artifact status
artifact open [url]                # sign the browser in with this computer's key
artifact uninstall                 # remove the MCP registrations and skills
```

You need a deployment first; see the [repository](https://github.com/Keyhole-Koro/SelfHostArtifacts#deploy).

MIT
