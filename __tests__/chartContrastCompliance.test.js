'use strict';

const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function hexToRgb(hex) {
  const value = hex.replace('#', '');
  return [0, 2, 4].map(index => parseInt(value.slice(index, index + 2), 16));
}

function luminance(hex) {
  const channels = hexToRgb(hex).map(value => {
    const normalized = value / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : Math.pow((normalized + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(foreground, background) {
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function token(name) {
  const match = source.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  expect(match).not.toBeNull();
  return match[1];
}

describe('price-history contrast contract (#305H)', () => {
  test.each(['bg', 'surface', 'card'])('%s backgrounds meet 4.5:1 for secondary and muted text', backgroundName => {
    const background = token(backgroundName);
    expect(contrast(token('text-secondary'), background)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token('text-muted'), background)).toBeGreaterThanOrEqual(4.5);
  });

  test.each([
    ['coin line', '#58a6ff'],
    ['median line', '#3fb950'],
    ['outlier marker', '#f85149'],
    ['metal overlay', '#d29922'],
    ['Greysheet wholesale', '#ff7b72'],
    ['Greysheet retail', '#bc8cff'],
  ])('%s has at least 3:1 graphical contrast on the chart background', (_name, foreground) => {
    expect(contrast(foreground, token('card'))).toBeGreaterThanOrEqual(3);
  });

  test('chart labels use the remediated secondary text color', () => {
    expect(source).not.toContain("ctx.fillStyle = '#8b949e'");
    expect(source).not.toContain("ctx.fillStyle = 'rgba(139,148,158,0.8)'");
    expect(source).toContain("text: chartStyles.getPropertyValue('--text-secondary').trim()");
    expect(source).toContain('ctx.fillStyle = CHART_COLORS.text');
  });

  test('canvas is associated with the synchronized summary and table', () => {
    const canvas = source.match(/<canvas id="history-canvas"[^>]*>/);
    expect(canvas).not.toBeNull();
    expect(canvas[0]).toContain('aria-describedby="history-summary history-table-label"');
    expect(source).toContain('<tbody id="history-table-body"></tbody>');
    expect(source).toContain('HistoryAccessibility.createModel(data,');
    expect(source).toContain('drawChart(canvas, data.prices, model)');
  });

  test('history state is announced and stale requests cannot replace current results', () => {
    const status = source.match(/<div id="history-status"[^>]*>/);
    expect(status).not.toBeNull();
    expect(status[0]).toContain('role="status"');
    expect(status[0]).toContain('aria-live="polite"');
    expect(source).toContain("wrap.setAttribute('aria-busy', 'true')");
    expect(source).toContain("wrap.setAttribute('aria-busy', 'false')");
    expect(source).toContain('if (requestId !== requestSequence) return');
    expect(source).toContain("queryEl.addEventListener('input', () => {");
    expect(source).toContain('requestSequence++');
    expect(source).toContain('_btnReset(btn)');
  });

  test('range bands use a solid 3:1 boundary and the legend wraps outside the canvas', () => {
    expect(source).toContain('ctx.strokeStyle = CHART_COLORS.coin');
    expect(source).not.toContain("ctx.strokeStyle = 'rgba(88,166,255,0.30)'");
    expect(source).toContain('.history-legend { display: flex; flex-wrap: wrap;');
    expect(source).toContain('.history-legend li { min-width: 0; overflow-wrap: anywhere; }');
    expect(source).toContain('id="history-legend"');
    expect(source).not.toContain('Legend (top-left, always visible)');
    expect(source).toContain("const GS_DASHES = { wholesale: [7, 3], retail: [2, 4] }");
    expect(source).toContain('border-top: 2px dashed var(--chart-gs-wholesale)');
    expect(source).toContain('border-top: 2px dotted var(--chart-gs-retail)');
    expect(source).toContain('border-top: 2px dashed var(--green)');
    expect(source).toContain('border-top: 2px dashed var(--yellow)');
    expect(source).toContain('border: 1px dashed var(--accent)');
  });

  test('all canvas fills, grids, halos, and labels consume semantic chart tokens', () => {
    const historyRenderer = source.slice(source.indexOf('function drawChart(cvs, prices, accessibleModel)'), source.indexOf('ADMIN PANEL'));
    expect(source).toContain("grid: chartStyles.getPropertyValue('--chart-grid').trim()");
    expect(source).toContain("rangeFill: chartStyles.getPropertyValue('--chart-range-fill').trim()");
    expect(source).toContain("iqrFill: chartStyles.getPropertyValue('--chart-iqr-fill').trim()");
    expect(source).toContain("outlierHalo: chartStyles.getPropertyValue('--chart-outlier-halo').trim()");
    expect(historyRenderer).not.toMatch(/ctx\.(?:fillStyle|strokeStyle) = ['"](?:#|rgba\()/);
    expect(historyRenderer).not.toMatch(/addColorStop\([^,]+, ['"](?:#|rgba\()/);
  });

  test('the wide data table has a labeled keyboard scroll region', () => {
    expect(source).toContain('class="history-data-table-wrap" tabindex="0" role="region" aria-label="Scrollable price history data table"');
    expect(source).toContain('.history-data-table-wrap:focus-visible');
  });
});
