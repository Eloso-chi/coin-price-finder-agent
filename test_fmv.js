require('dotenv').config();
const ebay = require('./ebay');
const evidence = require('./evidence');

(async () => {
  const coin_name = '1971 Eisenhower dollar proof coin';
  const grade = 'Proof';

  const ebayResult = await ebay.fetchEbaySoldComps({ coin_name, grade });
  console.log('eBay accessible:', ebayResult.accessible);
  console.log('Raw comps:', ebayResult.comps.length);

  const normalized = ebayResult.comps
    .map(c => evidence.normalizeComp(c, { coin_name, grade }))
    .filter(c => c !== null);
  console.log('After normalize + lot filter:', normalized.length);

  const metrics = evidence.computeMetrics(normalized);
  console.log('Metrics:', JSON.stringify(metrics, null, 2));

  const fmv = evidence.estimateFMV(normalized);
  console.log('\n=== FAIR MARKET VALUE ===');
  console.log(JSON.stringify(fmv, null, 2));
})();
