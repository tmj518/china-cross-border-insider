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
 * Doubao writes and DeepSeek reviews: two vendors, which is the strongest independence available
 * because they share neither training data nor failure modes. If only one credential is present the
 * pipeline still runs and says so in its report rather than pretending the review was independent.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";

const ROOT = process.cwd();

/*
 * Providers, and the keys that can serve each one.
 *
 * Two shapes are supported and the operator uses both.
 *
 *   Vendor separation. Doubao (Volcano Ark) writes and DeepSeek reviews. This is the stronger form of
 *   independence: two vendors do not share training data, alignment choices or failure modes, so a
 *   blind spot in one is unlikely to be repeated in the other.
 *
 *   Credential separation. Two keys from one vendor, one per role. Weaker on reasoning, stronger on
 *   operations - separate quota, separate rate limit, separate revocation, and an audit trail that can
 *   attribute a spend to a key.
 *
 * A provider therefore carries candidate credentials per role in preference order, and the role
 * decides which one it gets. Getting this wrong is quiet rather than loud: a reviewer handed the
 * writer's own credential reports itself as independent and is not.
 */
const PROVIDERS = {
  /*
   * Volcano Ark, the Doubao endpoint.
   *
   * Two things differ from the OpenAI-shaped APIs and both cause a 400 rather than a clear message.
   * The base URL is Ark's, not OpenAI's. And the `model` field takes an ENDPOINT ID - `ep-...` - which
   * is created in the Ark console from a model and carries the deployment's settings. Passing
   * "doubao-pro-32k" produces "the model does not exist", because on Ark the model name is not
   * addressable; the endpoint is.
   */
  volces: {
    url: process.env.ARK_BASE_URL ? `${process.env.ARK_BASE_URL.replace(/\/$/, "")}/chat/completions` : "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
    /*
     * No default, and deliberately no fallback to any key variable: an endpoint id is `ep-...` and a
     * key is `sk-...` or `ark-...`. An earlier version fell back to a key name here, which would have
     * sent an API key in the model field - a silent misconfiguration that returns a 400 and looks like
     * a bad key. The preflight reports a missing endpoint id as itself.
     */
    model: process.env.ARK_MODEL || process.env.DOUBAO_ENDPOINT || "",
    /* Ark bills in CNY. These are the published Doubao Pro rates converted at 7.1 CNY/USD so the meter
       stays in one currency; the invoice is authoritative. */
    inPerM: 0.11,
    outPerM: 0.28,
    keys: {
      writer: ["ARK_API_KEY", "DOUBAO_API_KEY", "VOLCES_API_KEY", "OWNER_KEY_1"],
      reviewer: ["ARK_REVIEW_API_KEY", "ARK_API_KEY", "DOUBAO_API_KEY", "OWNER_KEY_1"],
      planner: ["ARK_API_KEY", "DOUBAO_API_KEY", "OWNER_KEY_1"],
    },
    /* Set when the model field is required to be an endpoint id, so the failure can be explained. */
    needsEndpointId: true,
  },
  deepseek: {
    url: "https://api.deepseek.com/chat/completions",
    model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
    /* DeepSeek prices per million tokens in USD, recorded from its published rate so the log carries
       an estimate. The invoice is authoritative. */
    inPerM: 0.27,
    outPerM: 1.1,
    /*
     * Order matters: a dedicated review key for the reviewer, a dedicated write key for the writer.
     * OWNER_KEY_1 and OWNER_KEY_2 are the operator's existing secrets, read so a credential stored
     * under a generated name still reaches the pipeline.
     *
     * OWNER_KEY_1 is deliberately absent here. In this deployment it holds the Volcano Ark
     * credential, so offering it to the DeepSeek reviewer would send an Ark key to api.deepseek.com,
     * which answers 401 and reads as a broken DeepSeek key. OWNER_KEY_2 is the DeepSeek credential and
     * serves both roles, which is safe because it is one vendor and one account.
     */
    keys: {
      writer: ["DEEPSEEK_WRITE_API_KEY", "DEEPSEEK_API_KEY", "DEEPSEEK_REVIEW_API_KEY", "OWNER_KEY_2"],
      reviewer: ["DEEPSEEK_REVIEW_API_KEY", "DEEPSEEK_API_KEY", "OWNER_KEY_2", "DEEPSEEK_WRITE_API_KEY"],
      planner: ["DEEPSEEK_PLAN_API_KEY", "DEEPSEEK_API_KEY", "DEEPSEEK_WRITE_API_KEY", "OWNER_KEY_2"],
    },
  },
};

/** Environment variable names that hold a usable key for a role, in preference order. */
function keyNamesFor(providerName, role) {
  return PROVIDERS[providerName]?.keys?.[role] ?? PROVIDERS[providerName]?.keys?.writer ?? [];
}

