'use strict';

function numericValues(matrix) {
  return (matrix?.cells || [])
    .map(cell => cell?.medianCompleted?.value)
    .filter(value => Number.isFinite(value));
}

function summarizeMatrix(matrix) {
  const cells = Array.isArray(matrix?.cells) ? matrix.cells : [];
  const values = numericValues(matrix);
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    series: matrix?.series || null,
    grade: matrix?.grade || 'All',
    observed: {
      cells: cells.length,
      pricedCells: values.length,
      sampleSize: cells.reduce((sum, cell) => sum + (cell?.medianCompleted?.sampleSize || 0), 0),
      yearMin: matrix?.summary?.yearMin ?? null,
      yearMax: matrix?.summary?.yearMax ?? null,
    },
    derived: {
      medianOfCellMedians: values.length ? +([...values].sort((a, b) => a - b)[Math.floor(values.length / 2)].toFixed(2)) : null,
      meanOfCellMedians: values.length ? +(total / values.length).toFixed(2) : null,
      coverageRate: cells.length ? +(values.length / cells.length * 100).toFixed(1) : 0,
    },
    missing: values.length ? [] : ['completed-sale median data'],
  };
}

function compareMatrices(matrices) {
  return matrices.map(matrix => summarizeMatrix(matrix));
}

function buildYearSeries(matrix) {
  const points = (matrix?.cells || [])
    .filter(cell => Number.isFinite(cell?.medianCompleted?.value))
    .map(cell => ({
      year: cell.year,
      mint: cell.mint || null,
      medianCompleted: cell.medianCompleted.value,
      sampleSize: cell.medianCompleted.sampleSize || 0,
      classification: 'observed',
    }))
    .sort((a, b) => a.year - b.year || String(a.mint).localeCompare(String(b.mint)));

  return {
    series: matrix?.series || null,
    grade: matrix?.grade || 'All',
    points,
    classification: points.length ? 'observed-by-year' : 'missing',
    note: 'This is a year-by-year market series from completed-sale medians, not a daily time trend.',
    missing: points.length ? [] : ['completed-sale year observations'],
  };
}

module.exports = { summarizeMatrix, compareMatrices, buildYearSeries };