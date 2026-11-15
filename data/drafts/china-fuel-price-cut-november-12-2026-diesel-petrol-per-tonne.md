---
route: "script"
title: "China cuts petrol and diesel prices by 645 and 625 yuan a"
subtitle: "The NDRC cut ex-refinery gasoline by 645 yuan and diesel by 625 yuan per tonne at 24:00 on 12 November 2026. Here is how to reprice inland trucking per tonne."
description: "China's NDRC cut gasoline by 645 yuan and diesel by 625 yuan per tonne from 24:00 on 12 November 2026. Importers should recompute inland trucking and factory-gate delivery cost per tonne of cargo."
publishDate: 2026-11-15
reviewBy: 2027-05-15
stakes: "priced"
category: "logistics"
audience: "importer"
tags: ["fuel price", "diesel", "petrol", "inland trucking", "landed cost", "NDRC", "China logistics"]
priority: "P1"
featured: false
draft: false
articleNumber: 104
target_keyword: "China fuel price cut November 12 2026 diesel petrol per tonne"
search_intent: "transactional"
information_gain: "custom-calculation"
sources:
  - "National Development and Reform Commission (NDRC), Price Department — 2026年11月12日国内成品油价格调整, published 2026/11/12"
figures:
  - value: "645"
    unit: "yuan per tonne, cut in gasoline (standard product) retail price"
    period: "effective 24:00 on 12 November 2026"
    source: "National Development and Reform Commission, Price Department"
    retrieved: "2026-11-15"
  - value: "625"
    unit: "yuan per tonne, cut in diesel (standard product) retail price"
    period: "effective 24:00 on 12 November 2026"
    source: "National Development and Reform Commission, Price Department"
    retrieved: "2026-11-15"
  - value: "10"
    unit: "working days, the averaging window used for the price adjustment"
    period: "the ten working days before the 12 November 2026 adjustment"
    source: "National Development and Reform Commission, Price Department"
    retrieved: "2026-11-15"
  - value: "11月12日24时"
    unit: "effective time of the price cut"
    period: "12 November 2026, 24:00"
    source: "National Development and Reform Commission, Price Department"
    retrieved: "2026-11-15"
  - value: "10月29日"
    unit: "date of the previous fuel price adjustment"
    period: "29 October 2026"
    source: "National Development and Reform Commission, Price Department"
    retrieved: "2026-11-15"
  - value: "12315"
    unit: "hotline for reporting price-law violations"
    period: "in force at publication, 12 November 2026"
    source: "National Development and Reform Commission, Price Department"
    retrieved: "2026-11-15"
---

## AI Summary

China's National Development and Reform Commission cut the retail price of standard gasoline by 645 yuan per tonne and standard diesel by 625 yuan per tonne, effective 24:00 on 12 November 2026. Diesel is the fuel that moves cargo inland, so the cut lowers the per-tonne trucking and factory-gate delivery cost an importer pays. This article gives the arithmetic to reprice a trucking quote per tonne of cargo, and the steps to take before the next adjustment.

## What happened

The Price Department of the National Development and Reform Commission published its adjustment notice on 12 November 2026. From 24:00 that day, the domestic retail price of standard gasoline falls by **645 yuan per tonne** and the retail price of standard diesel falls by **625 yuan per tonne**.

The notice states the change in yuan per tonne, not in yuan per litre. That matters for anyone repricing freight, because a trucking quote is built on litres burned, and the conversion from a per-tonne cut to a per-litre cut depends on the density of the fuel, which the notice does not give. The per-tonne figure is the confirmed number; the per-litre figure is a calculation the reader makes with their own density assumption.

The same notice carries the enforcement line: consumers can report price-law violations through the 12315 platform. That is the channel for a station that does not pass the cut through at the pump.

> **Standard product** — the reference grade the NDRC prices. The notice sets the ceiling for 汽、柴油（标准品）, gasoline and diesel of the standard specification. Retail stations price against that ceiling, and the cut applies to the ceiling, not to a single brand's pump price.

The adjustment is the latest in a series. The previous one took effect on 29 October 2026, and the notice frames this cut against it.

## Why now

The notice gives the mechanism in one sentence: the average price over the ten working days before this adjustment was lower than the average price over the ten working days before the previous adjustment. The previous adjustment was on 29 October 2026. So the trigger is a ten-working-day average that fell, measured against the ten-working-day average that set the 29 October price.

