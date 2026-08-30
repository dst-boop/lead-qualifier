// src/nurture.js — NURTURE stage. Under-59.5 leads are tracked, deduped, and
// auto-promoted to SELL when maturity_date - release_lead_days is reached.
const fs = require("fs");
const path = require("path");
const cfg = require("../config/icp.json");

const STORE = path.join(__dirname, "..", "data", "nurture.json");

function load() {
  try { return JSON.parse(fs.readFileSync(STORE, "utf8")); } catch { return { leads: {} }; }
}
function save(db) {
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  fs.writeFileSync(STORE, JSON.stringify(db, null, 2));
}

/** Add or refresh nurture leads. Dedupe by ZoomInfo id. Returns counts. */
function track(scoredLeads) {
  const db = load();
  let added = 0, refreshed = 0;
  for (const l of scoredLeads.filter((x) => x.route === "NURTURE")) {
    if (db.leads[l.id]) { db.leads[l.id] = { ...db.leads[l.id], ...l, refreshed_at: l.scored_at }; refreshed++; }
    else { db.leads[l.id] = { ...l, tracked_since: l.scored_at }; added++; }
  }
  save(db);
  return { added, refreshed, total: Object.keys(db.leads).length };
}

/** Promote leads whose release window has arrived. Removes them from nurture, returns them for SELL. */
function promoteMatured() {
  const db = load();
  const leadDays = cfg.routing.nurture_release_lead_days ?? 90;
  const cutoff = new Date(Date.now() + leadDays * 864e5);
  const promoted = [];
  for (const [id, l] of Object.entries(db.leads)) {
    if (l.maturity_date && new Date(l.maturity_date) <= cutoff) {
      promoted.push({ ...l, route: "SELL", promoted_at: new Date().toISOString() });
      delete db.leads[id];
    }
  }
  save(db);
  return promoted;
}

/** Snapshot for reporting: maturity pipeline by quarter. */
function pipelineByQuarter() {
  const db = load();
  const buckets = {};
  for (const l of Object.values(db.leads)) {
    if (!l.maturity_date) continue;
    const d = new Date(l.maturity_date);
    const q = `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`;
    buckets[q] = (buckets[q] ?? 0) + 1;
  }
  return buckets;
}

module.exports = { track, promoteMatured, pipelineByQuarter, load };
