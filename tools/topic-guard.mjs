#!/usr/bin/env node
/**
 * TOPIC GUARD - one place that decides whether a subject may become an article at all.
 *
 * The three refusals existed, but in three different files and at three different moments: the headline
 * crawler dropped disasters, the guide queue dropped political names, and the publish step checked nothing.
 * That spread is how the site published, on 2026-11-09, a leadership commentary, two disaster pieces and a
 * guide answering a Vietnamese query - each one caught by a person afterwards, none by the pipeline.
 *
 * This module is the single rule, called before a draft is written rather than after it is published:
 *
 *   1. a political figure, a party body, a leadership narrative - commentary the charter excludes
 *   2. a disaster or a crime: casualties, death tolls, accidents, investigations
 *   3. a subject that is not English, which on this site means someone else's search query
 *
 *   import { topicGuard } from "./topic-guard.mjs";
 *   const verdict = topicGuard({ title, keyword, slug });
 *   if (!verdict.ok) { …refuse, and say verdict.reason… }
 *
 *   node tools/topic-guard.mjs "title here"        # one-off check from the shell
 *
 * It reads a string and returns a verdict. It changes no gate, no threshold, no assertion.
 */

const POLITICAL = /\b(xi jinping|jinping|ccp|cpc|politburo|standing committee|central committee|premier li|li qiang|wang yi|state council leaders?)\b|\b(steers?|steering|leadership|governance|thought|ideology|socialism with chinese characteristics|party congress)\b/i;

/* A death toll is the marker, not the word "fire": a fire-safety rule is a legitimate trade subject. */
const DISASTER = /\b(\d{1,4})\s*(?:confirmed\s*)?(?:dead|killed|drowned|injured|missing)\b|\b(?:death toll|fatalities|casualt(?:y|ies)|multiple deaths)\b|\b(?:apartment|building|factory|mine|coal mine|chemical plant)\s+(?:fire|blast|explosion|collapse)\b|\b(?:earthquake|flood|landslide|typhoon)\s+(?:kills?|leaves?|death)\b|\b(?:murder|homicide|stabbing|shooting|arrested for|smuggling ring|drug bust)\b/i;

const NON_ASCII = /[^\x00-\x7F]/;

/**
 * @param {{title?: string, keyword?: string, slug?: string}} subject
 * @returns {{ok: boolean, reason?: string, rule?: string}}
 */
export function topicGuard(subject = {}) {
  const text = [subject.title, subject.keyword, subject.slug].filter(Boolean).join(" \n ");
  if (!text.trim()) return { ok: true };

  if (NON_ASCII.test(text)) {
    return { ok: false, rule: "language", reason: "the subject is not written in English - this site publishes in English" };
  }
  const disaster = DISASTER.exec(text);
  if (disaster) {
    return { ok: false, rule: "disaster", reason: `casualty or crime reporting ("${disaster[0]}") - the charter covers trade and living, not incidents` };
  }
  const political = POLITICAL.exec(text);
  if (political) {
    return { ok: false, rule: "political", reason: `leadership or party commentary ("${political[0]}") - the charter's 政策分析 means policy documents, not politics` };
  }
  return { ok: true };
}

/* CLI so a person can ask the same question the pipeline asks. */
if (process.argv[1] && process.argv[1].endsWith("topic-guard.mjs")) {
  const arg = process.argv.slice(2).join(" ").trim();
  if (!arg) {
    console.log('usage: node tools/topic-guard.mjs "a subject to check"');
    process.exit(2);
  }
  const v = topicGuard({ title: arg });
  console.log(v.ok ? `PASS  ${arg}` : `REFUSED [${v.rule}]  ${arg}\n        ${v.reason}`);
  process.exit(v.ok ? 0 : 1);
}
