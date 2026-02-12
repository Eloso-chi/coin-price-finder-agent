// Manual evidence parsing for CoinPriceDiscoveryAgent
// Supports CSV and JSON input, ensures traceability

const csvParse = require('csv-parse/sync');

function parseManualEvidence(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input;
  if (typeof input === 'string') {
    // Try JSON first
    try {
      const arr = JSON.parse(input);
      if (Array.isArray(arr)) return arr;
    } catch (e) {
      // Try CSV
      try {
        const records = csvParse.parse(input, {
          columns: true,
          skip_empty_lines: true
        });
        return records;
      } catch (err) {
        return [];
      }
    }
  }
  return [];
}

module.exports = { parseManualEvidence };
