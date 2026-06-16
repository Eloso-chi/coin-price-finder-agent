// Cross-tab: composition x action with priority breakdown.
// Read-only inspection of cache/freshness-report.json.
const path = require('path');
const fs = require('fs');

const reportPath = path.join(__dirname, '..', 'cache', 'freshness-report.json');
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const datasets = report.datasets || [];

const REFRESH_ACTIONS = new Set(['refresh', 'monitor-refresh', 'initial-fetch', 'deep-paginate', 'evidence-probe']);
const SKIP_ACTIONS = new Set(['ok', 'dormant', 'recently-confirmed-stale', 'thin-wait', 'dry-refresh-backoff', 'confirmed-thin-skip', 'evidence-low-vol']);

// Build composition x action matrix
const byComp = new Map();
const allActions = new Set();
for (const d of datasets) {
  const comp = d.composition || 'unknown';
  const acts = d.actions && d.actions.length ? d.actions : ['(none)'];
  if (!byComp.has(comp)) byComp.set(comp, { total: 0, actions: {}, p0: 0, p1: 0, p2: 0, p3: 0, refreshActionable: 0, skipped: 0, sampleStale: [] });
  const row = byComp.get(comp);
  row.total += 1;
  for (const a of acts) {
    allActions.add(a);
    row.actions[a] = (row.actions[a] || 0) + 1;
  }
  if (d.priority === 'P0') row.p0 += 1;
  else if (d.priority === 'P1') row.p1 += 1;
  else if (d.priority === 'P2') row.p2 += 1;
  else if (d.priority === 'P3') row.p3 += 1;

  const isRefresh = acts.some(a => REFRESH_ACTIONS.has(a));
  if (isRefresh) row.refreshActionable += 1;
  else row.skipped += 1;

  if (isRefresh && (d.staleDays || 0) >= 60 && d.compCount >= 10) {
    row.sampleStale.push({ key: d.key, staleDays: d.staleDays, comps: d.compCount, lastRefreshDays: d.lastRefreshDays, refreshCount: d.refreshCount });
  }
}

const actionsList = Array.from(allActions).sort();

// Header
console.log('Composition x Actionability (refresh queue vs excluded)');
console.log('='.repeat(110));
console.log(
  'composition'.padEnd(28) +
  'total'.padStart(7) +
  'refresh-q'.padStart(11) +
  'skipped'.padStart(9) +
  'P0'.padStart(6) + 'P1'.padStart(6) + 'P2'.padStart(5) + 'P3'.padStart(6) +
  '  refresh-yield'
);
console.log('-'.repeat(110));

const rows = Array.from(byComp.entries()).sort((a, b) => b[1].refreshActionable - a[1].refreshActionable);
for (const [comp, r] of rows) {
  const yieldPct = r.total ? Math.round((r.refreshActionable / r.total) * 100) : 0;
  console.log(
    comp.padEnd(28) +
    String(r.total).padStart(7) +
    String(r.refreshActionable).padStart(11) +
    String(r.skipped).padStart(9) +
    String(r.p0).padStart(6) +
    String(r.p1).padStart(6) +
    String(r.p2).padStart(5) +
    String(r.p3).padStart(6) +
    '  ' + yieldPct + '%'
  );
}

console.log('');
console.log('Per-composition action distribution (only nonzero actions shown)');
console.log('='.repeat(110));
for (const [comp, r] of rows) {
  const parts = Object.entries(r.actions).sort((a, b) => b[1] - a[1]).map(([a, n]) => `${a}=${n}`);
  console.log(`${comp.padEnd(28)} ${parts.join('  ')}`);
}

console.log('');
console.log('Sample actionable stale entries (>=60d, >=10 comps) per composition (max 5 each)');
console.log('='.repeat(110));
for (const [comp, r] of rows) {
  if (!r.sampleStale.length) continue;
  r.sampleStale.sort((a, b) => b.staleDays - a.staleDays);
  console.log(`-- ${comp} (${r.sampleStale.length} actionable stale)`);
  for (const s of r.sampleStale.slice(0, 5)) {
    console.log(`   ${String(s.staleDays).padStart(4)}d  ${String(s.comps).padStart(4)}c  lastRefresh=${s.lastRefreshDays ?? 'null'}d  refreshCount=${s.refreshCount ?? 0}  ${s.key}`);
  }
}
