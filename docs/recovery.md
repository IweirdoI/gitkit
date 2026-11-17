# 错误分类与恢复

CLI 可用 `--json`，MCP 使用 `structuredContent`。失败信息保留 Git 输出或平台响应摘要，结构化字段提供后续动作。工具会重试短暂的 Git 锁竞争，按配置对 Git 和 GPG 设置超时，默认保留 hooks 和签名。

- `confirmation_required`。先说明本次具体操作，用户明确同意后再提交 `--yes` 或 `yes: true`。
- `timeout`、`cancelled`。子进程树被停止。检查 `status` 与 `doctor`；拉取超时时可复查当前 HEAD 和子模块。LFS 上传超时时提高预算并重复 push。
- `credentials_required`。检查 Git 凭据助手、SSH agent、known_hosts 或 PR API 令牌。Git 和 PR 凭据使用不同入口。
- `unsafe_repository`。核实所有者及权限。确认信任后由用户在可信终端运行 `git config --global --add safe.directory <绝对路径>`。
- `index_lock`。等待并重试。确认没有 Git 写入时，`doctor unlock --yes` 检查年龄超过十分钟的锁。GitKit 自有锁还会检查本机 PID。
- `signing_failed`。预先解锁签名代理或修正签名配置。用户明确同意放弃本次签名时，可运行 `commit --unsigned --yes`。
- `hook_failed`。修复钩子报出的错误再提交。明确同意后可选择 `--no-verify --yes`。
- `detached_head`、`dirty_worktree`、`operation_in_progress`、`ignored_file_collision`。建立或切换分支，保存改动或冲突路径上的忽略文件，或先完成当前整合。
- `conflict`。参照 `files` 和 `data.binary_files`。暂存解决结果后执行 `integrate continue`，或者确认后执行 `integrate abort`。
- `secret_detected`。从文件和索引移除凭据，再重新暂存。结果只提供匹配路径。
- `lfs_missing`、`lfs_remote`、`large_blob`、`platform_limit`、`attributes_dirty`、`attributes_invalid`。检查有效属性、Git LFS 安装、远端配额和权限。已提交到历史的大对象需另行迁移，事前保留分支并确认影响。
- `non_fast_forward`、`head_changed`、`pr_api`。先核实远端分支，重新运行 push 前确认状态。PR API 失败时，错误消息会标出分支推送是否已完成。
- `invalid_input`、`not_repository`、`no_commits`、`no_operation`、`unrelated_staged`、`unsupported_provider`、`worktree_changed`。使用命令的 `--help` 并按提示调整输入或仓库状态。
- `output_limit`、`missing_object`、`spawn_failed`、`git_failed`、`internal_error`。检查详细输出、Git 安装和仓库完整性。差异输出可指定较小路径范围。

## 恢复文件

自动属性备份存放在 Git 元数据下的 `gitkit-backups/<id>`，结果返回路径。需要恢复时，先比较当前版本与备份，保留其后发生的编辑，再选择恢复根属性、索引、配置或钩子。备份中缺少的文件在修改前可能尚不存在。旧 HEAD 的备份引用可用 `git show <ref>` 检查，再创建恢复分支。

## 冒烟清单

- `npm test` 在临时真实仓库执行空索引、首次提交、detached HEAD、中文路径、密钥阻断、stdin EOF、钩子错误和进程树超时、LFS 指针、锁竞争、拉取冲突、工作区回滚和 CLI/MCP 协议对照。
- `npm pack` 后安装 tarball 并检查 `gitkit --help`。用同一包启动 MCP 并检查工具名称、schema 和返回。
- 用 GitHub 与 Gitee 测试仓库分别推送新分支，检查 upstream，创建 PR，再改标题验证更新。验证令牌不足和分支保护分别产生预期结果。
- 在启用签名的测试仓库验证锁定代理、解锁后提交，以及明确同意后的 `--unsigned`。在不同账户运行以检查 safe.directory 提示。
- 对有配额限制的 LFS 测试仓库验证大对象、本地预检、服务端拒绝和慢网络重试。对二进制冲突验证文件清单和人工选择。
