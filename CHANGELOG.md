# Changelog

## 0.1.3

- Return the stored commit subject after hooks, alongside the requested message and commit ID. Agents can report the completed commit directly.
- Add a regression test for hook-rewritten commit messages. All 15 local tests pass.
- Publish sanitized paired experiments with completed and failed attempts preserved. Overall savings against native Git in the latest 12-pair run were 35.38% total tokens and 16.02% mean wall time.

提交结果新增实际 subject，保留请求 message 与提交 ID，并验证 hook 改写标题的行为。附清洗后的新实验与适用范围。

## 0.1.2

Resolve Windows managed worktree paths across drive-letter casing and directory aliases.

修复 Windows 工作树路径大小写和目录别名兼容问题。