The notice also states that international crude oil prices moved down over the period since the 29 October adjustment. The domestic cut follows that move through the averaging window. There is no discretionary element described in the notice: the window is ten working days, the comparison is average against average, and the result is a cut of 645 yuan on gasoline and 625 yuan on diesel per tonne.

## So what

Diesel is the input that matters for an importer. A container does not move from a Chinese factory to a port on gasoline; it moves on a diesel truck, and the factory-gate delivery charge on a purchase order is a diesel cost plus a driver cost plus a margin. When the diesel ceiling falls by 625 yuan per tonne, the fuel component of that charge falls with it, and the importer's per-tonne delivery cost falls by the fuel share of the trucking rate.

The arithmetic an importer needs is a ratio, not a price. The cut is 625 yuan per tonne of diesel. To turn that into a cost per tonne of cargo, three things are needed: the diesel burn per tonne of cargo moved, the density used to convert the per-tonne cut into a per-litre cut, and the share of the trucking rate that is fuel. The notice supplies only the first input — the 625 yuan per tonne cut. The other two are the importer's own operating figures, and this article does not assume them.

Here is the formula, written so a reader can drop in their own numbers:

```
diesel cut per tonne of fuel   = 625 yuan / tonne (NDRC, 12 Nov 2026)
diesel cut per litre           = 625 / (1000 / density in kg per litre)
                               = 625 x density / 1000   yuan per litre
fuel saving per tonne of cargo = diesel cut per litre x litres burned per tonne of cargo
new delivery cost per tonne    = old delivery cost per tonne - fuel saving per tonne
```

Worked with a placeholder density and a placeholder burn rate, the shape is this. If a reader's density is D kg per litre, the per-litre cut is 625 × D / 1000 yuan. If a truck burns L litres to move one tonne of cargo over the route, the saving per tonne of cargo is that per-litre figure times L. The reader substitutes D and L; the 625 is fixed by the notice.

The same formula runs on gasoline for any leg priced on petrol rather than diesel, with 645 in place of 625. The difference between the two cuts is 20 yuan per tonne, and it exists because the notice sets two separate ceilings.

Three consequences follow for an importer's paperwork.

First, a trucking quote dated before 24:00 on 12 November 2026 was priced against the old ceiling. A quote dated after it was priced against the new one. When comparing two forwarders' rates, check the quote date against the effective time, because a quote that has not been refreshed carries the pre-cut fuel cost inside it.

Second, the cut is a ceiling change, not a pump-price guarantee. The notice sets the ceiling and gives the 12315 channel for violations. A station that holds the old price is a reportable matter, not a cost the importer has to absorb silently.

Third, the next adjustment resets the baseline. The notice compares ten-working-day averages, so the 625 yuan cut is measured against the 29 October price, not against a fixed reference. An importer building a delivery cost into a long contract should treat the fuel component as a variable tied to the NDRC ceiling, not as a fixed number locked at signature.

For a reader tracking the wider cost of moving goods, the fuel line sits alongside the other inland and cross-border charges. The parcel cost breakdown in [What a Parcel From China to India Actually Costs](/blog/china-to-india-parcel-cost-procedure-2026/) shows how a single shipment's cost stacks up from several components, and the fuel component behaves the same way: it is one line, it moves with the ceiling, and it is worth isolating. Readers repricing a return leg should also check [Returning Goods to China: The Procedure Behind the Refund](/blog/china-return-shipping-refund-procedure-2026/), where the reverse logistics cost carries the same diesel exposure. And for the factory-gate side of the same purchase order, the producer-price split in [Factory Prices Rose 5.0%, Split 20 Points](/blog/china-producer-price-split-copper-ferrous-2026/) shows how input costs at the factory move independently of the fuel that carries the finished goods.

## How confident

**Confirmed.** The NDRC Price Department notice of 12 November 2026 states that from 24:00 that day the retail price of standard gasoline falls by 645 yuan per tonne and standard diesel by 625 yuan per tonne. It states that the ten-working-day average before this adjustment was lower than the ten-working-day average before the previous adjustment, that the previous adjustment was on 29 October 2026, and that international crude prices moved down over the period. It names the 12315 platform for reporting price violations. Every figure in this article comes from that single notice.

