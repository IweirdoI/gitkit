# Set up GitKit for an agent

[简体中文](agents.md) · [README](../README.md)

Install GitKit first. Use `npm root -g` to locate its installed `gitkit-agent/dist/cli.js`. Launching this file with Node works for clients that require a direct executable on Windows. Always set `--cwd` to the absolute path of the target repository.

## Codex

From the target repository in a POSIX shell:

```sh
CLI="$(npm root -g)/gitkit-agent/dist/cli.js"
REPO="$(git rev-parse --show-toplevel)"
node "$CLI" --version
codex mcp add gitkit -- node "$CLI" mcp --cwd "$REPO"
codex mcp list
```

On Windows, use the Codex MCP settings or the TOML example below. Reopen the session after configuring it. In the project's `AGENTS.md`, you can add “Use GitKit MCP for Git operations when available.” Ask which branch is active and check the tool trace for `gitkit.status`.

## Claude and Cursor

Claude Code uses `claude mcp add --transport stdio gitkit -- node "$CLI" mcp --cwd "$REPO"`. Use the JSON example in Claude Desktop's `claude_desktop_config.json` or Cursor's `.cursor/mcp.json`. Replace all paths with absolute paths and reload the client.

```toml
[mcp_servers.gitkit]
command = "node"
args = ["/path/to/gitkit-agent/dist/cli.js", "mcp", "--cwd", "/path/to/repository"]
```
```json
{
  "mcpServers": {
    "gitkit": {
      "command": "node",
      "args": ["/path/to/gitkit-agent/dist/cli.js", "mcp", "--cwd", "/path/to/repository"]
    }
  }
}
```

## DeepSeek Harness

Set the paths in the [MCP overlay](../.dsh/mcp.servers.yml), then use `dsh web --patch .dsh/mcp.servers.yml`. The native plugin can be installed with the following command. Use the Node.js version your Harness requires and have pnpm on PATH.

```sh
dsh plugin --profile web add https://github.com/IweirdoI/gitkit/releases/download/v0.1.3/gitkit-agent-0.1.3.tgz
```

## ChatGPT and other hosts

A supported ChatGPT workspace can add GitKit via a Secure MCP Tunnel and use the same stdio command. [Official tunnel setup](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels). Other stdio hosts can use the same command. JavaScript function-calling hosts can import `inputSchema` and `execute`.

## Update and uninstall

- Install a newer pinned release or npm version, update version-pinned launchers, then reload the client.
- Codex and Claude Code use `codex mcp remove gitkit` and `claude mcp remove gitkit` respectively. Use the original installation scope.
- Remove GitKit from the MCP configuration in Claude Desktop, Cursor or the Harness overlay and reload. For the native Harness plugin, use `dsh plugin --profile web remove gitkit-agent` with the original profile.
- Disconnect the custom app in the ChatGPT workspace.
- Remove the persistent CLI with `npm uninstall -g gitkit-agent`. A one-off `npx` run creates no global installation.
