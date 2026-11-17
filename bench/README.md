# GitKit 对照实验

[English](README.en.md)

实验比较同一 Codex 模型调用 GitKit MCP 和批量原生 Git MCP 的用量与延迟。四类任务各重复两次。每组使用独立临时仓库，拉取和推送使用本地裸仓库。校验既检查模型输出，也检查索引、提交、远端引用或 upstream 等实际状态。

Windows 上可在已登录 Codex 的环境中复跑。

```powershell
npm run build
$env:GITKIT_BENCH_CODEX = Join-Path (Split-Path -Parent (Get-Command codex).Source) 'node_modules/@openai/codex/bin/codex.js'
$env:GITKIT_BENCH_HTTP = '1'
$env:GITKIT_BENCH_PARALLEL_PAIRS = '2'
node bench/compare.mjs bench/reproduction.json
```

计时从 Codex 子进程启动到 `turn.completed`。总 token 取用量事件中的输入与输出之和，包含缓存命中的输入 token。未缓存输入单独计算。以双方均验证通过的配对比较时间和 token，所有尝试均保留在原始记录。

正式运行记录在 [codex-gitkit-results.json](codex-gitkit-results.json)。原生命令对照组接受开头可选的 `git` 和常见全局选项。首次推送时，短 upstream 名和完整远端跟踪引用按同一结果校验。

公开数据保留逐次耗时、token、调用与校验结果。运行参数和诊断输出在发布前清洗掉。用 `node bench/public-results.mjs <结果文件>` 清洗新生成的记录，用 `python bench/render.py --cjk-font <中文字体文件>` 生成双语图表。

## GitKit 0.1.0 和 0.1.1 配对复测

[gitkit-pull-push-optimization.json](gitkit-pull-push-optimization.json) 比较优化前后的拉取和首次推送。模型、题目、输出校验和已启用工具保持相同。令 `GITKIT_BENCH_REFERENCE_CLI` 指向独立安装的 0.1.0 版 `dist/cli.js`，设置 `GITKIT_BENCH_TASKS=pull,push`，再运行同一脚本。输出中的 `reference` 为旧版，`gitkit` 为本工作区编译结果。

[gitkit-0.1.1-vs-native.json](gitkit-0.1.1-vs-native.json) 是新版与批量原生 Git 的另一场配对。保持同样的任务筛选，清除 `GITKIT_BENCH_REFERENCE_CLI`，脚本即可使用原生命令作为对照。

## 0.1.1 全量复测

[gitkit-0.1.1-full-rerun.json](gitkit-0.1.1-full-rerun.json) 独立记录查看状态、提交、拉取和首次推送四类任务。每类三组配对。复跑时使用上面的环境设置，清除 `GITKIT_BENCH_TASKS` 和 `GITKIT_BENCH_REFERENCE_CLI`，并将 `GITKIT_BENCH_REPEATS` 设为 `3`。
