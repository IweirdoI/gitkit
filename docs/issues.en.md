# Issue management

[简体中文](issues.md)

CLI, MCP and the native plugin share the issue core. Explicit repo and platform arguments work outside Git repositories. Otherwise the remote URL identifies GitHub or Gitee.

```sh
gitkit issue create --repo owner/project --platform github --title "Export fails" --body "Steps and expected result" --dry-run
gitkit issue list --repo owner/project --platform github --limit 5
gitkit issue view --repo owner/project --platform github --number 7
gitkit issue comment --repo owner/project --platform github --number 7 --body "Cause identified"
gitkit issue update --repo owner/project --platform github --number 7 --state closed
gitkit issue update --repo owner/project --platform github --number 7 --state open
```

Remove dry-run to create the issue. Configure GITHUB_TOKEN or GH_TOKEN for GitHub and GITEE_TOKEN for Gitee.
List returns number, title, state and URL. View returns the body. Use page and limit for pagination, following next_page when present.
GitHub API pages include PR entries, which the tool filters out; an Issue page can contain fewer than limit items.
Update supports title, body and state. An empty body clears the description. GitHub PR entries are rejected by Issue write actions.

Create and comment are not automatically replayed after timeouts or network errors. Inspect the platform before retrying an uncertain write.
Repeated creates can produce duplicates; cross-process strict idempotency is not provided.
Agents should follow the user's authorization and host approval settings before posting to a repository.
