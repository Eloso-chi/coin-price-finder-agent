'use strict';

const HistoryAccessibility = (() => {
  function percentile(sorted, fraction) {
    if (!sorted.length) return null;
    const index = (sorted.length - 1) * fraction;
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    return lower === upper
      ? sorted[lower]
      : sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
  }

  function money(value) {
    return value == null || !Number.isFinite(Number(value))
      ? 'Not available'
      : '$' + Number(value).toFixed(2);
  }

  function seriesMap(series) {
    const result = new Map();
    (series || []).forEach(point => {
      if (Array.isArray(point) && point[0] && Number.isFinite(Number(point[1]))) {
        result.set(point[0], Number(point[1]));
      }
    });
    return result;
  }

  function normalizeSeries(series, currentValue, coinDates, flattenShortSeries) {
    const valid = (series || []).filter(point => Array.isArray(point) && point[0] && Number.isFinite(Number(point[1])))
      .map(point => [point[0], Number(point[1])]);
    const shouldFlatten = flattenShortSeries ? valid.length > 0 && valid.length < 3 : valid.length < 2;
    if (shouldFlatten && currentValue != null && Number.isFinite(Number(currentValue)) && coinDates.length) {
      const value = Number(currentValue);
      return {
        flat: true,
        points: coinDates.length === 1
          ? [[coinDates[0], value]]
          : [[coinDates[0], value], [coinDates[coinDates.length - 1], value]],
      };
    }
    return { flat: false, points: valid };
  }

  function createModel(data, rangeText) {
    const prices = Array.isArray(data.prices) ? data.prices : [];
    const medians = prices.map(point => Number(point[1])).filter(Number.isFinite);
    const sorted = medians.slice().sort((a, b) => a - b);
    const q1 = percentile(sorted, 0.25);
    const q3 = percentile(sorted, 0.75);
    const iqr = q3 == null || q1 == null ? 0 : q3 - q1;
    const outlierLow = q1 == null ? null : q1 - 1.5 * iqr;
    const outlierHigh = q3 == null ? null : q3 + 1.5 * iqr;

    const metal = data.metalOverlay || null;
    const greysheet = data.greysheetOverlay || null;
    const coinDates = prices.map(point => point[0]);
    const currentWholesale = greysheet && greysheet.current && greysheet.current.wholesale != null && Number.isFinite(Number(greysheet.current.wholesale))
      ? Number(greysheet.current.wholesale) : null;
    const currentRetail = greysheet && greysheet.current && greysheet.current.retail != null && Number.isFinite(Number(greysheet.current.retail))
      ? Number(greysheet.current.retail) : null;
    const rawMetal = seriesMap(metal && metal.prices);
    const lastMetal = rawMetal.size ? Array.from(rawMetal.values()).at(-1) : null;
    const metalSeries = normalizeSeries(metal && metal.prices, lastMetal, coinDates, true);
    const wholesaleSeries = normalizeSeries(greysheet && greysheet.wholesale, currentWholesale, coinDates, false);
    const retailSeries = normalizeSeries(greysheet && greysheet.retail, currentRetail, coinDates, false);
    const metalValues = seriesMap(metalSeries.points);
    const wholesaleValues = seriesMap(wholesaleSeries.points);
    const retailValues = seriesMap(retailSeries.points);

    const dates = new Set(prices.map(point => point[0]));
    metalValues.forEach((_value, date) => dates.add(date));
    wholesaleValues.forEach((_value, date) => dates.add(date));
    retailValues.forEach((_value, date) => dates.add(date));

    const coinByDate = new Map(prices.map(point => [point[0], point]));
    const rows = Array.from(dates).sort().map(date => {
      const point = coinByDate.get(date);
      const median = point && Number.isFinite(Number(point[1])) ? Number(point[1]) : null;
      return {
        date,
        median,
        average: point && Number.isFinite(Number(point[2])) ? Number(point[2]) : null,
        low: point && Number.isFinite(Number(point[3])) ? Number(point[3]) : null,
        high: point && Number.isFinite(Number(point[4])) ? Number(point[4]) : null,
        sales: point && Number.isFinite(Number(point[5])) ? Number(point[5]) : null,
        outlier: median != null && outlierLow != null && (median < outlierLow || median > outlierHigh),
        metal: metalValues.has(date) ? metalValues.get(date) : null,
        wholesale: wholesaleValues.has(date) ? wholesaleValues.get(date) : null,
        retail: retailValues.has(date) ? retailValues.get(date) : null,
      };
    });

    const coinRows = rows.filter(row => row.median != null);
    const sales = coinRows.reduce((sum, row) => sum + (row.sales || 0), 0);
    const lows = coinRows.map(row => row.low == null ? row.median : row.low);
    const highs = coinRows.map(row => row.high == null ? row.median : row.high);

    return {
      name: data.displayName || 'Price history',
      rangeText,
      rows,
      pointCount: coinRows.length,
      sales,
      overallMedian: percentile(sorted, 0.5),
      low: lows.length ? Math.min(...lows) : null,
      high: highs.length ? Math.max(...highs) : null,
      outlierCount: coinRows.filter(row => row.outlier).length,
      minDailySales: coinRows.length ? Math.min(...coinRows.map(row => row.sales || 0)) : 0,
      maxDailySales: coinRows.length ? Math.max(...coinRows.map(row => row.sales || 0)) : 0,
      metalName: metal && metal.metal ? metal.metal : null,
      metalLow: metalValues.size ? Math.min(...metalValues.values()) : null,
      metalHigh: metalValues.size ? Math.max(...metalValues.values()) : null,
      wholesaleLow: wholesaleValues.size ? Math.min(...wholesaleValues.values()) : null,
      wholesaleHigh: wholesaleValues.size ? Math.max(...wholesaleValues.values()) : null,
      retailLow: retailValues.size ? Math.min(...retailValues.values()) : null,
      retailHigh: retailValues.size ? Math.max(...retailValues.values()) : null,
      currentWholesale,
      currentRetail,
      metalSeries,
      wholesaleSeries,
      retailSeries,
      allDates: Array.from(dates).sort(),
      thresholds: { q1, q3, outlierLow, outlierHigh },
    };
  }

  function addCell(row, tagName, text, scope) {
    const cell = document.createElement(tagName);
    cell.textContent = text;
    if (scope) cell.scope = scope;
    row.appendChild(cell);
  }

  function render(model, elements) {
    const summary = elements.summary;
    const details = elements.details;
    const tbody = elements.tbody;
    const parts = [
      model.name + ', ' + model.rangeText + '.',
      model.pointCount + ' daily price point' + (model.pointCount === 1 ? '' : 's') +
        ' representing ' + model.sales + ' sale' + (model.sales === 1 ? '' : 's') + '.',
      'Overall median ' + money(model.overallMedian) + '; observed range ' + money(model.low) + ' to ' + money(model.high) + '.',
      'Interquartile range ' + money(model.thresholds.q1) + ' to ' + money(model.thresholds.q3) +
        '; outlier thresholds below ' + money(model.thresholds.outlierLow) + ' or above ' + money(model.thresholds.outlierHigh) + '.',
      model.outlierCount + ' daily median' + (model.outlierCount === 1 ? '' : 's') + ' outside the chart\'s interquartile thresholds.',
      'Daily sample counts range from ' + model.minDailySales + ' to ' + model.maxDailySales + '.',
    ];
    if (model.metalName && model.metalSeries.points.length) {
      parts.push(model.metalName.charAt(0).toUpperCase() + model.metalName.slice(1) +
        ' spot overlay ranges from ' + money(model.metalLow) + ' to ' + money(model.metalHigh) + ' per ounce.');
    } else {
      parts.push('Metal spot overlay data is not available.');
    }
    if (model.currentWholesale != null || model.currentRetail != null) {
      const refs = [];
      if (model.currentWholesale != null) refs.push('wholesale ' + money(model.currentWholesale));
      if (model.currentRetail != null) refs.push('retail ' + money(model.currentRetail));
      parts.push('Current Greysheet reference: ' + refs.join('; ') + '.');
    } else {
      parts.push('Current Greysheet reference data is not available.');
    }
    if (model.wholesaleLow != null) parts.push('Greysheet wholesale plotted range ' + money(model.wholesaleLow) + ' to ' + money(model.wholesaleHigh) + '.');
    if (model.retailLow != null) parts.push('Greysheet retail plotted range ' + money(model.retailLow) + ' to ' + money(model.retailHigh) + '.');
    if (model.wholesaleLow == null && model.retailLow == null && model.currentWholesale == null && model.currentRetail == null) {
      parts.push('No Greysheet series is plotted.');
    }
    summary.textContent = parts.join(' ');
    summary.hidden = false;

    tbody.textContent = '';
    model.rows.forEach(item => {
      const row = document.createElement('tr');
      addCell(row, 'th', item.date, 'row');
      addCell(row, 'td', money(item.median));
      addCell(row, 'td', money(item.average));
      addCell(row, 'td', money(item.low));
      addCell(row, 'td', money(item.high));
      addCell(row, 'td', item.sales == null ? 'Not available' : String(item.sales));
      addCell(row, 'td', item.median == null ? 'Not applicable' : (item.outlier ? 'Yes' : 'No'));
      addCell(row, 'td', money(item.metal));
      addCell(row, 'td', money(item.wholesale));
      addCell(row, 'td', money(item.retail));
      tbody.appendChild(row);
    });
    details.hidden = false;

    elements.legend.textContent = '';
    const legendItems = [
      ['history-legend-coin', model.name],
      ['history-legend-median', 'Overall median'],
      ['history-legend-iqr', 'Interquartile range'],
      ['history-legend-minmax', 'Daily low to high'],
      ['history-legend-outlier', 'Outlier'],
    ];
    if (model.metalSeries.points.length) legendItems.push(['history-legend-metal', model.metalName + ' spot']);
    if (model.wholesaleSeries.points.length) legendItems.push(['history-legend-wholesale', 'GS wholesale']);
    if (model.retailSeries.points.length) legendItems.push(['history-legend-retail', 'GS retail']);
    legendItems.forEach(item => {
      const li = document.createElement('li');
      li.className = item[0];
      li.textContent = item[1];
      elements.legend.appendChild(li);
    });
    elements.legend.hidden = false;
  }

  function clear(elements) {
    elements.summary.textContent = '';
    elements.summary.hidden = true;
    elements.tbody.textContent = '';
    elements.details.hidden = true;
    elements.details.open = false;
    elements.legend.textContent = '';
    elements.legend.hidden = true;
  }

  return { createModel, render, clear, percentile, money };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = HistoryAccessibility;
}
