// src/search.js — SOURCE stage. Wraps the GTM CLI (free searches, no credits).
// Requires: `gtm` CLI installed + authenticated (service-account creds via env for unattended runs).
const { execFileSync } = require("child_process");

function gtmJSON(args) {
  const raw = execFileSync("gtm", [...args, "-f", "json"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: process.env,
  });
  return deepParse(raw);
}

// ZoomInfo responses are frequently double-encoded — parse until stable.
function deepParse(x) {
  let v = x;
  for (let i = 0; i < 5; i++) {
    if (typeof v !== "string") break;
    try { v = JSON.parse(v); } catch { break; }
  }
  return v;
}

// Search results nest contacts under an `attributes` wrapper — flatten before normalizing.
function flatten(resp) {
  const rows = resp?.data ?? resp ?? [];
  return (Array.isArray(rows) ? rows : []).map((r) => ({
    id: r.id ?? r?.attributes?.id,
    ...(r.attributes ?? r),
  }));
}

/**
 * Run one ICP search slice. managementLevel must be EXACT enum strings:
 * "C Level Exec" / "VP Level Exec" — anything else silently fails.
 */
function searchContacts({ managementLevel, state, titleKeyword, pageSize = 100, page = 1 }) {
  const args = ["contacts", "search", "--location-search-type", "Person", "--country", "United States", "--page-size", String(pageSize), "--page", String(page)];
  if (managementLevel) args.push("--management-level", managementLevel);
  if (state) args.push("--state", state);
  if (titleKeyword) args.push("--title", titleKeyword);
  return flatten(gtmJSON(args));
}

/** ENRICH stage — COSTS CREDITS. Only called behind the credit gate. */
function enrichContact(id) {
  return flatten(gtmJSON(["contacts", "enrich", "--id", String(id)]))[0] ?? null;
}

const EXCLUDED_STATES = new Set(["CT", "Connecticut", "MA", "Massachusetts"]);
function passesLocationGate(c) {
  const st = c.state ?? c.personState ?? c.location?.state ?? "";
  return !EXCLUDED_STATES.has(st);
}

module.exports = { searchContacts, enrichContact, passesLocationGate, deepParse, flatten };
