// src/deliver.js — COMPLIANCE + DELIVER stages.
// DNC scrub is a hard gate before anything reaches an advisor. Output = ranked CSV + JSON.
const fs = require("fs");
const path = require("path");
const cfg = require("../config/icp.json");

const OUT = path.join(__dirname, "..", "out");

/**
 * DNC scrub — Gate 5. Federal + NY registries.
 * STUB: wire to your DNC vendor API (e.g., DNC.com, Gryphon, PossibleNOW).
 * Until wired, every lead is marked dnc_status: "UNSCRUBBED" and dnc_clear stays false —
 * the delivery file separates them so nothing unscrubbed ships by accident.
 */
async function dncScrub(leads) {
  return leads.map((l) => ({ ...l, dnc_status: "UNSCRUBBED", dnc_clear: false }));
}

function toCSV(rows) {
  if (!rows.length) return "";
  const cols = ["tier", "score", "route", "name", "title", "company", "state", "age_estimate", "age_basis", "asset_estimate", "asset_basis", "maturity_date", "dnc_status", "id"];
  const esc = (v) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
}

async function deliver(scored, { runId }) {
  fs.mkdirSync(OUT, { recursive: true });
  const scrubbed = await dncScrub(scored);

  const sell = scrubbed.filter((l) => l.route === "SELL").sort((a, b) => b.score - a.score);
  const nurture = scrubbed.filter((l) => l.route === "NURTURE").sort((a, b) => (a.maturity_date ?? "9999") < (b.maturity_date ?? "9999") ? -1 : 1);
  const holds = scrubbed.filter((l) => l.route === "HOLD_UNKNOWN_AGE");
  const dq = scrubbed.filter((l) => l.route.startsWith("DISQUALIFIED"));

  const files = {};
  for (const [name, rows] of [["sell", sell], ["nurture", nurture], ["hold_unknown_age", holds], ["disqualified", dq]]) {
    if (!rows.length) continue;
    const base = path.join(OUT, `${runId}_${name}`);
    fs.writeFileSync(`${base}.csv`, toCSV(rows));
    fs.writeFileSync(`${base}.json`, JSON.stringify(rows, null, 2));
    files[name] = { csv: `${base}.csv`, json: `${base}.json`, count: rows.length };
  }

  // Delivery terms read from the three open v3 decisions — null means "not yet decided", noted in manifest.
  const manifest = {
    runId, generated: new Date().toISOString(),
    counts: { sell: sell.length, nurture: nurture.length, hold_unknown_age: holds.length, disqualified: dq.length },
    tiers: { A: sell.filter((l) => l.tier === "A").length, B: sell.filter((l) => l.tier === "B").length, C: sell.filter((l) => l.tier === "C").length },
    delivery_terms: {
      exclusivity: cfg.routing.delivery_exclusivity,
      sell_nurture_before_maturity: cfg.routing.sell_nurture_before_maturity,
      bad_data_replacement_guarantee: cfg.routing.bad_data_replacement_guarantee,
    },
    compliance: { dnc_wired: false, note: "NO leads are sellable until DNC vendor is wired. All rows marked UNSCRUBBED." },
  };
  fs.writeFileSync(path.join(OUT, `${runId}_manifest.json`), JSON.stringify(manifest, null, 2));
  return { files, manifest };
}

module.exports = { deliver, dncScrub };
