// src/score.js — QUALIFY stage. Five-signal weighted rubric + hard gates + SELL/NURTURE routing.
const cfg = require("../config/icp.json");
const W = cfg.scoring_weights;
const NOW = () => new Date();

// ---------- Age estimation (age is not searchable; everything is a proxy) ----------
function estimateAge(c) {
  // CONFIRMED: explicit DOB or verified age from Stage-2 enrichment (Whitepages / LinkedIn verify)
  if (c.dob) {
    const age = (NOW() - new Date(c.dob)) / (365.25 * 864e5);
    return { age, basis: "CONFIRMED", dob: c.dob };
  }
  if (c.verified_age) return { age: Number(c.verified_age), basis: "CONFIRMED", dob: null };
  // INFERRED: college graduation year (grad ~age 22)
  const grad = c.collegeGradYear ?? c.educationGradYear;
  if (grad) return { age: NOW().getFullYear() - grad + 22, basis: "INFERRED", dob: null };
  // INFERRED: earliest position start (career start ~age 23)
  const careerStart = c.earliestPositionStartYear;
  if (careerStart) return { age: NOW().getFullYear() - careerStart + 23, basis: "INFERRED", dob: null };
  return { age: null, basis: "UNKNOWN", dob: null };
}

// maturity_date = DOB + 59.5 years (only computable when CONFIRMED with DOB)
function maturityDate(dob) {
  const d = new Date(dob);
  d.setMonth(d.getMonth() + Math.round(59.5 * 12));
  return d.toISOString().slice(0, 10);
}

// ---------- Signal scores, 0-100 each ----------
function sMonthsSinceChange(m) {
  if (m == null) return 40;
  if (m < 6) return 35;          // too fresh — still in new-job honeymoon
  if (m <= 12) return 75;
  if (m <= 48) return 100;       // peak orphaned-401(k) window
  if (m <= 72) return 70;
  return 45;
}
function sPriorJobs(jobs) {
  // jobs: [{years}] — long-tenure prior stints = vested orphans; hopping = never vested
  if (!jobs?.length) return 30;                      // lifelong single employer — nothing orphaned
  const longTenure = jobs.filter((j) => (j.years ?? 0) >= 3).length;
  const hops = jobs.filter((j) => (j.years ?? 0) < 3).length;
  let s = 50 + longTenure * 15 - hops * 10;
  return Math.max(0, Math.min(100, s));
}
function sEmployerSize(n) {
  if (n == null) return 50;
  if (n >= 5000) return 100;     // big plans, big balances
  if (n >= 1000) return 85;
  if (n >= 250) return 70;
  if (n >= 50) return 55;
  return 40;
}
function sSalary(est) {
  if (est == null) return 50;
  if (est >= 300000) return 100;
  if (est >= 200000) return 85;
  if (est >= 150000) return 70;
  if (est >= 100000) return 55;
  return 35;
}
function sSeniority(c) {
  const t = `${c.jobTitle ?? ""} ${c.managementLevel ?? ""}`.toLowerCase();
  if (/chief|ceo|cfo|coo|cio|founder|owner|president|managing director|partner/.test(t)) return 100;
  if (/c level/.test(t)) return 95;
  if (/evp|svp|vp level|vice president|principal|head of/.test(t)) return 80;
  if (/doctor|physician|md\b|attorney|lawyer|counsel/.test(t)) return 85;
  if (/senior|director/.test(t)) return 60;
  return 30;
}
function downscore(c) {
  const t = `${c.jobTitle ?? ""} ${c.companyName ?? ""} ${c.industry ?? ""}`.toLowerCase();
  let d = 0;
  if (/government|federal|state of|county of|city of|municipal/.test(t)) d += 20; // pensions, not 401(k)s
  if (/army|navy|air force|marine|military|dod\b/.test(t)) d += 20;
  return d;
}

// ---------- Asset inference (Gate 4: >= $250k, all proxy) ----------
function inferAssets(c, signals) {
  // Heuristic: comp x tenure-driven accumulation. Marked INFERRED always.
  const comp = c.estimatedSalary ?? null;
  const tenureYrs = c.totalCareerYears ?? null;
  if (comp && tenureYrs) {
    const est = comp * 0.10 * Math.min(tenureYrs, 30) * 1.5; // 10% deferral, growth factor
    return { estimate: Math.round(est), passes: est >= 250000, basis: "INFERRED" };
  }
  // Fallback: seniority + employer size as coarse pass
  const coarse = signals.seniority >= 80 && signals.employer_size >= 70;
  return { estimate: null, passes: coarse, basis: coarse ? "INFERRED" : "UNKNOWN" };
}

// ---------- Main ----------
function scoreLead(c) {
  const ageInfo = estimateAge(c);
  const signals = {
    months_since_job_change: sMonthsSinceChange(c.monthsSinceJobChange),
    prior_jobs_count: sPriorJobs(c.priorJobs),
    employer_size: sEmployerSize(c.companyEmployees),
    salary_benchmark: sSalary(c.estimatedSalary),
    seniority: sSeniority(c),
  };
  const assets = inferAssets(c, signals);

  let score = Object.entries(W).reduce((sum, [k, w]) => sum + signals[k] * w, 0);
  score = Math.max(0, Math.round(score - downscore(c)));

  // Hard gates
  const gates = {
    location: true, // enforced upstream in search.js
    seniority: signals.seniority >= 60,
    age_floor: ageInfo.basis === "UNKNOWN" ? null : ageInfo.age >= 55 || c.retired === true,
    assets: assets.passes,
  };
  const failed = Object.entries(gates).filter(([, v]) => v === false).map(([k]) => k);

  let tier;
  if (failed.length) tier = "X";
  else if (score >= cfg.tiers.A) tier = "A";
  else if (score >= cfg.tiers.B) tier = "B";
  else tier = "C";

  // SELL vs NURTURE routing
  let route = "HOLD_UNKNOWN_AGE";
  let maturity = null;
  if (ageInfo.age != null) {
    if (ageInfo.age >= 59.5) route = "SELL";
    else if (ageInfo.age >= 55) {
      route = "NURTURE";
      maturity = ageInfo.dob
        ? maturityDate(ageInfo.dob)
        : new Date(Date.now() + (59.5 - ageInfo.age) * 365.25 * 864e5).toISOString().slice(0, 10);
    } else route = "DISQUALIFIED_UNDER_55";
  }
  if (tier === "X") route = "DISQUALIFIED";

  return {
    id: c.id, name: `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim(),
    title: c.jobTitle ?? null, company: c.companyName ?? null, state: c.state ?? null,
    score, tier, route, maturity_date: maturity,
    age_estimate: ageInfo.age ? Math.round(ageInfo.age * 10) / 10 : null,
    age_basis: ageInfo.basis,
    asset_estimate: assets.estimate, asset_basis: assets.basis,
    signals, gates_failed: failed,
    scored_at: new Date().toISOString(),
  };
}

module.exports = { scoreLead, estimateAge, maturityDate };
