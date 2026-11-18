# Commit response experiment

Baseline is GitKit 0.1.2. The candidate changes only the commit result and its tool description.
The same commit task, GPT-6.1-Sol model, low reasoning setting and nine-tool catalog were used in both arms.
Each pair ran on separate equivalent repositories using the existing benchmark validator.

The baseline made four calls per successful task. The candidate made one.
The candidate returns the subject read from the stored commit, including changes made by commit hooks.
A regression test verifies that a hook-rewritten subject is returned correctly.

Across two completed matched pairs, mean end-to-end time fell from 36.7253 s to 26.1440 s (28.81%).
Mean total tokens fell from 110,701.5 to 61,418.5 (44.52%).
Mean uncached input fell from 32,127.5 to 24,135.5 (24.88%).
All four completed runs passed actual repository checks. The third pair failed in both arms because the model account reached its usage limit.
Failed attempts have no complete token counters and are retained with error_code=model_usage_limit.
They are excluded from completed-pair averages.

This small experiment measures this commit task. Other operations and remote PR requests were not retested.
The baseline model also chose status and diff before committing, so the reduced calls reflect both removed verification and changed model planning.
Working tree content is fixed and synthetic. The task explicitly authorizes committing it.
All 15 automated tests passed.

Reproduce with the existing runner by setting GITKIT_BENCH_REFERENCE_CLI to a separate 0.1.2 CLI,
GITKIT_BENCH_TASKS=commit, GITKIT_BENCH_REPEATS=3, GITKIT_BENCH_PARALLEL_PAIRS=1,
GITKIT_BENCH_HTTP=1 and the installed Codex entry in GITKIT_BENCH_CODEX.
Run node bench/compare.mjs with an output filename.
Publication data omits machine paths, raw diagnostics, tool arguments and model account messages.

The approach follows these public implementation discussions.

- [Anthropic code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp)
- [Anthropic advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use)
- [MCP structured versus text content discussion](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1624)

Tool search and programmatic composition depend on host support. This experiment implements a more complete result for one operation.
The text fallback and structured MCP result are retained for client compatibility.
