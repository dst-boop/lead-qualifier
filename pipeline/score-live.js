#!/usr/bin/env node
// score-live.js — scores a raw pipe-delimited search dump through the standard pipeline.
// Usage: node score-live.js runs/li_slice_raw.txt li-2026-08-30
const fs = require("fs");
const path = require("path");
const { scoreLead } = require("./src/score.js");
const { deliver } = require("./src/deliver.js");

const EXCLUDED_EMPLOYERS = ["equitable"]; // never lead-gen colleagues' own firm

const [, , input, runId] = process.argv;
const rows = fs.readFileSync(input, "utf8").trim().split("\n").map((l) => {
  const [id, firstName, lastName, jobTitle, companyName, directPhone, mobilePhone] = l.split("|");
  return {
    id, firstName, lastName, jobTitle, companyName,
    hasDirectPhone: directPhone === "1", hasMobilePhone: mobilePhone === "1",
    // Known-by-construction from the search filters (not in payload):
    monthsSinceJobChange: 24,      // midpoint of the 12-48mo positionStartDate window
    companyEmployees: 1000,        // employeeRangeMinimum 250 applied; use conservative mid
    // Unknown at search time — drives HOLD routing until enrichment:
    priorJobs: null, estimatedSalary: null, totalCareerYears: null,
  };
});

const kept = rows.filter((r) => !EXCLUDED_EMPLOYERS.some((x) => (r.companyName || "").toLowerCase().includes(x)));
const excluded = rows.length - kept.length;

const scored = kept.map((r) => {
  const s = scoreLead(r);
  s.phone_quality = r.hasDirectPhone ? "DIRECT" : r.hasMobilePhone ? "MOBILE" : "COMPANY_ONLY";
  return s;
});

deliver(scored, { runId }).then(({ manifest }) => {
  console.log(`Employer-excluded: ${excluded}`);
  console.log(`Counts:`, manifest.counts);
  console.log(`Tiers:`, manifest.tiers);
  const byPhone = scored.reduce((a, s) => ((a[s.phone_quality] = (a[s.phone_quality] || 0) + 1), a), {});
  console.log(`Phone quality:`, byPhone);
  const top = scored.filter((s) => s.tier !== "X").sort((a, b) => b.score - a.score).slice(0, 15);
  console.log(`\nTop 15 by score:`);
  for (const t of top) console.log(`  ${String(t.score).padStart(3)} ${t.tier} ${t.route.padEnd(18)} ${t.name} — ${t.title} @ ${t.company} [${t.phone_quality}]`);
});
