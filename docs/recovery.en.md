# Troubleshooting and recovery

[简体中文](recovery.md)

Use `gitkit doctor --json` to check the repository. CLI and MCP responses share the same error codes.

- `timeout` or `cancelled`: inspect status before retrying. Use `--timeout-ms` for slower Git or LFS operations.
- `credentials_required`: check the HTTPS helper or SSH agent. PR API credentials are configured separately.
- `unsafe_repository`: verify ownership before explicitly configuring Git's `safe.directory`.
- `index_lock`: wait for active writers. After verifying they have stopped, run `doctor unlock --yes` for eligible stale locks.
- `signing_failed` or `hook_failed`: fix the configuration and retry. Bypasses require explicit approval.
- `conflict`: use the reported files. Stage resolved paths and run `integrate continue`, or use `integrate abort --yes`.
- `secret_detected`: remove secrets from the working file and index before restaging.
- `platform_limit`, `lfs_missing`, or `lfs_remote`: check LFS availability, rules and repository quotas.
- `non_fast_forward`: fetch and inspect the remote history.
- `pr_api`: check API access and the target branch. If the push succeeded, retry the command after addressing the API error.

Restore a backup ref with `gitkit branch create recovered --start <backup-ref>`. Restore saved worktree changes from the returned stash.
