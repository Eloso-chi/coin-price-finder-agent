// PCGS CoinFacts stub integration for CoinPriceDiscoveryAgent
async function fetchPCGS(query) {
  return {
    accessible: false,
    comps: [],
    limitations: ['PCGS CoinFacts API not implemented; price guide only, no sold comps']
  };
}
module.exports = { fetchPCGS };