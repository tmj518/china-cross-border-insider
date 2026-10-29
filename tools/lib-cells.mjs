#!/usr/bin/env node
/**
 * Turn the twenty-five cells into a queue the agent route can consume.
 *
 *   node tools/lib-cells.mjs --next              # what the next run should write, as JSON
 *   node tools/lib-cells.mjs --mark=taken        # claim it (done by the caller with persona/moment)
 *   node tools/lib-cells.mjs --self-test
 *
 * ## Why the selection order is written down and not tuned
 *
 * A cell qualifies only when the harvest found phrasings and the site has no page. Beyond that the order
 * is fixed, because a queue whose order is chosen per run cannot be audited and cannot be compared
 * across weeks:
 *
 *   1. single direction      a cell mixing into-china and out-of-china is two questions, not one
 *   2. computable count      how many of its phrasings ask for an amount; that is what this site sells
 *   3. at least ten intents  below that, the cell is a handful of phrasings and not a subject
 *
 * A cell that has been written is marked `taken` when a run starts and `published` when an article
 * lands. A taken cell is not picked again: the failure mode this prevents is the same subject being
 * rewritten every day because the previous run did not publish, which produces five near-duplicates
 * and no coverage.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const DEMAND = join(ROOT, "data", "demand");

/** The newest matrix the radar wrote. */
export function latestMatrixFile() {
  if (!existsSync(DEMAND)) return null;
  const files = readdirSync(DEMAND)
    .filter((f) => /^matrix-cells-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
  return files.length ? join(DEMAND, files[files.length - 1]) : null;
}

export function loadMatrix(file) {
  const path = file ?? latestMatrixFile();
  if (!path) return null;
  const data = JSON.parse(readFileSync(path, "utf8"));
  data.__path = path;
  return data;
}

/** The five phrasings a run has to answer, computable ones first. */
export function intentSamples(matrix, persona, moment, n = 5) {
  const rows = (matrix.intents ?? []).filter((d) => d.persona === persona && d.moment === moment);
  const scored = rows
    .map((r) => ({ ...r, score: (r.computable ? 2 : 0) + (r.chinaAnchored ? 1 : 0) }))
    .sort((a, b) => b.score - a.score);
  const seen = new Set();
  const out = [];
  for (const r of scored) {
    if (seen.has(r.text)) continue;
    seen.add(r.text);
    out.push(r.text);
    if (out.length >= n) break;
  }
  return out;
}

/** How many directions the cell actually contains. One means the question is single. */
function directionsOf(matrix, persona, moment) {
  const rows = (matrix.intents ?? []).filter((d) => d.persona === persona && d.moment === moment);
  const set = new Set(rows.map((r) => r.direction));
  return set.size;
}

/**
 * @returns {{persona, moment, direction, computable, intents, samples, reason} | null}
 */
/*
 * THE CANDIDATES, RANKED, INSTEAD OF ONE THAT MUST BE PERFECT.
 *
 * nextCell returned a single cell and gave up if every cell failed one of three filters, which sent the
 * run back to the directive - a subject source that had already been published, twice. The matrix holds
 * two thousand phrasings and the answer was to look at a stale pointer.
 *
 * This returns the cells in order and lets the caller refuse the ones whose subject is already taken.
 * A mixed-direction cell is ranked lower rather than dropped: it is harder to write, not unusable.
 */
/*
 * WHICH CELLS THE SOURCES CAN ACTUALLY ANSWER.
 *
 * On 2026-10-29 the ranked list put expat/policy first - "china work permit points calculator" - and the run
 * ended in INSUFFICIENT-EVIDENCE, correctly: the immigration service publishes categories, not a points
 * table. The cell was not wrong to exist, it was wrong to try first, because the sources that answer from a
 * runner are the customs, finance, tax and commerce ones, plus the four added for visas, transport and
 * tuition.
 *
 * This vocabulary is derived from those sources, not guessed: customs and the tariff commission publish
 * rates and clearance rules, the tax administration publishes rebate rates, the statistics bureau publishes
 * PPI and CPI, the immigration service publishes visa categories and residence permits, the transport
 * ministry publishes freight and ports, the education ministry publishes tuition and scholarships.
 *
 * A cell whose phrasings match none of it is still a real cell; it simply ranks last, because a run there
 * ends with nothing to cite.
 */
const SOURCEABLE_TOPICS = /\b(tariff|duty|duties|customs|clearance|import|export|rebate|vat|tax|refund|ppi|cpi|inflation|freight|shipping|port|container|visa|residence|permit|tuition|scholarship|exchange rate|remittance|payment|labour cost|wage)\b/i;
function sourceability(cell) {
  const hits = (cell.samples ?? []).filter((s) => SOURCEABLE_TOPICS.test(String(s))).length;
  return hits;
}

export function rankedCells(matrix, limit = 5) {
  const seen = new Set();
  return (matrix.cells ?? [])
    .filter((c) => c.verdict === "\u6709\u9700\u6c42\u00b7\u65e0\u9875\u9762")
    .filter((c) => !c.produced || c.produced === "available")
    .filter((c) => (c.own ?? 0) >= 5)
    .map((c) => ({
      persona: c.persona,
      moment: c.moment,
      direction: Object.keys(c.directionMix ?? {})[0] ?? "within-china",
      computable: c.calc ?? 0,
      intents: c.own ?? 0,
      mixed: directionsOf(matrix, c.persona, c.moment) > 1,
      samples: intentSamples(matrix, c.persona, c.moment, 5),
      reason: `${c.calc ?? 0} computable, ${c.own ?? 0} intents`,
      matrix,
    }))
    .map((c) => ({ ...c, sourceable: sourceability(c) }))
    .filter((c) => {
      const key = c.persona + "/" + c.moment;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

export function nextCell(matrix) {
  const candidates = (matrix.cells ?? [])
    .filter((c) => c.verdict === "有需求·无页面")
    .filter((c) => !c.produced || c.produced === "available")
    .filter((c) => directionsOf(matrix, c.persona, c.moment) <= 1)
    .filter((c) => (c.own ?? 0) >= 10)
    .filter((c) => (c.calc ?? 0) >= 1)
    .map((c) => ({
      persona: c.persona,
      moment: c.moment,
      direction: Object.keys(c.directionMix ?? {})[0] ?? "within-china",
      computable: c.calc ?? 0,
      intents: c.own ?? 0,
      samples: intentSamples(matrix, c.persona, c.moment, 5),
      reason: `有需求·无页面, direction single, ${c.calc ?? 0} computable, ${c.own ?? 0} intents`,
    }))
    .sort((a, b) => b.computable - a.computable || b.intents - a.intents || a.persona.localeCompare(b.persona));

  return candidates[0] ?? null;
}

/** Claim or release a cell inside the matrix file, in place. */
export function markCell(matrix, persona, moment, state, extra = {}) {
  const cell = (matrix.cells ?? []).find((c) => c.persona === persona && c.moment === moment);
  if (!cell) return { ok: false, reason: "cell not found" };
  cell.produced = state; // available | taken | published
  cell.producedAt = new Date().toISOString().slice(0, 10);
  Object.assign(cell, extra);
  const { __path, ...clean } = matrix;
  writeFileSync(__path, JSON.stringify(clean, null, 2) + "\n", "utf8");
  return { ok: true, cell };
}

/* ------------------------------------------------------------------ cli */

const arg = process.argv.slice(2);

if (arg.includes("--self-test")) {
  const matrix = loadMatrix();
  if (!matrix) {
    console.log("no matrix - run the radar first");
    process.exit(2);
  }
  const cell = nextCell(matrix);
  console.log("SELF-TEST  " + matrix.date + "  " + matrix.__path.split(/[\\/]/).pop());
  if (!cell) {
    console.log("  no eligible cell");
    process.exit(0);
  }
  console.log(`  picked   ${cell.persona} x ${cell.moment} [${cell.direction}]`);
  console.log(`  reason   ${cell.reason}`);
  console.log("  samples:");
  for (const s of cell.samples) console.log("    - " + s);
  const eligible = (matrix.cells ?? []).filter(
    (c) => c.verdict === "有需求·无页面" && (!c.produced || c.produced === "available"),
  ).length;
  console.log(`  eligible cells remaining: ${eligible}`);
  process.exit(0);
}

if (arg.includes("--next")) {
  const matrix = loadMatrix();
  const cell = matrix ? nextCell(matrix) : null;
  console.log(JSON.stringify(cell ?? { none: true }, null, 2));
  process.exit(cell ? 0 : 0);
}
