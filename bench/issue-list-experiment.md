# Issue list experiment · Issue 列表实验

The experiment compares a full GitHub REST JSON tool response against GitKit's compact list on an identical synthetic fixture.
Five open issues contain diagnostic bodies, labels and metadata. The task requests only numbers and titles.
Both arms use GPT-6.1-Sol with low reasoning. Each arm ran three times, making one tool call per trial.
All six answers passed exact number/title checks.

Mean total tokens were 44,239 for raw REST and 41,112 for GitKit, down 7.07%.
Mean end-to-end time was 22.7894 s and 22.5548 s, down 1.03%.
The improvement in wall time is small and should not be treated as reliable acceleration.
GitKit was faster in one of three matched pairs.

The full response was 19,179 UTF-8 bytes, while GitKit structured output was 718 bytes, a 96.26% reduction.
This compares one JSON representation in each arm. It excludes the MCP envelope and text fallback duplication.
Bytes are not token counts. Model usage is measured separately through Codex usage events.
This benefit comes from field projection, which a raw API client using its own projection could also implement.

This is a synthetic API experiment, not a live-platform latency measurement.
An independent live GitHub smoke test created, viewed, commented, edited and closed verification issue #3 in this project.
Gitee routes and write behavior are covered by simulation tests.
An initial harness pilot failed due to a Windows Node import-path error and wrong-server selection. It is excluded from the formal run.

## 中文

五条合成 Issue 使用相同 API 数据。用户只要求编号和标题，原始 REST 工具返回完整 JSON，GitKit 返回精简列表。
两边各三次，六次输出全部校验通过。每次都只调用一次工具。
总 token 平均少 7.07%，耗时平均少 1.03%，时间优势尚不显著。
结构化结果从 19,179 字节降到 718 字节，少 96.26%。这是单个 JSON 表示的比较，不含 MCP 外层与文本兼容副本，也不能当作 token 节省比例。
字段裁剪的收益也可由其他 API 客户端实现，不是 GitKit 独有能力。
真实 GitHub 冒烟验证了创建、读取、评论、编辑和关闭，验证 Issue 已关闭。Gitee 使用模拟 API 测试。

## Reproduction

Build the project, set GITKIT_BENCH_TASKS=issues, GITKIT_BENCH_REPEATS=3,
GITKIT_BENCH_PARALLEL_PAIRS=1 and GITKIT_BENCH_HTTP=1, then run bench/compare.mjs.
Set GITKIT_BENCH_CODEX to the installed Codex entry point.
The fixture preloader only affects the benchmark MCP process and blocks non-fixture requests.
The native control returns the complete API JSON; both groups receive the same five source records.
Use bench/public-results.mjs to sanitize result files before publication.
