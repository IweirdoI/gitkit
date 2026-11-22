# Issue 管理

[English](issues.en.md)

CLI、MCP、原生插件共享 issue 核心。显式指定 repo 和 platform 时无需本地 Git 仓库，否则从 origin 或指定 remote 识别 GitHub/Gitee。

```sh
gitkit issue create --repo owner/project --platform github --title "导出失败" --body "复现步骤和预期结果" --dry-run
gitkit issue list --repo owner/project --platform github --limit 5
gitkit issue view --repo owner/project --platform github --number 7
gitkit issue comment --repo owner/project --platform github --number 7 --body "已定位原因"
gitkit issue update --repo owner/project --platform github --number 7 --state closed
gitkit issue update --repo owner/project --platform github --number 7 --state open
```

创建时去掉 dry-run 才提交到平台。GitHub 需要 GITHUB_TOKEN 或 GH_TOKEN，Gitee 需要 GITEE_TOKEN。Gitee 编号可以是字母数字串。
列表只返回编号、标题、状态与链接，正文通过 view 按需读取。分页用 page 和 limit，next_page 标明下一页候选。
GitHub 列表排除 PR，PR 占用的 API 页位置仍计入分页，因此当前页可能少于 limit。
更新 title 或 body 可改标题、正文，传空 body 可清除正文。工具拒绝把 GitHub PR 当 Issue 编辑。

写操作发生网络错误时，创建或评论可能已成功。工具不会自动重放，须先检查平台后重试。
创建本身不提供跨进程严格幂等保证，重复执行可能产生重复 Issue。

Agent 可以接受「给上游仓库提交缺陷」「看最近五个问题」「给7号问题补充复现」「关闭已修复问题」等请求。
仅描述一个问题并不等于允许自动向他人仓库发帖，宿主应按用户授权调用写操作。
