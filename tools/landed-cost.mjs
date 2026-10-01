/**
 * Landed-cost model — the reusable calculator behind every "So what" section.
 *
 * The point of this file: an article should never do ad-hoc arithmetic in
 * prose. It calls the model, so the same shipment is computed identically in
 * every article that mentions it, and any figure in an article can be
 * recomputed from stated inputs.
 *
 * Model:
 *   duty per unit      = FOB x (MFN rate + Section 301 rate + other rate)
 *   landed cost / unit = FOB + duty per unit + freight per unit + insurance
 *
 * Everything is expressed per unit and per container, because that is the
 * only form a seller can act on.
 *
 * Run:  node tools/landed-cost.mjs
 */

/** @typedef {{ label: string, fobUnit: number, unitsPerContainer: number, mfnRate: number, section301Rate: number, otherDutyRate?: number, freightPerContainer?: number, insuranceRate?: number }} Scenario */

/**
 * @param {Scenario} s
 */
export function landedCost(s) {
  const {
    fobUnit,
    unitsPerContainer,
    mfnRate,
    section301Rate,
    otherDutyRate = 0,
    freightPerContainer = 0,
    insuranceRate = 0,
  } = s;

  const dutyRate = mfnRate + section301Rate + otherDutyRate;
  const dutyPerUnit = fobUnit * dutyRate;
  const freightPerUnit = unitsPerContainer > 0 ? freightPerContainer / unitsPerContainer : 0;
  const insurancePerUnit = fobUnit * insuranceRate;

  const landedPerUnit = fobUnit + dutyPerUnit + freightPerUnit + insurancePerUnit;

  return {
    dutyRate,
    dutyPerUnit,
    dutyPerContainer: dutyPerUnit * unitsPerContainer,
    freightPerUnit,
    landedPerUnit,
    landedPerContainer: landedPerUnit * unitsPerContainer,
  };
}

/** Percentage delta of b vs a, e.g. the exclusion cliff. */
export function delta(a, b) {
  return {
    dutyPerUnit: b.dutyPerUnit - a.dutyPerUnit,
    dutyPerContainer: b.dutyPerContainer - a.dutyPerContainer,
    landedPerUnit: b.landedPerUnit - a.landedPerUnit,
    landedPct: a.landedPerUnit === 0 ? 0 : (b.landedPerUnit - a.landedPerUnit) / a.landedPerUnit,
  };
}

const money = (n) => "$" + n.toFixed(n < 10 ? 3 : 2);
const pct = (n) => (n * 100).toFixed(1) + "%";

/**
 * Worked examples used in the Section 301 exclusion article.
 *
 * Sourcing discipline: the only externally-verifiable input here is the
 * Section 301 rate (25% on Lists 1-3, 7.5% on List 4A — see the article's
 * source list). FOB, units per container and MFN are the reader's own inputs,
 * so the examples set MFN to 0 and isolate the Section 301 impact. Nothing in
 * this block is presented as a fact about the market.
 */
const CASES = [
  {
    label: "DC motor, List 3 (25%)",
    excluded: { fobUnit: 12.0, unitsPerContainer: 5000, mfnRate: 0, section301Rate: 0 },
    cliff: { fobUnit: 12.0, unitsPerContainer: 5000, mfnRate: 0, section301Rate: 0.25 },
  },
  {
    label: "Insulated wire with connectors, List 3 (25%)",
    excluded: { fobUnit: 0.9, unitsPerContainer: 60000, mfnRate: 0, section301Rate: 0 },
    cliff: { fobUnit: 0.9, unitsPerContainer: 60000, mfnRate: 0, section301Rate: 0.25 },
  },
  {
    label: "LCD module, List 4A (7.5%)",
    excluded: { fobUnit: 48.0, unitsPerContainer: 900, mfnRate: 0, section301Rate: 0 },
    cliff: { fobUnit: 48.0, unitsPerContainer: 900, mfnRate: 0, section301Rate: 0.075 },
  },
];

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("landed-cost.mjs")) {
  console.log("Section 301 exclusion cliff — duty impact per unit and per container");
  console.log("(FOB and MFN assumptions are per case; freight excluded — see notes)\n");

  for (const c of CASES) {
    const a = landedCost(c.excluded);
    const b = landedCost(c.cliff);
    const d = delta(a, b);

    console.log(c.label);
    console.log(`  FOB per unit ............... ${money(c.excluded.fobUnit)}`);
    console.log(`  Units per 40HQ ............. ${c.excluded.unitsPerContainer.toLocaleString("en-US")}`);
    console.log(`  MFN rate ................... ${pct(c.excluded.mfnRate)}`);
    console.log(`  With exclusion: duty/unit .. ${money(a.dutyPerUnit)}   duty/container ${money(a.dutyPerContainer)}`);
    console.log(`  After cliff:    duty/unit .. ${money(b.dutyPerUnit)}   duty/container ${money(b.dutyPerContainer)}`);
    console.log(`  Increase:       duty/unit .. ${money(d.dutyPerUnit)}   duty/container ${money(d.dutyPerContainer)}`);
    console.log(`  Landed cost per unit ....... ${money(a.landedPerUnit)} -> ${money(b.landedPerUnit)}  (+${pct(d.landedPct)})`);
    console.log("");
  }
}
