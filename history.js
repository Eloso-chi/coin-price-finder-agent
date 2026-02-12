// Simple persistent search history for CoinPriceDiscoveryAgent
// Stores history in a local JSON file

const fs = require('fs');
const path = require('path');

const HISTORY_FILE = path.join(__dirname, 'search_history.json');

function loadHistory() {
  if (!fs.existsSync(HISTORY_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch (e) {
    return [];
  }
}

function saveHistory(history) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

function addHistoryEntry(entry) {
  const history = loadHistory();
  history.push(entry);
  saveHistory(history);
}

function getHistoryByQueryId(query_id) {
  const history = loadHistory();
  return history.find(h => h.query_id === query_id);
}

module.exports = {
  loadHistory,
  saveHistory,
  addHistoryEntry,
  getHistoryByQueryId
};
