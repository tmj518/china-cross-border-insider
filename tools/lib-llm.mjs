/**
 * The language-model client the cloud pipeline calls through.
 *
 *   import { ask, askJson, available, summary } from "./lib-llm.mjs";
 *   const r = await ask({ role: "executor", messages: [...] });
 *
 * ## Why a shared module and not calls scattered through the orchestrator
 *
 * Three separate things read and write through here: the planner, the writer, and the reviewers. They
 * need the same retry behaviour, the same token accounting, and the same answer to "which provider is
 * this", and the one thing they must not do is disagree about whether a call succeeded. A pipeline
 * whose writer and reviewer use different notions of failure cannot decide anything.
 *
 * ## Token accounting, because the cost question has been open for two rounds
 *
 * Every call appends one line to `logs/usage.jsonl` with the provider, the role, the model, and the
 * token counts the API returned. The operator asked twice what a month costs and neither time could be
 * answered, because the generation ran through a chat session with no meter. This is the meter. It
 * writes even when the call fails, since a failed call still spends input tokens.
 *
 * ## Roles and providers
 *
 *   planner    the directive that decides what today's article is about
 *   writer     the one that fetches, reads and drafts
 *   reviewer   a second opinion; deliberately a DIFFERENT provider when one is available, because a
 *              model reviewing its own output shares its blind spots and the review becomes ceremony
 *
 * DeepSeek is the default for everything on cost grounds. OpenAI is used only where a different model
 * is the point. If only one key is present the pipeline still runs and says so in its report rather
 * than pretending the review was independent.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";

const ROOT = process.cwd();

const PROVIDERS = {
  deepseek: {
    env: "DEEPSEEK_API_KEY",
    url: "https://api.deepseek.com/chat/completions",
    model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
    /* DeepSeek prices per million tokens in USD. Recorded from its published rate at the time of
       writing so the log carries an estimate; the authoritative number is the invoice. */
    inPerM: 0.27,
    outPerM: 1.1,
  },
  openai: {
    env: "OPENAI_API_KEY",
    url: "https://api.openai.com/v1/chat/completions",
    model: process.env.OPENAI_MODEL || "gpt-4o",
    inPerM: 2.5,
    outPerM: 10,
  },
};

/** Which providers have a key in this environment. */
export function available() {
  return Object.entries(PROVIDERS)
    .filter(([, p]) => (process.env[p.env] ?? "").trim().length > 0)
    .map(([name]) => name);
}

export function summary() {
  const have = available();
  const lines = Object.entries(PROVIDERS).map(([name, p]) => {
    const set = (process.env[p.env] ?? "").trim().length > 0;
    return `    ${name.padEnd(9)} ${p.env.padEnd(18)} ${set ? "set" : "MISSING"}   model ${p.model}`;
  });
  return `  providers (${have.length} of 2 usable):\n${lines.join("\n")}`;
}

/*
 * Role to provider preference. The reviewer prefers the provider the writer did not use, which is the
 * only arrangement in which a second review is worth paying for.
 */