**Inferred.** The per-litre cut, the fuel saving per tonne of cargo, and the new delivery cost per tonne are all calculations, not figures from the notice. They rest on a density and a burn rate that the notice does not supply, and this article does not assume either. The claim that a trucking quote dated before 24:00 on 12 November carries the old fuel cost is an inference from how a ceiling price flows into a freight rate, not a statement in the document. The whole cost picture rests on one document, and no second source has been cross-checked against it.

**What would change my mind.** A second NDRC notice or a provincial price bureau publication giving a per-litre figure, or a density for standard diesel, would let the per-litre cut be stated as confirmed rather than calculated. A published trucking rate schedule showing the fuel share of a per-tonne delivery charge would replace the placeholder burn rate with a sourced one. Absent those, the per-tonne cut is the only number a reader should treat as fixed.

## For you

- **Importers repricing inland trucking:** take the 625 yuan per tonne diesel cut, apply your own density and burn rate through the formula above, and reissue the per-tonne delivery cost on every open purchase order dated after 24:00 on 12 November 2026.
- **Importers comparing forwarder quotes:** check the quote date against the effective time. A quote issued before the cut carries the old ceiling inside it, so refresh it before you compare it with a post-cut rate.
- **Importers signing a long delivery contract:** write the fuel component as a variable tied to the NDRC ceiling rather than a fixed number, so the next ten-working-day adjustment flows through instead of being absorbed by one side.
- **Importers whose cargo moves on petrol rather than diesel:** run the same formula with 645 in place of 625, and note that the two ceilings are set separately in the same notice.

## The data point

The diesel ceiling fell by 625 yuan per tonne at 24:00 on 12 November 2026, and that is the only figure in the chain the notice fixes.

<div class="callout">
625 yuan per tonne — the cut in the standard diesel retail price, effective 24:00 on 12 November 2026, per the NDRC Price Department notice of 12 November 2026. The per-litre cut and the per-tonne-of-cargo saving are the reader's calculation, not the notice's.
</div>

## FAQ

**How much did China cut diesel and petrol prices on 12 November 2026?**
The NDRC Price Department cut the retail price of standard gasoline by 645 yuan per tonne and standard diesel by 625 yuan per tonne, effective 24:00 on 12 November 2026. The notice states the change in yuan per tonne, not per litre. To get a per-litre figure, divide the per-tonne cut by the number of litres in a tonne, which depends on the fuel's density. The notice does not give a density, so the per-litre number is a calculation the reader makes, while the per-tonne cut is the confirmed figure.

**Why did the NDRC cut prices on this date?**
The notice states that the average price over the ten working days before this adjustment was lower than the average over the ten working days before the previous adjustment, which took effect on 29 October 2026. It also states that international crude oil prices moved down over the period since that previous adjustment. The mechanism is a ten-working-day average compared against the prior ten-working-day average, and the result was a cut on both gasoline and diesel.

**How does a fuel price cut change my per-tonne delivery cost?**
The cut lowers the diesel ceiling by 625 yuan per tonne. To turn that into a cost per tonne of cargo, multiply the per-litre cut by the litres a truck burns to move one tonne over your route, then subtract that from your old delivery cost per tonne. The notice supplies the per-tonne cut; your density and burn rate supply the rest. A quote dated before 24:00 on 12 November 2026 was priced against the old ceiling, so refresh it before comparing.

## How we calculated this

```
NDRC notice, 12 November 2026:
  gasoline cut = 645 yuan per tonne
  diesel cut   = 625 yuan per tonne
  effective    = 24:00 on 12 November 2026
  window       = 10 working days, average vs average
  prior adjust = 29 October 2026

Per-litre cut (reader's calculation, density D kg/litre):
  litres per tonne = 1000 / D
  diesel cut per litre = 625 / (1000 / D) = 625 x D / 1000 yuan

Saving per tonne of cargo (reader's burn rate L litres/tonne):
  saving = (625 x D / 1000) x L yuan per tonne of cargo

New delivery cost per tonne:
  old delivery cost per tonne - saving

Gasoline leg: substitute 645 for 625.
```

## The point

The NDRC cut the diesel ceiling by 625 yuan per tonne and the gasoline ceiling by 645 yuan per tonne at 24:00 on 12 November 2026, and the only number an importer can treat as fixed is that per-tonne cut. Everything downstream — the per-litre figure, the saving per tonne of cargo, the new delivery cost — is the importer's own arithmetic on their own density and burn rate. Do that arithmetic, date every quote against the effective time, and write the fuel line as a variable so the next ten-working-day adjustment flows through instead of landing on one side of the contract.