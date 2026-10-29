/*
 * The one source list. Both the writer's research step and the reachability probe read it, because two
 * lists drift: the probe tested fifteen hosts while the pipeline had eighteen, and the five added for
 * visas, students and payments had never been checked at all.
 */
export const CANDIDATES = [
  ["https://www.federalregister.gov/api/v1/documents.json?per_page=20&order=newest&conditions[agencies][]=u.s.-customs-and-border-protection", "federal-register-cbp", "US CBP rules with effective dates, the best API of any source here"],
  ["https://policy.trade.ec.europa.eu/news_en", "eu-trade-news", "EU trade policy news, CBAM and trade defence"],
  ["https://cacs.mofcom.gov.cn/", "trade-remedy-cases", "foreign anti-dumping and safeguard measures against Chinese exports, the highest-value source for a cost angle"],
  ["http://gss.mof.gov.cn/gzdt/", "tariff-commission", "Tariff Commission notices: rate schedules and adjustments"],
  ["https://www.mof.gov.cn/zhengwuxinxi/zhengcefabu/", "ministry-of-finance", "Ministry of Finance policy releases"],
  ["https://www.mofcom.gov.cn/zfxxgk/", "mofcom", "MOFCOM announcements"],
  ["https://www.stats.gov.cn/sj/zxfb/", "statistics-bureau", "National Bureau of Statistics releases: PPI, CPI, industrial profit"],
  ["https://www.chinatax.gov.cn/chinatax/n810341/n810755/index.html", "tax-administration", "export tax rebate rates"],
  /*
   * Customs was the omission that mattered most: the tariff schedules and clearance rules are what a per-unit
   * cost is built from, and the list did not have it.
   */
  ["http://www.customs.gov.cn/customs/302249/index.html", "customs", "tariff schedules, classification and clearance rules"],

  /*
   * THE FIVE MOMENTS BEYOND BUY.
   *
   * Every source above answers what a measure costs an importer. The agent route kept landing on cells
   * about visas, residence and student costs, where those sources have nothing to say - which is how a run
   * ends in INSUFFICIENT-EVIDENCE with the work done and no number to show for it.
   *
   * These seven are the sources for arrive, live and leave. Reachability is measured from a runner, not
   * assumed, and an unreachable source stays in the list rather than being deleted: a route can come back.
   */
  ["https://english.www.gov.cn/", "gov-en", "State Council policy in English: visas, taxation, customs, entry and exit - the one source that covers all five moments"],
  ["https://www.nia.gov.cn/n741440/n741567/index.html", "immigration", "National Immigration Administration: visa categories, residence permits, entry rules"],
  ["https://www.safe.gov.cn/safe/zcfg/index.html", "safe", "SAFE: foreign exchange, cross-border payments, repatriation of profits"],
  ["https://www.caac.gov.cn/XXGK/XXGK/", "caac", "CAAC: aviation rules, passenger and cargo carriage"],
  ["https://www.mot.gov.cn/", "mot", "Ministry of Transport: shipping, ports and freight rates"],
  ["https://www.samr.gov.cn/zw/zfxxgk/fdzdgknr/", "samr", "SAMR: product standards, labelling, market access"],
  ["http://en.moe.gov.cn/", "moe-en", "Ministry of Education in English: student costs, tuition, scholarships"],
  /*
   * Industry chambers, listed last on purpose. An association reports what its members are hitting, which is the
   * closest thing to a demand signal there is without a keyword tool - and a summary of a measure is coverage,
   * not the measure. A figure may come from a chamber only when it is the chamber's own published statistic.
   */
  ["http://www.ccpit.org", "trade-council", "trade friction alerts and commercial certification"],
  ["http://www.cccme.org.cn", "machinery-chamber", "machinery and electronics export data and market access"],


];
