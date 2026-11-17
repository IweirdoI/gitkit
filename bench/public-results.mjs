// Publish measurements and outcome codes without host paths, tool arguments, or logs.
import { readFile, writeFile } from 'node:fs/promises';

for (const path of process.argv.slice(2)) {
  const { model, reasoning, transport, versions, referenceArm, scenarios, repeats, parallelPairs, results } =
    JSON.parse(await readFile(path, 'utf8'));
  const publicResults = results.map(entry => ({
    scenario: entry.scenario,
    repeat: entry.repeat,
    arm: entry.arm,
    success: entry.success,
    usage: entry.usage,
    endToEndMs: entry.endToEndMs,
    turnMs: entry.turnMs,
    calls: entry.calls.map(({ type, server, tool, elapsedMs, status }) => ({ type, server, tool, elapsedMs, status })),
  }));
  await writeFile(path, JSON.stringify({
    model, reasoning, transport, versions, referenceArm, scenarios, repeats, parallelPairs, results: publicResults,
  }, null, 2) + '\n');
}
