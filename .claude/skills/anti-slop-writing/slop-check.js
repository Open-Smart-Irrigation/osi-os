#!/usr/bin/env node
// slop-check.js — mechanical floor for the anti-slop-writing skill.
// Scans Markdown/prose files for high-confidence AI-writing tells.
//
// Usage:
//   node .claude/skills/anti-slop-writing/slop-check.js <file.md> [more files...]
//   node .claude/skills/anti-slop-writing/slop-check.js --self-test
//
// Exit codes: 0 = no tier-1 findings, 1 = tier-1 findings present, 2 = usage error.
//
// Escape hatch: a line containing "slop-allow:" (usually in an HTML comment,
// e.g. <!-- slop-allow: quoting a vendor name -->) is skipped entirely. Use it
// for quoted material and domain terms, with a one-word justification.
//
// Scope notes:
// - Code fences and inline code spans are stripped before matching, so file
//   names like verify-codec-robustness.js never trip the word floor.
// - This script only covers the regex-able floor. Rhythm, structure, and tone
//   rules live in SKILL.md and need human/model judgment.
'use strict';

const fs = require('fs');

// Tier 1: presence alone is a finding. Case-insensitive.
const TIER1 = [
  // Vocabulary floor (merged from Wikipedia "Signs of AI writing" word lists,
  // stop-slop phrases.md, kjmagnan1s tier-1, rossmann rule set).
  /\bdelv(?:e|es|ed|ing)\b/i,
  /\btapestry\b/i,
  /\btestament to\b/i,
  /\bpivotal\b/i,
  /\bcrucial(?:ly)?\b/i,
  /\bseamless(?:ly)?\b/i,
  /\bboasts?\b/i,
  /\bvibrant\b/i,
  /\bmeticulous(?:ly)?\b/i,
  /\bintricate\b/i,
  /\bgarner(?:s|ed|ing)?\b/i,
  /\bholistic\b/i,
  /\bmyriad\b/i,
  /\bplethora\b/i,
  /\brealm\b/i,
  /\bfoster(?:s|ed|ing)\b/i,
  /\bleverag(?:e|es|ed|ing)\b/i,
  /\bshowcas(?:e|es|ed|ing)\b/i,
  /\bempower(?:s|ed|ing)?\b/i,
  /\belevat(?:e|es|ed|ing)\b/i,
  /\bunleash(?:es|ed|ing)?\b/i,
  /\brevolutioniz(?:e|es|ed|ing)\b/i,
  /\bgame-?chang(?:er|ing)\b/i,
  /\bcutting-?edge\b/i,
  /\bstate-of-the-art\b/i,
  /\bsupercharg(?:e|es|ed|ing)\b/i,
  /\bnestled\b/i,
  /\bin the heart of\b/i,
  /\bunderscor(?:es|ed|ing)\s+(?:the|a|an|its|their|how|that|why)\b/i,
  /\bjourney\b/i, // abstract "journey" is a tell; physical trips get a slop-allow
  // Copula avoidance / inflated significance.
  /\bserves? as\b/i,
  /\bstands? as\b/i,
  /\bplays? a (?:vital|crucial|key|pivotal|central) role\b/i,
  // Throat-clearing, meta-commentary, filler.
  /\bit(?:'s| is) (?:important|worth) (?:to note|noting|to understand)\b/i,
  /\bin today's\b/i,
  /\bever-evolving\b/i,
  /\bfast-paced world\b/i,
  /\bat the end of the day\b/i,
  /\bwhen it comes to\b/i,
  /\bin a world where\b/i,
  /\bhere(?:'s| is) the thing\b/i,
  /\blet that sink in\b/i,
  /\bmake no mistake\b/i,
  /\bneedless to say\b/i,
  /\bit goes without saying\b/i,
  /\bas we (?:can see|have seen|will see)\b/i,
  /\blet(?:'s| us) (?:dive|explore|unpack|take a (?:closer )?look)\b/i,
  /\bdeep dive\b/i,
  /\bdive into\b/i,
  /\bunpack(?:s|ed|ing)?\b/i,
  /\bdouble down\b/i,
  /\bcircle back\b/i,
  /\bmoving forward\b/i,
  /\bthink of (?:it|this|the \w+) as\b/i,
  /^\s*in (?:conclusion|summary),/im,
  // Negative parallelism ("not just X but Y" family).
  /\bnot (?:just|only|merely|simply) [^.\n]{0,60}\bbut(?: also| rather)?\b/i,
  /\bisn(?:'t| not) (?:just|only|merely|simply)\b/i,
  /\bmore than just\b/i,
  // Emoji used as decoration.
  /[\u{1F300}-\u{1FAFF}\u{2705}\u{274C}\u{2B50}\u{1F680}]/u,
];

// Tier 2: reported as warnings; judgment applies (density and context matter).
const TIER2 = [
  /\blandscape\b/i,
  /\becosystem\b/i,
  /\bcomprehensive\b/i,
  /\bfurthermore\b/i,
  /\bmoreover\b/i,
  /^\s*additionally,/im,
  /\bessentially\b/i,
  /\barguably\b/i,
  /\brobust(?:ness)?\b/i,
  /\bstreamlin(?:e|es|ed|ing)\b/i,
  /\b(?:very|really|truly|genuinely|literally|incredibly|extremely|fundamentally|inherently)\b/i,
];

// Em-dash budget: warn above this many per 1000 words.
const EMDASH_PER_1000_WORDS = 8;

function stripCode(text) {
  return text
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));
}

function scanFile(path) {
  const raw = fs.readFileSync(path, 'utf8');
  const text = stripCode(raw);
  const lines = text.split('\n');
  const findings = { tier1: [], tier2: [], emdash: null };

  lines.forEach((line, i) => {
    if (/slop-allow:/.test(line)) return;
    for (const re of TIER1) {
      const m = line.match(re);
      if (m) findings.tier1.push({ line: i + 1, match: m[0].trim() });
    }
    for (const re of TIER2) {
      const m = line.match(re);
      if (m) findings.tier2.push({ line: i + 1, match: m[0].trim() });
    }
  });

  // Em-dash density measures prose rhythm only: headings and markdown link
  // labels use the dash as a title separator ("01 — Overview"), not as
  // punctuation, so both are excluded from the count.
  const proseOnly = text
    .split('\n')
    .filter((l) => !/^\s*#{1,6}\s/.test(l))
    .join('\n')
    .replace(/\[[^\]]*\]\([^)]*\)/g, ' ');
  const words = text.split(/\s+/).filter(Boolean).length;
  const emdashes = (proseOnly.match(/—/g) || []).length;
  const per1000 = words ? (emdashes / words) * 1000 : 0;
  if (per1000 > EMDASH_PER_1000_WORDS) {
    findings.emdash = { emdashes, words, per1000: per1000.toFixed(1) };
  }
  return findings;
}

function selfTest() {
  const dirty =
    "In today's ever-evolving landscape, let's dive into the tapestry of " +
    'features — not just a tool, but a game-changer that serves as a testament to progress.';
  const clean =
    'The runner applies pending migrations inside BEGIN IMMEDIATE and records ' +
    'a SHA-256 checksum per file. `verify-codec-robustness.js` covers the decoders.';
  const hit = TIER1.some((re) => re.test(dirty));
  const miss = TIER1.some((re) => re.test(stripCode(clean)));
  if (hit && !miss) {
    console.log('self-test OK: dirty fixture flagged, clean fixture passes');
    process.exit(0);
  }
  console.error(`self-test FAILED: dirty flagged=${hit}, clean flagged=${miss}`);
  process.exit(1);
}

const args = process.argv.slice(2);
if (args[0] === '--self-test') selfTest();
if (args.length === 0) {
  console.error('usage: slop-check.js <file> [files...] | --self-test');
  process.exit(2);
}

let tier1Total = 0;
for (const path of args) {
  const f = scanFile(path);
  tier1Total += f.tier1.length;
  for (const { line, match } of f.tier1) console.log(`TIER1 ${path}:${line}: "${match}"`);
  for (const { line, match } of f.tier2) console.log(`tier2 ${path}:${line}: "${match}"`);
  if (f.emdash) {
    console.log(
      `tier2 ${path}: em-dash density ${f.emdash.per1000}/1000 words ` +
        `(${f.emdash.emdashes} in ${f.emdash.words}; budget ${EMDASH_PER_1000_WORDS})`
    );
  }
}
console.log(tier1Total === 0 ? 'slop-check: PASS (no tier-1 findings)' : `slop-check: FAIL (${tier1Total} tier-1 findings)`);
process.exit(tier1Total === 0 ? 0 : 1);
