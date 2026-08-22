'use strict';

const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

describe('Lot Evaluator confidence display', () => {
  test('renders confidence zero instead of the missing-data placeholder', () => {
    expect(source).toContain("coin.confidence != null ? coin.confidence : '--'");
  });

  test('exports confidence zero instead of an empty CSV field', () => {
    expect(source).toContain("r.confidence != null ? r.confidence : ''");
  });

  test('visibly labels and exports a low-data single-comp result', () => {
    expect(source).toContain("coin.lowData && coin.compCount === 1");
    expect(source).toContain("<th>Warning</th>");
    expect(source).toContain("'Single comp'");
    expect(source).toContain("'Single-comp estimate; cross-reference dealer prices'");
  });

  test('visibly labels composite estimates in pricing, lot rows, and CSV', () => {
    expect(source).toContain("v.dataSource?.label === 'cross-year-composite'");
    expect(source).toContain("coin.dataSource?.label === 'cross-year-composite'");
    expect(source).toContain("r.dataSource?.label === 'cross-year-composite'");
    expect(source).toContain("isComposite ? 'Nearby-year proxy'");
    expect(source).toContain('Composite estimate; nearby-year sales used as a proxy');
  });

  test('announces progress and structured AI warnings accessibly', () => {
    expect(source).toContain('id="bulk-status" class="muted" role="status" aria-live="polite"');
    expect(source).toContain('role="progressbar" aria-label="Lot evaluation progress"');
    expect(source).toContain("data.provenance?.valuation?.warning");
    expect(source).toContain("warning.setAttribute('role', 'alert')");
  });
});