/**
 * @jest-environment jsdom
 */
/* global document */

'use strict';

const HistoryAccessibility = require('../public/js/history-accessibility');

describe('accessible price-history equivalent (#305H)', () => {
  const data = {
    displayName: '1881-S Morgan Dollar MS63',
    prices: [
      ['2026-08-01', 100, 101, 90, 110, 3],
      ['2026-08-02', 102, 103, 95, 112, 4],
      ['2026-08-03', 104, 104, 98, 115, 2],
      ['2026-08-04', 106, 107, 100, 120, 5],
      ['2026-08-05', 180, 175, 165, 190, 1],
    ],
    metalOverlay: {
      metal: 'silver',
      prices: [['2026-08-01', 29], ['2026-08-03', 30], ['2026-08-06', 31]],
    },
    greysheetOverlay: {
      wholesale: [['2026-08-01', 95], ['2026-08-06', 98]],
      retail: null,
      current: { wholesale: 98, retail: 125 },
    },
  };

  test('derives summary statistics and chart outliers from the exact plotted prices', () => {
    const model = HistoryAccessibility.createModel(data, 'Last 90 days');

    expect(model.name).toBe(data.displayName);
    expect(model.pointCount).toBe(5);
    expect(model.sales).toBe(15);
    expect(model.overallMedian).toBe(104);
    expect(model.low).toBe(90);
    expect(model.high).toBe(190);
    expect(model.outlierCount).toBe(1);
    expect(model.rows.find(row => row.date === '2026-08-05').outlier).toBe(true);
    expect(model.thresholds).toEqual({ q1: 102, q3: 106, outlierLow: 96, outlierHigh: 112 });
  });

  test('includes the union of coin, metal, and Greysheet dates without inventing trend values', () => {
    const model = HistoryAccessibility.createModel(data, 'Last 90 days');

    expect(model.rows.map(row => row.date)).toEqual([
      '2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06',
    ]);
    expect(model.rows.find(row => row.date === '2026-08-03').metal).toBe(30);
    expect(model.rows.find(row => row.date === '2026-08-02').metal).toBeNull();
    expect(model.rows.find(row => row.date === '2026-08-06')).toMatchObject({
      median: null,
      metal: 31,
      wholesale: 98,
      retail: null,
    });
  });

  test('represents flat single-point overlays on each plotted coin date', () => {
    const model = HistoryAccessibility.createModel({
      displayName: 'Silver Eagle',
      prices: data.prices.slice(0, 2),
      metalOverlay: { metal: 'silver', prices: [['2026-08-01', 30]] },
      greysheetOverlay: { wholesale: null, retail: null, current: { wholesale: 50, retail: 55 } },
    }, 'Last 90 days');

    expect(model.rows).toHaveLength(2);
    expect(model.rows[1]).toMatchObject({ metal: 30, wholesale: 50, retail: 55 });
    expect(model.metalSeries).toEqual({
      flat: true,
      points: [['2026-08-01', 30], ['2026-08-02', 30]],
    });
  });

  test('normalizes a two-point metal overlay to the same flat series the chart renders', () => {
    const model = HistoryAccessibility.createModel({
      displayName: 'Silver Eagle',
      prices: data.prices.slice(0, 4),
      metalOverlay: { metal: 'silver', prices: [['2026-07-01', 28], ['2026-07-02', 31]] },
    }, 'Last 90 days');

    expect(model.metalSeries).toEqual({
      flat: true,
      points: [['2026-08-01', 31], ['2026-08-04', 31]],
    });
    expect(model.allDates).toEqual(['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04']);
  });

  test('normalizes one differing Greysheet history point to the current plotted reference', () => {
    const model = HistoryAccessibility.createModel({
      displayName: 'Morgan Dollar',
      prices: data.prices.slice(0, 2),
      greysheetOverlay: {
        wholesale: [['2026-07-01', 80]],
        retail: null,
        current: { wholesale: 95, retail: null },
      },
    }, 'Last 90 days');

    expect(model.wholesaleSeries).toEqual({
      flat: true,
      points: [['2026-08-01', 95], ['2026-08-02', 95]],
    });
    expect(model.rows.every(row => row.wholesale === 95)).toBe(true);
  });

  test('describes historical Greysheet series when no current reference exists', () => {
    document.body.innerHTML = '<div id="summary" hidden></div><details id="details" hidden><table><tbody id="body"></tbody></table></details><ul id="legend" hidden></ul>';
    const elements = {
      summary: document.getElementById('summary'),
      details: document.getElementById('details'),
      tbody: document.getElementById('body'),
      legend: document.getElementById('legend'),
    };
    const model = HistoryAccessibility.createModel({
      displayName: 'Morgan Dollar',
      prices: data.prices.slice(0, 2),
      greysheetOverlay: {
        wholesale: [['2026-08-01', 90], ['2026-08-02', 94]],
        retail: null,
        current: { wholesale: null, retail: null },
      },
    }, 'Last 90 days');

    HistoryAccessibility.render(model, elements);

    expect(elements.summary.textContent).toContain('Current Greysheet reference data is not available');
    expect(elements.summary.textContent).toContain('Greysheet wholesale plotted range $90.00 to $94.00');
    expect(elements.summary.textContent).not.toContain('No Greysheet series is plotted');
  });

  test('renders a live summary and complete semantic table using text-only DOM APIs', () => {
    document.body.innerHTML = [
      '<div id="summary" hidden></div>',
      '<details id="details" hidden><table><tbody id="body"></tbody></table></details>',
      '<ul id="legend" hidden></ul>',
    ].join('');
    const elements = {
      summary: document.getElementById('summary'),
      details: document.getElementById('details'),
      tbody: document.getElementById('body'),
      legend: document.getElementById('legend'),
    };
    const model = HistoryAccessibility.createModel(data, 'Last 90 days');

    HistoryAccessibility.render(model, elements);

    expect(elements.summary.hidden).toBe(false);
    expect(elements.summary.textContent).toContain('5 daily price points representing 15 sales');
    expect(elements.summary.textContent).toContain('Overall median $104.00');
    expect(elements.summary.textContent).toContain('1 daily median outside');
    expect(elements.summary.textContent).toContain('Silver spot overlay ranges from $29.00 to $31.00 per ounce');
    expect(elements.summary.textContent).toContain('wholesale $98.00; retail $125.00');
    expect(elements.details.hidden).toBe(false);
    expect(elements.tbody.rows).toHaveLength(model.rows.length);
    expect(elements.tbody.rows[0].cells).toHaveLength(10);
    expect(elements.tbody.rows[0].cells[0].tagName).toBe('TH');
    expect(elements.tbody.rows[0].cells[0].scope).toBe('row');
    expect(elements.tbody.textContent).toContain('Not available');
    expect(elements.legend.hidden).toBe(false);
    expect(elements.legend.children).toHaveLength(8);
    expect(elements.legend.textContent).toContain('GS wholesale');
  });

  test('clears stale alternatives before a new request', () => {
    document.body.innerHTML = '<div id="summary">old</div><details id="details" open><table><tbody id="body"><tr><td>old</td></tr></tbody></table></details><ul id="legend"><li>old</li></ul>';
    const elements = {
      summary: document.getElementById('summary'),
      details: document.getElementById('details'),
      tbody: document.getElementById('body'),
      legend: document.getElementById('legend'),
    };

    HistoryAccessibility.clear(elements);

    expect(elements.summary.hidden).toBe(true);
    expect(elements.summary.textContent).toBe('');
    expect(elements.details.hidden).toBe(true);
    expect(elements.details.open).toBe(false);
    expect(elements.tbody.rows).toHaveLength(0);
    expect(elements.legend.hidden).toBe(true);
    expect(elements.legend.children).toHaveLength(0);
  });
});
