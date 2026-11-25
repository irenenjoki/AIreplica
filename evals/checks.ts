// Automatic checks for evaluation cases. Each check returns pass/fail with a
// short reason. Anything that needs human judgement (tone, Kiswahili quality)
// is marked `review` in the case file instead.

export type Check =
  | { type: "contains_any"; values: string[] }
  | { type: "contains_all"; values: string[] }
  | { type: "not_contains"; values: string[] }
  | { type: "regex"; pattern: string; flags?: string }
  | { type: "not_regex"; pattern: string; flags?: string }
  | { type: "max_words"; value: number }
  | { type: "numbered_items"; count: number; wordsEach: number }
  | { type: "json"; keys?: string[] };

export interface CheckResult {
  check: Check["type"];
  pass: boolean;
  detail: string;
}

/** Remove a thinking block some models emit, so checks look at the answer only. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function words(text: string): string[] {
  return text.split(/\s+/).map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")).filter(Boolean);
}

export function runCheck(check: Check, rawOutput: string): CheckResult {
  const output = stripThinking(rawOutput);
  const lower = output.toLowerCase();

  switch (check.type) {
    case "contains_any": {
      const hit = check.values.find((v) => lower.includes(v.toLowerCase()));
      return { check: check.type, pass: Boolean(hit), detail: hit ? `found "${hit}"` : `none of ${JSON.stringify(check.values)}` };
    }
    case "contains_all": {
      const missing = check.values.filter((v) => !lower.includes(v.toLowerCase()));
      return { check: check.type, pass: missing.length === 0, detail: missing.length ? `missing ${JSON.stringify(missing)}` : "all present" };
    }
    case "not_contains": {
      const hit = check.values.find((v) => lower.includes(v.toLowerCase()));
      return { check: check.type, pass: !hit, detail: hit ? `contains forbidden "${hit}"` : "ok" };
    }
    case "regex": {
      const pass = new RegExp(check.pattern, check.flags ?? "i").test(output);
      return { check: check.type, pass, detail: pass ? "matched" : `no match for /${check.pattern}/` };
    }
    case "not_regex": {
      const pass = !new RegExp(check.pattern, check.flags ?? "i").test(output);
      return { check: check.type, pass, detail: pass ? "ok" : `matched forbidden /${check.pattern}/` };
    }
    case "max_words": {
      const n = words(output).length;
      return { check: check.type, pass: n <= check.value, detail: `${n} words (max ${check.value})` };
    }
    case "numbered_items": {
      const items = output
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => /^\d+[.)]\s+/.test(l))
        .map((l) => l.replace(/^\d+[.)]\s+/, ""));
      const counts = items.map((i) => words(i).length);
      const pass = items.length === check.count && counts.every((c) => c === check.wordsEach);
      return { check: check.type, pass, detail: `${items.length} items, word counts ${JSON.stringify(counts)}` };
    }
    case "json": {
      const cleaned = output.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
      try {
        const parsed = JSON.parse(cleaned) as Record<string, unknown>;
        const missing = (check.keys ?? []).filter((k) => !(k in parsed));
        return { check: check.type, pass: missing.length === 0, detail: missing.length ? `missing keys ${JSON.stringify(missing)}` : "valid JSON" };
      } catch {
        return { check: check.type, pass: false, detail: "not valid JSON" };
      }
    }
  }
}