/** The first set variable among a provider's candidates for a role, with its name. */
function resolveKey(providerName, role, exclude = []) {
  for (const name of keyNamesFor(providerName, role)) {
    const v = (process.env[name] ?? "").trim();
    if (v && !exclude.includes(name)) return { name, value: v };
  }
  return null;
}

/** Which providers have at least one usable key. */
export function available() {
  return Object.keys(PROVIDERS).filter((name) => keyNamesFor(name, "writer").some((n) => (process.env[n] ?? "").trim()));
}

/**
 * Whether two roles would use the same credential, which is the condition that makes a second review
 * ceremonial rather than independent.
 */
export function reviewIsIndependent() {
  /*
   * Independence means the reviewer gets a credential, a vendor, or both, that the writer did not.
   * Asked of the resolver rather than assumed from configuration, because the whole point is that a
   * misconfiguration here is silent: a reviewer holding the writer's own key reports itself as
   * independent and is not.
   */
  const writer = providerFor("writer");
  const reviewer = providerFor("reviewer", writer);
  if (!writer || !reviewer) return false;
  if (writer !== reviewer) return true;
  const wKey = resolveKey(writer, "writer");
  const rKey = resolveKey(reviewer, "reviewer", wKey ? [wKey.name] : []);
  return Boolean(rKey);
}

export function summary() {
  const lines = [];
  for (const name of Object.keys(PROVIDERS)) {
    const p = PROVIDERS[name];
    const w = resolveKey(name, "writer");
    const r = resolveKey(name, "reviewer");
    const model = p.needsEndpointId ? (p.model || "NO ENDPOINT ID SET") : p.model;
    lines.push(
      "    " +
        name.padEnd(9) +
        " writer=" + (w?.name ?? "MISSING").padEnd(24) +
        " reviewer=" + (r?.name ?? "MISSING").padEnd(26) +
        " " + model,
    );
  }
  const wProv = providerFor("writer");
  const rProv = providerFor("reviewer", wProv);
  const indep = reviewIsIndependent();
  const cross = wProv && rProv ? `${wProv} writes, ${rProv} reviews` : "no complete role assignment";
  return (
    "  providers usable: " + (available().join(", ") || "none") + "\n" +
    lines.join("\n") +
    "\n    roles: " + cross +
    "\n    review independent: " + (indep ? "yes" : "NO - the reviewer would use the writer's own credential")
  );
}

/*
 * Role to provider preference.
 *
 * The operator's arrangement is that Doubao writes and DeepSeek reviews, which is vendor separation and
 * the strongest independence available: two vendors do not share training data, alignment choices or
 * failure modes, so a blind spot in one is unlikely to repeat in the other.
 *
 * The order encodes that, with a fallback per role so a missing key downgrades rather than halts - and
 * the downgrade is announced in the summary rather than left to be discovered.
 *
 * The reviewer is additionally kept away from whatever provider the writer actually used, compared by
 * provider name rather than assumed, so the arrangement survives a configuration change.
 */
const ROLE_PREFERENCE = {
  writer: ["volces", "deepseek"],
  planner: ["volces", "deepseek"],
  reviewer: ["deepseek", "volces"],
};

export function providerFor(role, avoid) {
  const have = available();
  if (!have.length) return null;
  const order = ROLE_PREFERENCE[role] ?? ROLE_PREFERENCE.writer;
  const usable = (name) =>
    have.includes(name) &&
    Boolean(resolveKey(name, role)) &&
    /* A provider that needs an endpoint id and has none cannot be called, so it is not chosen. */
    !(PROVIDERS[name].needsEndpointId && !PROVIDERS[name].model);

  for (const name of order) if (name !== avoid && usable(name)) return name;
  /* Nothing matched with the exclusion applied. The exclusion is dropped before the review is,
     because a same-vendor review is worth more than none - provided it is labelled as such, which
     both the caller and the notification do. */
  for (const name of order) if (usable(name)) return name;
  return null;
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
/**
 * One model call.
 *
 * `tools` is optional and passed through untouched. Both providers here are OpenAI-compatible and both
 * support tool calling, which is what lets tools/agent-run.mjs exist without a broker process: the agent
 * loop is a plain conversation, and this is the only place that has to know how a tool call is shaped.
 *
 * The existing callers pass no tools and read only `text`, so adding the field changes nothing for them.
 */
export async function ask({ role = "writer", messages, system, temperature = 0.2, maxTokens = 8192, avoidProvider = null, retries = 2, tools = null, toolChoice = null }) {
  const providerName = providerFor(role, avoidProvider);
  if (!providerName) {
    meter({ at: new Date().toISOString(), role, ok: false, error: "no provider key present", providers: available() });
    return {
      ok: false,
      error: "no provider key present",
      need: ["ARK_API_KEY + ARK_MODEL for the writer, DEEPSEEK_REVIEW_API_KEY for the reviewer"],
    };
  }
  const p = PROVIDERS[providerName];
  const cred = resolveKey(providerName, role);
  if (!cred) {
    meter({ at: new Date().toISOString(), role, ok: false, provider: providerName, error: "no key for this role" });
    return { ok: false, error: `no key configured for role ${role} on ${providerName}`, need: keyNamesFor(providerName, role) };
  }
  const key = cred.value;
  const body = {
    model: p.model,
    messages: system ? [{ role: "system", content: system }, ...messages] : messages,
    temperature,
    max_tokens: maxTokens,
  };

  /*
   * Sent only when there is something to send. An empty tools array is rejected by some gateways, and
   * only the agent loop passes tools at all.
   */
  if (tools && tools.length) {
    body.tools = tools;
    if (toolChoice) body.tool_choice = toolChoice;
  }

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
        meter({ at: new Date().toISOString(), role, provider: providerName, keyName: cred.name, model: p.model, ok: false, ms, status: r.status, error: lastError, attempt });
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
        keyName: cred.name,
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
        /*
         * Null when the model answered in prose, which is how the agent loop knows a turn is finished.
         * The raw message is returned too so it can be appended to the conversation verbatim: an
         * assistant turn that made tool calls has to go back exactly as it came, or the provider rejects
         * the tool result that follows it.
         */
        toolCalls: json?.choices?.[0]?.message?.tool_calls ?? null,
        rawMessage: json?.choices?.[0]?.message ?? null,
        finishReason: json?.choices?.[0]?.finish_reason ?? null,
        provider: providerName,
        keyName: cred.name,
        model: p.model,
        usage,
        estimatedUsd: Number(cost.toFixed(6)),
        ms,
      };
    } catch (e) {
      const ms = Date.now() - started;
      lastError = `${e.cause?.code ?? e.name ?? "error"}: ${e.message}`;
      meter({ at: new Date().toISOString(), role, provider: providerName, keyName: cred.name, model: p.model, ok: false, ms, error: lastError, attempt });
      await sleep(2000 * (attempt + 1));
    }
  }
  return { ok: false, provider: providerName, keyName: cred.name, error: lastError };
}

