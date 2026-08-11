'use strict';

const path = require('path');
const {
  analyzeJestResult,
  renderMarkdown,
  parseArgs,
} = require('../scripts/test-metrics/analyze-slow-tests.cjs');

function fixture() {
  const startedAt = 1000;
  return {
    startTime: startedAt,
    endTime: startedAt + 65000,
    testResults: [
      {
        name: path.join(process.cwd(), '__tests__', 'fast.test.js'),
        startTime: startedAt,
        endTime: startedAt + 1000,
        assertionResults: [{ title: 'fast case', fullName: 'fast case', duration: 25 }],
      },
      {
        name: path.join(process.cwd(), '__tests__', 'slow.test.js'),
        startTime: startedAt,
        endTime: startedAt + 7000,
        assertionResults: [
          { title: 'medium case', fullName: 'slow medium case', duration: 600 },
          { title: 'slow case', fullName: 'slow slow case', duration: 1500 },
        ],
      },
    ],
  };
}

describe('slow test analyzer', () => {
  test('ranks suites and tests while calculating runtime budgets', () => {
    const analysis = analyzeJestResult(fixture(), 20);

    expect(analysis).toMatchObject({
      runtimeMs: 65000,
      budgetMs: 60000,
      overBudgetMs: 5000,
      suiteCount: 2,
      testCount: 3,
      suitesOverBudget: 1,
      testsOverBudget: 2,
    });
    expect(analysis.slowestSuites.map(item => item.file)).toEqual([
      '__tests__/slow.test.js',
      '__tests__/fast.test.js',
    ]);
    expect(analysis.slowestTests.map(item => item.name)).toEqual([
      'slow slow case',
      'slow medium case',
      'fast case',
    ]);
  });

  test('renders a markdown report with budget and ranking tables', () => {
    const markdown = renderMarkdown(analyzeJestResult(fixture(), 1), 'baseline.json');

    expect(markdown).toContain('Jest suite span: 65.0s (full-run budget: 60s)');
    expect(markdown).toContain('separate wall-clock measurement');
    expect(markdown).toContain('`__tests__/slow.test.js`');
    expect(markdown).toContain('slow slow case');
    expect(markdown).not.toContain('fast case');
  });

  test('parses CLI file, output, and limit arguments', () => {
    expect(parseArgs(['--jest-json', 'input.json', '--out', 'report.md', '--limit', '15'])).toEqual({
      jestJson: 'input.json',
      out: 'report.md',
      limit: 15,
    });
  });

  test('uses the suite timing span when root timing is absent', () => {
    const input = fixture();
    delete input.startTime;
    delete input.endTime;

    expect(analyzeJestResult(input).runtimeMs).toBe(7000);
  });
});