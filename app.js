// Debug endpoint to check eBay API credentials
app.get('/api/debug/ebay', (req, res) => {
  const ebay = require('./ebay');
  res.json({
    EBAY_APP_ID: process.env.EBAY_APP_ID,
    EBAY_CLIENT_SECRET: process.env.EBAY_CLIENT_SECRET,
    loaded: !!process.env.EBAY_APP_ID && !!process.env.EBAY_CLIENT_SECRET
  });
});
// CoinPriceDiscoveryAgent Express web-app
// Main entry point

const express = require('express');
const bodyParser = require('body-parser');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());

app.use(express.static('public'));

const history = require('./history');

const evidence = require('./evidence');

const ebay = require('./ebay');
const greysheet = require('./greysheet');
const pcgs = require('./pcgs');
const numista = require('./numista');
const manual = require('./manual');
const output = require('./output');

// MODE=new: Accepts coin query and optional manual evidence
app.post('/api/query/new', async (req, res) => {
  const { coin_name, grade, manual_evidence } = req.body;
  if (!coin_name || !grade) {
    return res.status(400).json({ error: 'coin_name and grade required' });
  }
  const query_id = `${coin_name}_${grade}_${Date.now()}`;
  const run_id = `${Date.now()}`;
  const run_date = new Date().toISOString();

  // Manual evidence parsing and normalization
  let parsed_manual = manual.parseManualEvidence(manual_evidence);
  let normalized_manual_comps = [];
  if (Array.isArray(parsed_manual)) {
    normalized_manual_comps = parsed_manual.map(comp => evidence.normalizeComp(comp, { coin_name, grade })).filter(c => !!c);
  }
  const manual_metrics = evidence.computeMetrics(normalized_manual_comps);

  // eBay SOLD comps
  const ebayResult = await ebay.fetchEbaySoldComps({ coin_name, grade });
  let normalized_ebay_comps = [];
  if (ebayResult.accessible && ebayResult.comps.length) {
    normalized_ebay_comps = ebayResult.comps.map(comp => evidence.normalizeComp(comp, { coin_name, grade })).filter(c => !!c);
  }
  const ebay_metrics = evidence.computeMetrics(normalized_ebay_comps);

  // Greysheet stub
  const greysheetResult = await greysheet.fetchGreysheet({ coin_name, grade });
  // PCGS stub
  const pcgsResult = await pcgs.fetchPCGS({ coin_name, grade });
  // Numista stub
  const numistaResult = await numista.fetchNumista({ coin_name, grade });

  // Cache structure
  const cache = {
    manual_comps: normalized_manual_comps,
    manual_metrics,
    ebay_comps: normalized_ebay_comps,
    ebay_metrics,
    greysheet: greysheetResult,
    pcgs: pcgsResult,
    numista: numistaResult,
    limitations: [
      ...(ebayResult.limitations || []),
      ...(greysheetResult.limitations || []),
      ...(pcgsResult.limitations || []),
      ...(numistaResult.limitations || [])
    ]
  };
  const entry = {
    query_id,
    run_id,
    mode: 'new',
    run_date,
    cache,
    query: { coin_name, grade, manual_evidence }
  };
  history.addHistoryEntry(entry);
  const result = output.buildOutput({ query_id, run_id, mode: 'new', run_date, query: { coin_name, grade, manual_evidence }, cache });
  res.json(result);
});

// MODE=rerun: Accepts query_id, re-runs stored query
app.post('/api/query/rerun', (req, res) => {
  const { query_id } = req.body;
  if (!query_id) {
    return res.status(400).json({ error: 'query_id required' });
  }
  const entry = history.getHistoryByQueryId(query_id);
  if (!entry) {
    return res.status(404).json({ error: 'query_id not found' });
  }
  // Placeholder: rerun logic
  res.json({ status: 'rerun placeholder', query_id, entry });
});

// MODE=view_cached: Accepts query_id, returns cached results only
app.get('/api/query/view_cached', (req, res) => {
  const query_id = req.query.query_id;
  if (!query_id) {
    return res.status(400).json({ error: 'query_id required' });
  }
  const entry = history.getHistoryByQueryId(query_id);
  if (!entry) {
    return res.status(404).json({ error: 'query_id not found' });
  }
  res.json({ status: 'cached', query_id, cache: entry.cache });
});

app.listen(PORT, () => {
  console.log(`CoinPriceDiscoveryAgent Express app listening on port ${PORT}`);
});
