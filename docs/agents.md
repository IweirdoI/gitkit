# 为 Agent 配置 GitKit

[English](agents.en.md) · [项目首页](../README.zh-CN.md)

先安装 GitKit，再用 `npm root -g` 定位安装目录中的 `gitkit-agent/dist/cli.js`。Windows 可直接用 Node 启动这个文件。将 `--cwd` 设为目标 Git 仓库的绝对路径。

## Codex

在目标仓库的 POSIX Shell 中执行：

```sh
CLI="$(npm root -g)/gitkit-agent/dist/cli.js"
REPO="$(git rev-parse --show-toplevel)"
node "$CLI" --version
codex mcp add gitkit -- node "$CLI" mcp --cwd "$REPO"
codex mcp list
```

Windows 可用 Codex 的 MCP 设置，或参考下方 TOML。配置后重开会话。可在项目的 `AGENTS.md` 说明「Git 操作优先使用 GitKit MCP」。验证时问「当前在哪个分支」，检查是否调用 `gitkit.status`。

## Claude 与 Cursor

Claude Code 使用 `claude mcp add --transport stdio gitkit -- node "$CLI" mcp --cwd "$REPO"`。Claude Desktop 的 `claude_desktop_config.json` 和 Cursor 的 `.cursor/mcp.json` 使用下方 JSON。填写绝对路径后重载客户端。

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

编辑 [MCP overlay](../.dsh/mcp.servers.yml) 后运行 `dsh web --patch .dsh/mcp.servers.yml`。也可装原生插件。准备 Harness 版本要求的 Node.js 和 pnpm。

```sh
dsh plugin --profile web add https://github.com/IweirdoI/gitkit/releases/download/v0.1.4/gitkit-agent-0.1.4.tgz
```

## ChatGPT 和其他宿主

受支持的 ChatGPT 工作区可通过 Secure MCP Tunnel 使用同一 stdio 启动命令。[官方配置](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)。其他 stdio 客户端也可使用同一命令，Function Calling 宿主可导入 `inputSchema` 和 `execute`。

## 更新和卸载

- 安装新版 Release 或 npm 指定版本，更新固定版本的启动参数，然后重载客户端。
- Codex 与 Claude Code 分别执行 `codex mcp remove gitkit` 和 `claude mcp remove gitkit`，使用原安装范围。
- 从 Claude Desktop、Cursor 或 Harness overlay 中移除 GitKit 配置并重载。Harness 原生插件用 `dsh plugin --profile web remove gitkit-agent`，将 `web` 替换为原 profile。
- 在 ChatGPT 原工作区断开自定义 app。
- CLI 用 `npm uninstall -g gitkit-agent` 卸载。仅用 `npx` 临时运行时，无全局安装需要卸载。
