// eBay SOLD listings integration for CoinPriceDiscoveryAgent
// Uses official eBay Finding API (requires user-provided credentials)


const axios = require('axios');
require('dotenv').config();
const EBAY_APP_ID = process.env.EBAY_APP_ID || '';
const EBAY_CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET || '';

async function fetchEbaySoldComps(query, lookbackMonths = 6) {
  if (!EBAY_APP_ID) {
    return { accessible: false, comps: [], limitations: ['eBay API credentials not provided'] };
  }
  // eBay Finding API: findCompletedItems
  const endpoint = 'https://svcs.ebay.com/services/search/FindingService/v1';
  const now = new Date();
  const startDate = new Date(now.setMonth(now.getMonth() - lookbackMonths));
  const keywords = `${query.coin_name} ${query.grade}`;
  const params = {
    'OPERATION-NAME': 'findCompletedItems',
    'SERVICE-VERSION': '1.13.0',
    'SECURITY-APPNAME': EBAY_APP_ID,
    'RESPONSE-DATA-FORMAT': 'JSON',
    'keywords': keywords,
    'categoryId': '11116', // Coins & Paper Money
    'itemFilter(0).name': 'SoldItemsOnly',
    'itemFilter(0).value': 'true',
    'itemFilter(1).name': 'EndTimeFrom',
    'itemFilter(1).value': startDate.toISOString(),
    'paginationInput.entriesPerPage': '50'
  };
  try {
    const response = await axios.get(endpoint, { params });
    // Parse results
    const items = response.data.findCompletedItemsResponse[0].searchResult[0].item || [];
    const comps = items.map(item => ({
      source: 'ebay',
      sold_price: parseFloat(item.sellingStatus[0].currentPrice[0].__value__),
      shipping: item.shippingInfo[0].shippingServiceCost ? parseFloat(item.shippingInfo[0].shippingServiceCost[0].__value__) : 0,
      sold_date: item.listingInfo[0].endTime[0],
      title: item.title[0],
      url: item.viewItemURL[0],
      grade: query.grade,
      coin_name: query.coin_name,
      original: item
    }));
    return { accessible: true, comps, limitations: [] };
  } catch (err) {
    return { accessible: false, comps: [], limitations: ['eBay API error', err.message] };
  }
}

module.exports = { fetchEbaySoldComps };
