'use strict';

const childProcess = require('node:child_process');
const path = require('node:path');
const {
  analyzeExplicitWeights,
  analyzeExplicitWeightSources,
  extractExplicitWeights,
  hasContradictoryWeights,
  hasContradictoryWeightSources,
} = require('../src/utils/explicitWeight');

const PARITY_CASES = [
  ['1 oz tenth anniversary silver eagle', [1], false],
  ['1 oz quarter dollar', [1], false],
  ['2010 half libertad mexican oz silver', [0.5], false],
  ['1oz 2010 half libertad mexican oz silver', [0.5, 1], true],
  ['oz quarter', [0.25], false],
  ['American Gold Eagle half oz', [0.5], false],
  ['1 oz half dollar half oz', [0.5, 1], true],
  ['1 oz Walking Liberty half-ounce silver', [0.5, 1], true],
  ['1oz quarter silver', [0.25, 1], true],
  ['1/2 oz half ounce Silver Libertad', [0.5], false],
  ['3/4 oz Silver Maple Leaf', [0.75], false],
  ['1 1/2 oz Silver Libertad', [1.5], false],
  ['1 1/2 oz and 1.5 oz Silver Libertad', [1.5], false],
  ['1/2 oz and 1 ozt Silver Libertad', [0.5, 1], true],
  ['2 ozt Silver Bar', [2], false],
  ['one ozt Silver Eagle', [1], false],
  ['0 oz silver', [], true],
  ['2010 1/2 oz Silver Libertad', [0.5], false],
  ['2022 1 1/2 oz Silver Libertad', [1.5], false],
];

describe('explicit weight analysis', () => {
  test.each(PARITY_CASES)('classifies %s', (term, weights, contradictory) => {
    expect(extractExplicitWeights(term)).toEqual(weights);
    expect(hasContradictoryWeights(term)).toBe(contradictory);
  });

  test('bounds overly long terms', () => {
    expect(analyzeExplicitWeights(`${'x'.repeat(500)}1 oz`)).toEqual({ weights: [], invalid: true });
  });

  test('analyzes canonical keys independently from benign display labels', () => {
    expect(analyzeExplicitWeightSources('1 oz silver tenth', 'Silver Eagle')).toEqual({
      weights: [0.1, 1],
      invalid: false,
    });
    expect(hasContradictoryWeightSources('1 oz silver tenth', 'Silver Eagle')).toBe(true);
  });

  test.each([
    '1 oz tenth anniversary silver eagle',
    '1 oz quarter dollar',
    '1 oz tenth anniversary edition silver eagle',
  ])('does not interpret descriptive denomination words as weights: %s', term => {
      expect(extractExplicitWeights(term)).toEqual([1]);
      expect(hasContradictoryWeights(term)).toBe(false);
    });
});

describe('Python explicit weight parity', () => {
  test.each(PARITY_CASES)('matches JavaScript for %s', (term, weights, contradictory) => {
    const helperPath = path.join(__dirname, '..', 'scripts', '_explicit_weight.py');
    const helperArgument = process.platform === 'win32'
      ? helperPath.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`)
      : helperPath;
    const snippet = [
      'import importlib.util, json, sys',
      'spec = importlib.util.spec_from_file_location("explicit_weight", sys.argv[1])',
      'module = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'term = json.loads(sys.argv[2])',
      'print(json.dumps([module.extract_explicit_weights(term), module.has_contradictory_weights(term)]))',
    ].join('; ');
    const command = process.platform === 'win32' ? 'wsl' : 'python3';
    const args = process.platform === 'win32'
      ? ['python3', '-c', snippet, helperArgument, JSON.stringify(term)]
      : ['-c', snippet, helperArgument, JSON.stringify(term)];
    const result = childProcess.spawnSync(command, args, { encoding: 'utf8' });

    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    expect(JSON.parse(result.stdout)).toEqual([weights, contradictory]);
  });
});