/**
 * A completion whose answer has to be JSON.
 *
 * Models wrap JSON in prose and code fences regardless of instruction, so the extraction is tolerant
 * and the failure is explicit. Returning `null` with the raw text attached lets the caller write an
 * alert containing what the model actually said, which is the only useful thing to do with a parse
 * failure at three in the morning.
 */
/**
 * Pull a JSON object out of a model response.
 *
 * Asking for JSON does not reliably produce a bare JSON document, and the ways it fails need different
 * handling.
 *
 * The obvious one is a wrapper: prose before the object, or a ```json fence. The fence is tried first,
 * then a brace-matched span, which covers both.
 *
 * The one that cost a run is truncation. On 2026-10-17 the reviewer output was unparseable and the
 * pipeline reported "no parseable verdict" without saying why, so the next step was a guess. A
 * brace-matched scan that tracks string state and escapes finds a *complete* object anywhere in the
 * response, which a first-brace-to-last-brace slice does not: if the text ends mid-object, that slice is
 * a fragment and fails, whereas the scan correctly reports that nothing complete is present.
 *
 * Cut off and malformed are different failures and the caller is told which. A balanced object is worth
 * a retry with a larger budget; an unbalanced one is not.
 */
function balancedJsonSpan(s) {
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  /* Opened and never closed: the response was cut off mid-object. */
  return null;
}

export async function askJson(opts) {
  const r = await ask({ ...opts, temperature: opts.temperature ?? 0 });
  if (!r.ok) return { ...r, json: null };
  const raw = r.text ?? "";

  const candidates = [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw)?.[1];
  if (fenced) candidates.push(fenced);
  const balanced = balancedJsonSpan(raw);
  if (balanced) candidates.push(balanced);
  /* Last resort: the original slice, for the rare case where a brace inside a string confuses the scan. */
  const first = raw.indexOf("{");
  if (first >= 0 && raw.lastIndexOf("}") > first) candidates.push(raw.slice(first, raw.lastIndexOf("}") + 1));

  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c);
      if (parsed && typeof parsed === "object") return { ...r, json: parsed };
    } catch {
      /* try the next shape */
    }
  }

  /*
   * No parseable object. Say which failure it was, and quote the response, because "the model wrote
   * prose" and "the model was cut off" call for opposite fixes - change the prompt, or raise the
   * budget - and neither is guessable from a stack trace.
   */
  const opened = raw.includes("{");
  const closed = raw.includes("}");
  const hitCeiling = r.usage?.completion_tokens != null && opts.maxTokens != null && r.usage.completion_tokens >= opts.maxTokens - 8;
  const parseError = !opened
    ? "the response contained no JSON object at all"
    : hitCeiling
      ? `the response ran to the ${opts.maxTokens}-token ceiling, so the object was cut off`
      : closed
        ? "the response contained a JSON object that does not parse"
        : "the response opened an object and never closed it";
  return { ...r, json: null, parseError, raw: raw.slice(0, 2000), head: raw.slice(0, 400), tail: raw.slice(-200) };
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
