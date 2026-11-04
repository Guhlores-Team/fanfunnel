// Latency samples, tallies and pass/fail bookkeeping shared by the DB and HTTP
// stress scenarios. A scenario records invariant checks (hard: any failure
// fails the run), latency series with a p95 threshold (hard unless
// STRESS_SOFT_LATENCY=1 turns a breach into a warning) and free-form numbers
// for the results document.
export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

export function summarize(values) {
  if (!values.length) return { n: 0, p50: null, p95: null, max: null, mean: null };
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return { n: values.length, p50: round(percentile(values, 50)), p95: round(percentile(values, 95)), max: round(Math.max(...values)), mean: round(mean) };
}
const round = v => v == null ? null : Math.round(v * 10) / 10;

/** Run `fn` for each item with at most `limit` in flight; returns settled results in order. */
export async function parallel(items, limit, fn) {
  const out = new Array(items.length); let next = 0;
  const worker = async () => { for (;;) { const i = next++; if (i >= items.length) return; try { out[i] = { ok: true, value: await fn(items[i], i) }; } catch (e) { out[i] = { ok: false, error: e?.message ?? String(e), code: e?.code ?? null, detail: e?.detail ?? null }; } } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Time one async call; appends milliseconds to `series`. */
export async function timed(series, fn) {
  const t = process.hrtime.bigint();
  try { return await fn(); } finally { series.push(Number(process.hrtime.bigint() - t) / 1e6); }
}

export const tally = (results, pick) => {
  const counts = {};
  for (const r of results) { const k = r.ok ? pick(r.value) : `error:${r.code ?? "?"}`; counts[k] = (counts[k] ?? 0) + 1; }
  return counts;
};

export class Report {
  constructor({ softLatency = process.env.STRESS_SOFT_LATENCY === "1", strict = process.env.STRESS_STRICT === "1", log = console.log } = {}) {
    this.scenarios = []; this.softLatency = softLatency; this.strict = strict; this.log = log; this.current = null;
  }
  /** A documented defect (see STRESS_RESULTS.md): a KNOWN-BUG line by default, a failing check with STRESS_STRICT=1. */
  known(id, ok, label, detail) {
    if (ok || this.strict) return this.check(ok, `${label} [${id}]`, detail);
    this.current.known.push({ id, label, detail: detail ?? null });
    this.log(`  KNOWN-BUG ${id}: ${label}${detail != null ? ` (${detail})` : ""}`);
    return false;
  }
  scenario(id, title) {
    const s = { id, title, checks: [], latencies: [], numbers: {}, warnings: [], known: [], startedAt: Date.now(), ms: null };
    this.scenarios.push(s); this.current = s; this.log(`\n== ${id} ${title}`); return s;
  }
  /** Hard invariant: a false value fails the run. */
  check(ok, label, detail) {
    const s = this.current; s.checks.push({ ok: !!ok, label, detail: detail ?? null });
    this.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail != null ? ` (${typeof detail === "string" ? detail : JSON.stringify(detail)})` : ""}`);
    return !!ok;
  }
  /** Latency series with a p95 ceiling in ms. */
  latency(label, values, p95Max, extra = {}) {
    const s = this.current, sum = summarize(values), ok = sum.p95 == null || sum.p95 <= p95Max;
    s.latencies.push({ label, ...sum, p95Max, ok: ok || this.softLatency, breached: !ok, ...extra });
    this.log(`  ${ok ? "lat " : this.softLatency ? "slow" : "FAIL"} ${label}: n=${sum.n} p50=${sum.p50}ms p95=${sum.p95}ms max=${sum.max}ms (p95 <= ${p95Max}ms)`);
    return ok;
  }
  number(key, value) { this.current.numbers[key] = value; this.log(`  ${key} = ${typeof value === "object" ? JSON.stringify(value) : value}`); }
  warn(text) { this.current.warnings.push(text); this.log(`  warn ${text}`); }
  finish() { const s = this.current; s.ms = Date.now() - s.startedAt; this.log(`  -- ${s.ms}ms`); this.current = null; }
  get failures() {
    const out = [];
    for (const s of this.scenarios) {
      for (const c of s.checks) if (!c.ok) out.push(`${s.id}: ${c.label}${c.detail != null ? ` (${typeof c.detail === "string" ? c.detail : JSON.stringify(c.detail)})` : ""}`);
      for (const l of s.latencies) if (!l.ok) out.push(`${s.id}: ${l.label} p95 ${l.p95}ms > ${l.p95Max}ms`);
    }
    return out;
  }
  get knownBugs() { return this.scenarios.flatMap(s => s.known.map(k => `${s.id}: ${k.id}: ${k.label}${k.detail ? ` (${k.detail})` : ""}`)); }
  toJSON() { return { generatedAt: new Date().toISOString(), softLatency: this.softLatency, strict: this.strict, failures: this.failures, knownBugs: this.knownBugs, scenarios: this.scenarios }; }
  /** Markdown table rows for STRESS_RESULTS.md. */
  markdown() {
    const lines = ["| Scenario | Checks | Latency (p50 / p95 / max ms, n) | Result |", "|---|---|---|---|"];
    for (const s of this.scenarios) {
      const bad = s.checks.filter(c => !c.ok).length, lat = s.latencies.map(l => `${l.label}: ${l.p50} / ${l.p95} / ${l.max} (${l.n})${l.breached ? " BREACH" : ""}`).join("<br>");
      lines.push(`| ${s.id} ${s.title} | ${s.checks.length - bad}/${s.checks.length} | ${lat || "-"} | ${bad || s.latencies.some(l => !l.ok) ? "FAIL" : s.known.length ? `pass (${s.known.length} known bug)` : "pass"} |`);
    }
    return lines.join("\n");
  }
}
