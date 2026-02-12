// eBay Browse API integration for CoinPriceDiscoveryAgent
// Uses OAuth Client Credentials Grant (App ID + Client Secret)

const axios = require('axios');
require('dotenv').config();

const EBAY_APP_ID = process.env.EBAY_APP_ID || '';
const EBAY_CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET || '';

// Token cache to avoid re-authenticating every call
let cachedToken = null;
let tokenExpiry = 0;

/**
 * Obtain an OAuth application access token using Client Credentials Grant.
 */
async function getOAuthToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiry) return cachedToken;

  const resp = await axios.post(
    'https://api.ebay.com/identity/v1/oauth2/token',
    'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
    {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      auth: { username: EBAY_APP_ID, password: EBAY_CLIENT_SECRET }
    }
  );
  cachedToken = resp.data.access_token;
  // Expire 5 min early to be safe (eBay tokens last ~2 h)
  tokenExpiry = now + (resp.data.expires_in - 300) * 1000;
  return cachedToken;
}

/**
 * Search eBay active listings via the Browse API.
 * @param {Object} query  – { coin_name, grade }
 * @param {number} limit  – max results (1-200, default 50)
 */
async function fetchEbaySoldComps(query, limit = 50) {
  if (!EBAY_APP_ID || !EBAY_CLIENT_SECRET) {
    return { accessible: false, comps: [], limitations: ['eBay API credentials not provided'] };
  }

  const keywords = `${query.coin_name} ${query.grade}`.trim();

  try {
    const token = await getOAuthToken();

    const response = await axios.get(
      'https://api.ebay.com/buy/browse/v1/item_summary/search',
      {
        params: {
          q: keywords,
          category_ids: '11116',   // Coins & Paper Money
          limit: Math.min(limit, 200)
        },
        headers: {
          Authorization: `Bearer ${token}`,
          'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US'
        }
      }
    );

    const items = response.data.itemSummaries || [];

    const comps = items.map(item => ({
      source: 'ebay',
      sold_price: parseFloat(item.price?.value || 0),
      currency: item.price?.currency || 'USD',
      shipping: item.shippingOptions?.[0]?.shippingCost?.value
        ? parseFloat(item.shippingOptions[0].shippingCost.value)
        : 0,
      title: item.title,
      url: item.itemWebUrl,
      image: item.image?.imageUrl || null,
      condition: item.condition || null,
      grade: query.grade,
      coin_name: query.coin_name
    }));

    return { accessible: true, comps, limitations: [] };
  } catch (err) {
    const msg = err.response?.data?.errors?.[0]?.message || err.message;
    return { accessible: false, comps: [], limitations: ['eBay API error', msg] };
  }
}

module.exports = { fetchEbaySoldComps };
