'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_LIMIT = 20;
const SUITE_BUDGET_MS = 5000;
const TEST_BUDGET_MS = 500;
const FULL_BUDGET_MS = 60000;

function normalizeFile(file) {
  return path.relative(ROOT, file).replaceAll('\\', '/');
}

function analyzeJestResult(jestData, limit = DEFAULT_LIMIT) {
  const suites = (jestData.testResults || []).map(suite => ({
    file: normalizeFile(suite.name),
    durationMs: Math.max(0, (suite.endTime || 0) - (suite.startTime || 0)),
  })).sort((a, b) => b.durationMs - a.durationMs);

  const tests = [];
  for (const suite of (jestData.testResults || [])) {
    for (const test of (suite.assertionResults || [])) {
      if (typeof test.duration === 'number') {
        tests.push({
          file: normalizeFile(suite.name),
          name: test.fullName || test.title,
          durationMs: test.duration,
        });
      }
    }
  }
  tests.sort((a, b) => b.durationMs - a.durationMs);

  const suiteStarts = (jestData.testResults || []).map(item => item.startTime).filter(Number.isFinite);
  const suiteEnds = (jestData.testResults || []).map(item => item.endTime).filter(Number.isFinite);
  const suiteSpanMs = suiteStarts.length && suiteEnds.length
    ? Math.max(...suiteEnds) - Math.min(...suiteStarts)
    : 0;
  const runtimeMs = Number(jestData.runExecError ? 0 : jestData.durationMs)
    || Math.max(0, (jestData.endTime || 0) - (jestData.startTime || 0))
    || suiteSpanMs;
  return {
    runtimeMs,
    budgetMs: FULL_BUDGET_MS,
    overBudgetMs: Math.max(0, runtimeMs - FULL_BUDGET_MS),
    suiteCount: suites.length,
    testCount: tests.length,
    suitesOverBudget: suites.filter(item => item.durationMs > SUITE_BUDGET_MS).length,
    testsOverBudget: tests.filter(item => item.durationMs > TEST_BUDGET_MS).length,
    slowestSuites: suites.slice(0, limit),
    slowestTests: tests.slice(0, limit),
  };
}

function renderMarkdown(analysis, source) {
  const lines = [
    '# Test Runtime Analysis',
    '',
    `Source: \`${source}\``,
    '',
    `- Jest suite span: ${(analysis.runtimeMs / 1000).toFixed(1)}s (full-run budget: ${(analysis.budgetMs / 1000).toFixed(0)}s)`,
    `- Minimum over budget: ${(analysis.overBudgetMs / 1000).toFixed(1)}s`,
    `- Suites: ${analysis.suiteCount} total, ${analysis.suitesOverBudget} over 5s`,
    `- Tests: ${analysis.testCount} timed, ${analysis.testsOverBudget} over 500ms`,
    '- Note: process startup, teardown, and reporting require a separate wall-clock measurement.',
    '',
    '## Slowest Suites',
    '',
    '| Rank | Suite | Duration |',
    '|---:|---|---:|',
    ...analysis.slowestSuites.map((item, index) =>
      `| ${index + 1} | \`${item.file}\` | ${(item.durationMs / 1000).toFixed(2)}s |`),
    '',
    '## Slowest Tests',
    '',
    '| Rank | Test | File | Duration |',
    '|---:|---|---|---:|',
    ...analysis.slowestTests.map((item, index) =>
      `| ${index + 1} | ${item.name} | \`${item.file}\` | ${(item.durationMs / 1000).toFixed(2)}s |`),
    '',
  ];
  return lines.join('\n');
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--jest-json') args.jestJson = argv[++index];
    else if (arg === '--out') args.out = argv[++index];
    else if (arg === '--limit') args.limit = Number(argv[++index]);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.jestJson) {
    console.error('Usage: npm run test:analyze -- --jest-json <path> [--out <path>] [--limit 20]');
    process.exitCode = 2;
    return;
  }
  const inputPath = path.resolve(args.jestJson);
  const analysis = analyzeJestResult(JSON.parse(fs.readFileSync(inputPath, 'utf8')), args.limit || DEFAULT_LIMIT);
  const markdown = renderMarkdown(analysis, path.basename(inputPath));
  if (args.out) {
    const outputPath = path.resolve(args.out);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, markdown, 'utf8');
    console.log(`[test-analyze] Wrote ${outputPath}`);
  } else {
    console.log(markdown);
  }
}

if (require.main === module) main();

module.exports = { analyzeJestResult, renderMarkdown, parseArgs };