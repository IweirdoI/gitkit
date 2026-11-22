# Contributing · 参与贡献

## English

1. Search [open issues](https://github.com/IweirdoI/gitkit/issues). Include versions and minimal reproduction steps. Report vulnerabilities through [SECURITY.md](SECURITY.md).
2. Fork the repository and create a topic branch from `master`.
3. Run `npm ci`, `npm test` and `npm pack --dry-run`. Update both READMEs for installation or primary usage changes. Use `docs/` for longer configuration instructions.
4. Open a PR against `master` with the change, tests and any linked issue.

Maintainers triage with labels, review green CI runs, and squash accepted PRs. Tag each release with its npm package version and build both distributions from that commit.

Collect related improvements before cutting a stable release. The public Releases page keeps the current stable release. Superseded releases are retained as restorable drafts, while Git tags preserve source history. Drafting a release makes its old public asset URLs unavailable, so installation instructions always point to the current version.

## 简体中文

1. 先查 [Issues](https://github.com/IweirdoI/gitkit/issues)，再报告版本和最小复现。发现漏洞请按 [SECURITY.md](SECURITY.md) 私下报告。
2. Fork 后从 `master` 建立主题分支。
3. 运行 `npm ci`、`npm test`、`npm pack --dry-run`。安装与基本用法变化时同步更新两份 README，长篇配置指南放 `docs/`。
4. 向 `master` 提交 PR，写明改动、验证方式，并关联 Issue。

维护者用标签分流问题，检查 CI 和审阅后 squash 合并。发布标签与 npm 包版本一致，从同一提交构建两个渠道的发行包。

把相关改进集中到稳定版发布，避免每次小改动都新建公开版本。公开 Releases 保留当前稳定版，旧发行页转为可恢复草稿，Git 标签保留源码历史。转草稿后旧公开安装包链接失效，安装说明统一指向当前版本。
