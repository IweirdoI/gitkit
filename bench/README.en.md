# Benchmarks

[简体中文](README.md)

GitKit 0.1.1 and a batch-capable native Git command tool ran through the same Codex model over stdio MCP. The latest run used GPT-6.1-Sol and 12 matched pairs across status, commit, fast-forward pull and first push. The fixtures were independent temporary repositories. Pull and push used local bare remotes. Actual Git refs, files and operation results were verified after each run.

- Wall time starts at Codex process launch and ends at `turn.completed`.
- Total token usage is input plus output, including cached input. Uncached input is reported separately.
- GitHub and Gitee PR API time is outside this benchmark.

See the [sanitized runs](gitkit-0.1.1-full-rerun.json). Per-run command arguments and raw diagnostics were removed for publication. The [runner](compare.mjs) and [native Git control](git-commands.mjs) reproduce the experiment.

Build the package, set `GITKIT_BENCH_CODEX` to the installed Codex CLI entry script, then run `node bench/compare.mjs bench/reproduction.json`. Set `GITKIT_BENCH_REPEATS=3`, `GITKIT_BENCH_PARALLEL_PAIRS=2`, and `GITKIT_BENCH_HTTP=1` to match the full run. Use `node bench/public-results.mjs <results-file>` before sharing newly generated results. Charts are generated with Matplotlib using [render.py](render.py).
