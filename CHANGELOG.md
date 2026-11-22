# Changelog

## 0.2.0

- Add the shared Issue tool for GitHub and Gitee: create, list, view, update and comment, with close/reopen through update.
- Return compact paginated lists and fetch full bodies only through view.
- Verify GitHub Issue writes against a real repository and test Gitee routes through simulation.
- Document provider boundaries and consolidate older public Releases into recoverable drafts.

新增 Issue 管理、精简分页列表、双语指南和平台范围说明。旧公开发行页归档为可恢复草稿。

## 0.1.4

- Add explicit cross-fork PR targets through push --base-repo.
- Add push --pr-only with API verification of the remote source commit.
- Classify connection failures as network_error and retry read-only remote discovery once.
- Preserve native push hooks, LFS checks, and force-with-lease semantics.

新增跨 Fork 目标仓库与已推送分支的 API-only PR 同步。只读连接探测支持一次有限重试。API Git 对象上传暂未提供。

## 0.1.3

- Return the stored commit subject after hooks, alongside the requested message and commit ID. Agents can report the completed commit directly.
- Add a regression test for hook-rewritten commit messages. All 15 local tests pass.
- Publish sanitized paired experiments with completed and failed attempts preserved. Overall savings against native Git in the latest 12-pair run were 35.38% total tokens and 16.02% mean wall time.

提交结果新增实际 subject，保留请求 message 与提交 ID，并验证 hook 改写标题的行为。附清洗后的新实验与适用范围。

## 0.1.2

Resolve Windows managed worktree paths across drive-letter casing and directory aliases.

修复 Windows 工作树路径大小写和目录别名兼容问题。