function pickProvider(role, avoid) {
  const have = available();
  if (!have.length) return null;
  if (role === "reviewer" && avoid) {
    const other = have.find((p) => p !== avoid);
    if (other) return other;
  }
  /* Cost order: DeepSeek first everywhere else. */
  return have.includes("deepseek") ? "deepseek" : have[0];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function meter(entry) {
  try {
    const p = join(ROOT, "logs", "usage.jsonl");
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    /* A meter that cannot be written must not fail the call it was measuring. */
  }
}

/**
 * One completion. Returns { ok, text, provider, model, usage, ms, error }.
 *
 * It does not throw on an API error. Every caller in this pipeline has to decide what to do about a
 * failure - retry, fall back, or write an alert - and an exception here would move that decision into
 * a catch block at each call site, where it would be made differently each time.
 */
export async function ask({ role = "writer", messages, system, temperature = 0.2, maxTokens = 8192, avoidProvider = null, retries = 2 }) {
  const providerName = pickProvider(role, avoidProvider);
  if (!providerName) {
    meter({ at: new Date().toISOString(), role, ok: false, error: "no provider key present", providers: available() });
    return { ok: false, error: "no provider key present", need: Object.values(PROVIDERS).map((p) => p.env) };
  }
  const p = PROVIDERS[providerName];
  const key = (process.env[p.env] ?? "").trim();
  const body = {
    model: p.model,
    messages: system ? [{ role: "system", content: system }, ...messages] : messages,
    temperature,
    max_tokens: maxTokens,
  };

  let lastError = "";
  for (let attempt = 0; attempt <= retries; attempt++) {
    const started = Date.now();
    try {
      const r = await fetch(p.url, {
        method: "POST",
        signal: AbortSignal.timeout(300000),
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
      });
      const text = await r.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* An HTML error page from a proxy is a real outcome and is reported as one below. */
      }
      const ms = Date.now() - started;
      if (!r.ok || json?.error) {
        lastError = json?.error?.message ?? `HTTP ${r.status}: ${text.slice(0, 200)}`;
        meter({ at: new Date().toISOString(), role, provider: providerName, model: p.model, ok: false, ms, status: r.status, error: lastError, attempt });
        /* 429 and 5xx are worth another attempt; 401 and 400 are not. */
        if (r.status === 401 || r.status === 400 || r.status === 402 || r.status === 403) break;
        await sleep(2000 * (attempt + 1));
        continue;
      }
      const usage = json?.usage ?? {};
      const cost =
        ((usage.prompt_tokens ?? 0) / 1e6) * p.inPerM + ((usage.completion_tokens ?? 0) / 1e6) * p.outPerM;
      meter({
        at: new Date().toISOString(),
        role,
        provider: providerName,
        model: p.model,
        ok: true,
        ms,
        promptTokens: usage.prompt_tokens ?? 0,
        completionTokens: usage.completion_tokens ?? 0,
        estimatedUsd: Number(cost.toFixed(6)),
        attempt,
      });
      return {
        ok: true,
        text: json?.choices?.[0]?.message?.content ?? "",
        provider: providerName,
        model: p.model,
        usage,
        estimatedUsd: Number(cost.toFixed(6)),
        ms,
      };
    } catch (e) {
      const ms = Date.now() - started;
      lastError = `${e.cause?.code ?? e.name ?? "error"}: ${e.message}`;
      meter({ at: new Date().toISOString(), role, provider: providerName, model: p.model, ok: false, ms, error: lastError, attempt });
      await sleep(2000 * (attempt + 1));
    }
  }
  return { ok: false, provider: providerName, error: lastError };
}

/**
 * A completion whose answer has to be JSON.
 *
 * Models wrap JSON in prose and code fences regardless of instruction, so the extraction is tolerant
 * and the failure is explicit. Returning `null` with the raw text attached lets the caller write an
 * alert containing what the model actually said, which is the only useful thing to do with a parse
 * failure at three in the morning.
 */
export async function askJson(opts) {
  const r = await ask({ ...opts, temperature: opts.temperature ?? 0 });
  if (!r.ok) return { ...r, json: null };
  const raw = r.text ?? "";
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw)?.[1];
  const candidate = fenced ?? raw.slice(raw.indexOf("{") >= 0 ? raw.indexOf("{") : 0, raw.lastIndexOf("}") + 1 || undefined);
  try {
    return { ...r, json: JSON.parse(candidate) };
  } catch {
    return { ...r, json: null, parseError: "response was not JSON", raw: raw.slice(0, 2000) };
  }
}

/** Running total from the meter, for the daily report. */
export function usageToday() {
  const p = join(ROOT, "logs", "usage.jsonl");
  try {
    const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
    const today = new Date().toISOString().slice(0, 10);
    let calls = 0;
    let failed = 0;
    let usd = 0;
    let pt = 0;
    let ct = 0;
    for (const l of lines) {
      const e = JSON.parse(l);
      if (!(e.at ?? "").startsWith(today)) continue;
      calls++;
      if (!e.ok) failed++;
      usd += e.estimatedUsd ?? 0;
      pt += e.promptTokens ?? 0;
      ct += e.completionTokens ?? 0;
    }
    return { calls, failed, usd: Number(usd.toFixed(4)), promptTokens: pt, completionTokens: ct };
  } catch {
    return { calls: 0, failed: 0, usd: 0, promptTokens: 0, completionTokens: 0 };
  }
}
