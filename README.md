# SelfHostArticle

Self-hosted, private HTML pages for coding agents — a Claude Artifacts–style publish tool that Codex CLI, Gemini CLI and Claude Code can all use.

- Agents publish a local HTML file (plus assets) through a local stdio MCP server or the `article` CLI and get back a private URL.
- Runs entirely on Cloudflare (Workers, D1, R2) on one hostname you choose.
- Google sign-in for people, per-device Ed25519 keys for agents.

Status: design. See [docs/design.md](docs/design.md) (Japanese).

## License

MIT
