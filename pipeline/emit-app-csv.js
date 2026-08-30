#!/usr/bin/env node
// emit-app-csv.js — converts pipeline output (scored JSON) into a CSV whose headers
// AUTO-MAP in the Lead Qualifier app's import dialog (FIELDS synonym table).
// Usage: node emit-app-csv.js out/<runId>_sell.json out/<runId>_sell_app.csv
const fs = require("fs");

// Header names chosen to hit the app's synonym matcher exactly:
const HEADERS = [
  ["ZoomInfo Contact ID", (l) => l.id],
  ["First Name", (l) => (l.name || "").split(" ")[0]],
  ["Last Name", (l) => (l.name || "").split(" ").slice(1).join(" ")],
  ["Email Address", (l) => l.email || ""],
  ["Direct Phone Number", (l) => l.directPhone || ""],
  ["Mobile Phone", (l) => l.mobilePhone || ""],
  ["Job Title", (l) => l.title || ""],
  ["Management Level", (l) => l.mgmtLevel || l.managementLevel || ""],
  ["Company Name", (l) => l.company || ""],
  ["Person State", (l) => l.state || ""],
  ["Person Street", (l) => l.street || ""],
  ["Person City", (l) => l.city || ""],
  ["Person Zip Code", (l) => l.zip || ""],
  ["Job Start Date", (l) => l.jobStartDate || ""],
  ["Graduation Year", (l) => l.gradYear || ""],
  ["LinkedIn Contact Profile URL", (l) => l.linkedinUrl || ""],
  ["Number of Employees", (l) => l.employees || ""],
  ["Mobile Phone Do Not Call", (l) => l.mobileDnc ?? ""],
  ["Direct Phone Do Not Call", (l) => l.directDnc ?? ""],
  // Extra pipeline columns — the app mapper shows them as "— skip —" or map into notes:
  ["Route", (l) => l.route || ""],
  ["Maturity Date", (l) => l.maturity_date || ""],
  ["Age Basis", (l) => l.age_basis || ""],
  ["Pipeline Score", (l) => l.score ?? ""],
];

const esc = (v) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

const [, , input, output] = process.argv;
const leads = JSON.parse(fs.readFileSync(input, "utf8"));
const rows = [HEADERS.map(([h]) => h).join(",")];
for (const l of leads) rows.push(HEADERS.map(([, fn]) => esc(fn(l))).join(","));
fs.writeFileSync(output, rows.join("\n"));
console.log(`Wrote ${leads.length} leads → ${output} (headers auto-map in Lead Qualifier import)`);
