# Tadooer assistant plugin

Local stdio MCP plus a workflow skill for Codex and Claude Code. Both manifests reference the same MCP configuration and skill. This is an initial capability subset, not full Super Productivity parity or a hosted ChatGPT/Claude connector.

## Install the runtime

Requires Node.js 24 or newer. From the repository:

```sh
pnpm --filter @suite/mcp-stdio build
node deploy/install-assistant.mjs
```

The installer writes `~/.local/bin/tadooer-mcp`, its bundled runtime, and a copy of this plugin at `~/.local/share/tadooer/plugin`. Use `--prefix <directory>` for another destination. Ensure the chosen `bin` directory is in the assistant client's PATH. Rebuild and rerun the installer to update. It does not edit client registration or credentials.

Create a scoped automation token in Tadooer Connections. Store the secret in a regular file owned by your user, mode `0600`; do not put it in a plugin manifest, shell argument, or chat. Create `~/.config/tadooer/mcp.json`:

```json
{
  "url": "https://tadooer.subcult.tv",
  "tokenFile": "/absolute/path/to/private-tadooer-token"
}
```

`XDG_CONFIG_HOME` changes the configuration root; `TADOOER_MCP_CONFIG` overrides the settings path. Explicit `--url` and `--token-file` arguments remain supported. HTTPS is required except for loopback development servers.

Load the copied plugin through your client's local plugin support. For Claude Code, use `claude --plugin-dir ~/.local/share/tadooer/plugin`. For Codex, the `.codex-plugin/plugin.json` manifest is included for local marketplace registration. Client installation and subscription availability must be qualified in the target client; the stdio protocol check alone does not prove either. No marketplace or user installation is modified by the repository installer.

## Available surface

| Capability                                                                   | Status                |
| ---------------------------------------------------------------------------- | --------------------- |
| Read tasks, projects, tags, schedules, focus, habits, templates, sets, pools | Tools and resources   |
| Create tasks and time blocks                                                 | Preview, then confirm |
| Focus lifecycle and takeover                                                 | Preview, then confirm |
| Instantiate templates/sets, resolve placeholders, mutate habits              | Preview, then confirm |
| General task update/completion/deletion; project/tag mutation                | Not yet exposed       |
| Full hierarchy, recurrence, worklog migration                                | Not yet implemented   |
| Google–Baikal two-way hub                                                    | Not yet implemented   |
| Hosted MCP with scoped OAuth                                                 | Not yet implemented   |
| Embedded subscription-backed assistant runtime                               | Not yet implemented   |

The shared server contract generates the MCP catalog. The workflow skill requires concrete review for bulk and destructive actions. Server authorization, revision checks, expiring previews, and idempotent confirmation remain authoritative; skill instructions alone are not a security boundary. No model API key or paid inference fallback is configured by this package.
