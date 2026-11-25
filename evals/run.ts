// Repeatable evaluation for ARISA's model + prompt.
//
//   bun run eval                         # uses OLLAMA_MODEL / OLLAMA_URL from .env
//   bun run eval --model qwen3:4b        # compare another model on the same cases
//   bun run eval --only kiswahili        # one category (or a case id)
//
// Each run sends every case through the same system prompt, message layout and
// generation options as the server (see llm.ts), scores the automatic checks,
// and writes the full record (prompt, options, output, timings) to
// evals/results/<timestamp>-<model>.json.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildMessages, loadLlmConfig, ollamaChatBody, type Attachment, type HistoryTurn } from "../llm";
import { runCheck, stripThinking, type Check, type CheckResult } from "./checks";

interface EvalCase {
  id: string;
  category: string;
  prompt: string;
  history?: HistoryTurn[];
  attachments?: Attachment[];
  checks: Check[];
  review?: string;
}

interface CaseResult {
  id: string;
  category: string;
  pass: boolean;
  error?: string;
  checks: CheckResult[];
  review?: string;
  latencyMs: number;
  promptTokens?: number;
  outputTokens?: number;
  tokensPerSecond?: number;
  doneReason?: string;
  output: string;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const config = loadLlmConfig();
if (arg("model")) config.model = arg("model")!;
if (arg("url")) config.url = arg("url")!.replace(/\/+$/, "");
const only = arg("only");

const allCases = (await Bun.file(join(import.meta.dir, "cases.json")).json()) as EvalCase[];
const cases = only ? allCases.filter((c) => c.id === only || c.category === only) : allCases;
if (cases.length === 0) {
  console.error(`No cases match "${only}".`);
  process.exit(1);
}

console.log(`Evaluating ${config.model} at ${config.url} on ${cases.length} cases (num_ctx ${config.numCtx}, num_predict ${config.numPredict}${config.think !== undefined ? `, think ${config.think}` : ""})\n`);

const results: CaseResult[] = [];

for (const c of cases) {
  const built = buildMessages({
    history: c.history ?? [],
    attachments: c.attachments ?? [],
    message: c.prompt,
    numCtx: config.numCtx,
    numPredict: config.numPredict,
  });
  if (!built.ok) {
    results.push({ id: c.id, category: c.category, pass: false, error: "prompt too large", checks: [], latencyMs: 0, output: "" });
    continue;
  }

  const started = performance.now();
  let output = "";
  let error: string | undefined;
  let final: Record<string, unknown> = {};
  try {
    const res = await fetch(`${config.url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ollamaChatBody(config, built.messages, false)),
      signal: AbortSignal.timeout(config.totalTimeoutMs),
    });
    final = (await res.json()) as Record<string, unknown>;
    if (!res.ok || final.error) throw new Error(String(final.error ?? `HTTP ${res.status}`));
    output = String((final.message as { content?: string } | undefined)?.content ?? "");
  } catch (err) {
    error = (err as Error).message;
  }
  const latencyMs = Math.round(performance.now() - started);

  const checks = error ? [] : c.checks.map((check) => runCheck(check, output));
  const pass = !error && checks.every((r) => r.pass);
  const evalCount = final.eval_count as number | undefined;
  const evalDuration = final.eval_duration as number | undefined;

  results.push({
    id: c.id,
    category: c.category,
    pass,
    error,
    checks,
    review: c.review,
    latencyMs,
    promptTokens: final.prompt_eval_count as number | undefined,
    outputTokens: evalCount,
    tokensPerSecond: evalCount && evalDuration ? Math.round((evalCount / (evalDuration / 1e9)) * 10) / 10 : undefined,
    doneReason: final.done_reason as string | undefined,
    output: stripThinking(output),
  });

  const r = results[results.length - 1]!;
  const status = error ? "ERROR" : pass ? "pass " : "FAIL ";
  const failing = r.checks.filter((x) => !x.pass).map((x) => `${x.check}: ${x.detail}`).join("; ");
  console.log(`${status} ${c.id.padEnd(26)} ${String(latencyMs).padStart(6)} ms  ${error ?? failing}${c.review ? "  [needs review]" : ""}`);
}

// Summary
const passed = results.filter((r) => r.pass).length;
const errors = results.filter((r) => r.error).length;
const latencies = results.filter((r) => !r.error).map((r) => r.latencyMs).sort((a, b) => a - b);
const pct = (p: number) => latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))]! : 0;

const byCategory: Record<string, { passed: number; total: number }> = {};
for (const r of results) {
  const entry = (byCategory[r.category] ??= { passed: 0, total: 0 });
  entry.total++;
  if (r.pass) entry.passed++;
}

console.log(`\n${passed}/${results.length} passed automatic checks, ${errors} errors. Latency p50 ${pct(0.5)} ms, p90 ${pct(0.9)} ms.`);
for (const [cat, s] of Object.entries(byCategory)) console.log(`  ${cat.padEnd(22)} ${s.passed}/${s.total}`);
const toReview = results.filter((r) => r.review && !r.error);
if (toReview.length) console.log(`\n${toReview.length} cases also need a human to read the output (see "review" in the results file).`);

const outDir = join(import.meta.dir, "results");
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outFile = join(outDir, `${stamp}-${config.model.replace(/[^\w.-]+/g, "_")}.json`);
await Bun.write(
  outFile,
  JSON.stringify(
    {
      ranAt: new Date().toISOString(),
      model: config.model,
      options: { numCtx: config.numCtx, numPredict: config.numPredict, temperature: config.temperature, think: config.think },
      summary: { passed, total: results.length, errors, latencyP50Ms: pct(0.5), latencyP90Ms: pct(0.9), byCategory },
      results,
    },
    null,
    2
  )
);
console.log(`\nFull results: ${outFile}`);
process.exit(errors > 0 ? 2 : 0);
