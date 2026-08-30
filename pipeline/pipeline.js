#!/usr/bin/env node
// pipeline.js — nightly cron entrypoint. SOURCE -> QUALIFY -> NURTURE -> PROMOTE -> DELIVER.
// Enrichment (credits) NEVER runs unless ENRICH_APPROVED=true is set for that run.
//
// Railway cron:  node pipeline.js          (searches + scoring only, zero credits)
// Manual:        ENRICH_APPROVED=true ENRICH_LIMIT=50 node pipeline.js
// Dry run:       DRY_RUN=true node pipeline.js   (uses fixture data, no GTM CLI needed)

const cfg = require("./config/icp.json");
const { searchContacts, enrichContact, passesLocationGate } = require("./src/search.js");
const { scoreLead } = require("./src/score.js");
const nurture = require("./src/nurture.js");
const { deliver } = require("./src/deliver.js");

const runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);

async function main() {
  console.log(`[${runId}] Age 59.5 pipeline start`);

  // ---- SOURCE (free) ----
  let raw = [];
  if (process.env.DRY_RUN === "true") {
    raw = require("./data/fixtures.json");
    console.log(`DRY RUN: ${raw.length} fixture contacts`);
  } else {
    for (const level of cfg.search_filters.managementLevel) {
      for (let page = 1; page <= Number(process.env.MAX_PAGES ?? 3); page++) {
        const batch = searchContacts({ managementLevel: level, pageSize: 100, page });
        if (!batch.length) break;
        raw.push(...batch);
      }
    }
    console.log(`Sourced ${raw.length} contacts (search only — 0 credits)`);
  }

  // ---- GATE 1: location ----
  const located = raw.filter(passesLocationGate);
  console.log(`After CT/MA exclusion: ${located.length}`);

  // ---- QUALIFY (free) ----
  const scored = located.map(scoreLead);

  // ---- CREDIT GATE: enrichment only with explicit approval ----
  if (process.env.ENRICH_APPROVED === "true" && process.env.DRY_RUN !== "true") {
    const limit = Math.min(Number(process.env.ENRICH_LIMIT ?? cfg.credit_gate.max_enrich_per_run_when_approved), cfg.credit_gate.max_enrich_per_run_when_approved);
    const targets = scored.filter((l) => l.tier === "A" && l.age_basis !== "CONFIRMED").slice(0, limit);
    console.log(`ENRICH APPROVED: enriching ${targets.length} Tier-A records (limit ${limit}) — THIS CONSUMES CREDITS`);
    for (const t of targets) {
      try { Object.assign(t, { enriched: enrichContact(t.id) }); } catch (e) { console.error(`enrich failed ${t.id}: ${e.message}`); }
    }
  } else {
    console.log("Credit gate CLOSED — no enrichment this run.");
  }

  // ---- NURTURE tracking + PROMOTE matured ----
  const nStats = nurture.track(scored);
  const promoted = nurture.promoteMatured();
  console.log(`Nurture: +${nStats.added} new, ${nStats.refreshed} refreshed, ${nStats.total} tracked. Promoted to SELL: ${promoted.length}`);
  console.log(`Maturity pipeline:`, nurture.pipelineByQuarter());

  // ---- DELIVER ----
  const all = [...scored, ...promoted];
  const { manifest } = await deliver(all, { runId });
  console.log(`Delivered:`, manifest.counts, `Tiers:`, manifest.tiers);
  console.log(`Compliance:`, manifest.compliance.note);
}

main().catch((e) => { console.error(e); process.exit(1); });
