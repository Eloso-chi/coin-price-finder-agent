// Greysheet stub integration for CoinPriceDiscoveryAgent
// Requires user-provided credentials for licensed access
async function fetchGreysheet(query, credentials) {
  return {
    accessible: false,
    comps: [],
    limitations: ['Greysheet access requires user credentials and licensed API']
  };
}
module.exports = { fetchGreysheet };