# Optimization target experiment

Candidate is 0.1.2 plus the local actual-commit-subject response and its tool description.
Control is the existing batch-capable native Git MCP tool. Both use GPT-6.1-Sol, low reasoning and the same output validation.
Four tasks were repeated three times, with fresh equivalent repository fixtures.
All 24 runs passed actual repository state and reported-answer checks.
Measurements were captured before any benchmark-driven changes in this run.

The goal was 60% less total token usage and 50% less end-to-end time.
Neither aggregate threshold was reached.

- Mean time: 22.57598 s native, 18.95911 s GitKit, a 16.02% reduction.
- Mean total tokens: 92,796.92 native, 59,960.83 GitKit, a 35.38% reduction.
- Mean uncached input: 25,633 native, 22,605.58 GitKit, an 11.81% reduction.
- GitKit used one call for every task. Native averaged 2.33 calls.
- GitKit was faster in 9 of 12 pairs and used fewer total tokens in 11 of 12 pairs.
- Commit alone reduced total tokens 55.92% and wall time 37.86%.
- Status wall time increased 6.90%, with both arms making one call.

Current results do not support a general 60% token or 50% time claim.
Pull and push use local bare remotes, and end-to-end time includes model and host startup.
The native group chose two calls for one commit trial, versus five and six calls in the others.
Keeping that efficient control trial reduces the estimated benefit and is part of the reported result.

The earlier two-pair commit comparison used the old GitKit as control.
It is a separate experiment and its percentages must not be added to these measurements.
Total tokens include cached input, whose varying hit rate affects comparisons.

## Further directions

Anthropic recommends fewer tool round trips, meaningful tool results, scoped tool discovery and concise responses.
The actual commit subject change follows the meaningful-result approach.
All current GitKit task trials now complete in one call, so reducing another round trip is unavailable for those trials.
The 17-tool full catalog is 23,367 UTF-8 bytes, including 6,137 bytes of repeated output schemas.
Byte counts are protocol measurements and do not establish token or wall-time savings.
Host-level selective loading and longer authorized workflows are candidates for separate future experiments.
Response serialization changes must preserve MCP fallback behavior and structured output compatibility.

- [Writing effective tools](https://www.anthropic.com/engineering/writing-tools-for-agents)
- [Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp)
- [MCP structured/text result discussion](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1624)

## 简体中文

本轮将本地提交标题优化与批量原生 Git 对照。四类任务各三次，两组共 24 次，全部通过仓库校验。
目标是总 token 节省 60%、端到端耗时节省 50%，本轮整体均未达到。
实际整体总 token 减少 35.38%，耗时减少 16.02%，未缓存输入减少 11.81%。
提交子任务总 token 少 55.92%、耗时少 37.86%。状态查询平均慢 6.90%。
GitKit 所有任务均一次调用，原生组平均 2.33 次。必须保留原生组高效完成的样本。
上一轮以旧版 GitKit 为对照，两次实验的百分比不能相加。
后续可验证宿主按需加载和更长工作流，但需要另行实测。

Reproduce using bench/compare.mjs, GITKIT_BENCH_REPEATS=3,
GITKIT_BENCH_HTTP=1 and GITKIT_BENCH_PARALLEL_PAIRS=2.
Clear GITKIT_BENCH_REFERENCE_CLI and GITKIT_BENCH_TASKS for the native full-task control.
Published JSON is sanitized with bench/public-results.mjs.
