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

  test('visibly labels a low-data single-comp result', () => {
    expect(source).toContain("coin.lowData && coin.compCount === 1");
    expect(source).toContain("(WARNING: single comp)");
  });
});