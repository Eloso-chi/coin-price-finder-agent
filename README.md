# Coin Price Discovery Agent

A dealer-oriented pricing tool that calculates **Fair Market Value (FMV)** for US coins and bullion bars by combining PCGS catalog data with eBay sold-comp analysis. It produces buy/sell recommendations with confidence scores — designed for quick, data-backed decisions at a coin show or behind a counter.

## What It Does

1. **Identifies the coin** — accepts a PCGS cert number, barcode, PCGS coin number, or free-text description (e.g. "1881-CC Morgan dollar MS 64").
2. **Enriches via PCGS** — fetches price guide value, population, auction history, mintage, and reference images from the PCGS CoinFacts API.
3. **Pulls eBay sold comps** — queries up to three eBay APIs (Marketplace Insights → Finding → Browse) to collect recent sold prices, then scores and filters them for relevance.
4. **Computes FMV** — blends PCGS and eBay data using a weighted median with outlier removal, producing a confidence-scored valuation.
5. **Generates buy/sell decisions** — outputs max-buy thresholds (70/75/80% of FMV) and sell tiers (fast/normal/premium) with a recommendation.

Also supports **bullion bars** (any metal, any size) and **proof/mint sets** with dedicated input flows and eBay keyword strategies.

---

## Quick Start

### Prerequisites

- **Node.js** 18+ (CommonJS)
- **eBay Developer** account — [developer.ebay.com](https://developer.ebay.com/)
- **PCGS Public API** key — [pcgs.com/publicapi/documentation](https://www.pcgs.com/publicapi/documentation)
- *(Optional)* Gold API or Metals API key for live spot prices

### Install

```bash
git clone https://github.com/Eloso-chi/coin-price-finder-agent.git
cd coin-price-finder-agent
npm install
```

### Configure

Copy `.env.example` to `.env` and fill in your API keys:

```bash
cp .env.example .env
```

Required variables:

| Variable | Purpose |
|----------|---------|
| `PCGS_API_KEY` | PCGS CoinFacts API token |
| `EBAY_APP_ID` | eBay app ID (from Developer Portal) |
| `EBAY_CLIENT_SECRET` | eBay client secret (for OAuth) |

Optional variables:

| Variable | Purpose | Default |
|----------|---------|---------|
| `GOLDAPI_KEY` | Gold API key for spot prices | *(none)* |
| `METALS_API_KEY` | Metals API key (fallback provider) | *(none)* |
| `PORT` | Server port | `3000` |
| `EBAY_CACHE_TTL_MS` | eBay cache lifetime | `3600000` (1 hour) |
| `EBAY_US_MIN_COMPS` | Minimum US comps before global fallback | `8` |

### Run

```bash
npm start
# or with auto-reload:
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser for the web UI.

### Example API Call

```bash
curl -s -X POST http://localhost:3000/api/price \
  -H 'Content-Type: application/json' \
  -d '{"query": "1881-CC Morgan dollar MS 64", "askingPrice": 650}' | jq .
```

Response (abbreviated):

```json
{
  "pcgs": {
    "verified": true,
    "pcgsCoinNumber": 7126,
    "series": "Morgan Dollars 1878-1921",
    "grade": "MS64",
    "priceGuide": { "valueUsd": 900 },
    "population": { "thisGrade": 9515, "higher": 8974 }
  },
  "valuation": {
    "fmvCore": 835.00,
    "rangeLow": 780.00,
    "rangeHigh": 890.00,
    "confidence": 82
  },
  "decisions": {
    "buy": {
      "max70": 584.50,
      "max75": 626.25,
      "max80": 668.00,
      "askingPrice": 650,
      "recommendation": "BUY (thin margin)"
    },
    "sell": {
      "fast": 768.20,
      "normal": 835.00,
      "premium": 876.75
    }
  }
}
```

---

## Key Concepts

### FMV Core

Fair Market Value is a blended estimate from up to three data sources:

| Source | Weight (Certified) | Weight (Raw) |
|--------|-------------------|--------------|
| eBay Sold Comps | 65% | 80% |
| PCGS Price Guide | 25% | 20% |
| PCGS Auction History | 10% | — |

If a source is unavailable, weights are renormalized among the remaining sources.

The eBay component uses a **weighted median** that favors recent sales (recency decay: `1 / (1 + daysSince/90)`) and high-relevance matches (match score from `scoreMatch()`).

### US Comps vs Global Comps

The agent queries eBay US first. If US sold comps fall below the threshold (default: 8), it pulls global comps as a supplement. The valuation engine prefers US comps and applies a confidence penalty when relying on global data.

### Confidence Score

A 0–100 score reflecting how trustworthy the FMV estimate is:

| Factor | Points |
|--------|--------|
| Sample size | Up to 30–40 pts |
| Price dispersion (low spread) | Up to 20–25 pts |
| Match quality (avg score) | Up to 15–25 pts |
| PCGS verified | +10 |
| PCGS price guide available | +10 |
| Auction data available | +5 |
| 20+ comps bonus | +10–15 |
| Global fallback penalty | −5 to −15 |
| Fewer than 5 comps | −10 |

### Buy vs Sell Strategies

**Buy thresholds** — maximum prices a dealer should pay:

| Tier | Formula | Use When |
|------|---------|----------|
| 70% | FMV × 0.70 | Target for maximum margin |
| 75% | FMV × 0.75 | Standard dealer buy |
| 80% | FMV × 0.80 | Thin margin, high-demand items |

If an asking price is provided:
- ≤ 75% of FMV → **BUY**
- ≤ 80% of FMV → **BUY (thin margin)**
- \> 80% of FMV → **PASS**

**Sell tiers** — suggested list prices:

| Tier | Formula | Description |
|------|---------|-------------|
| Fast | eBay median × 0.92 | Quick sale, undercut market |
| Normal | eBay median | Market price |
| Premium | eBay median × 1.05 | Patient sell (1.15× if pop < 200) |
| Offer Floor | min(P25, fast) | Lowest acceptable offer |

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/price` | Price a coin (main endpoint) |
| `POST` | `/api/bar-price` | Price a bullion bar |
| `GET` | `/api/metals` | Get spot prices for multiple metals |
| `GET` | `/api/metals/:metal` | Get a single metal's spot price |
| `POST` | `/api/clear-cache` | Flush all caches (eBay + PCGS) |
| `GET` | `/api/health` | Health check + config status |

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for detailed request/response schemas and the full data flow.

---

## Tests

```bash
npm test
```

Runs Jest tests covering the metals spot price service (TTL cache, round-robin rotation, fallback logic, error propagation, concurrency deduplication).

---

## Project Structure

```
server.js                          Express entry point
public/index.html                  Single-page frontend (dark theme)
src/
  routes/
    priceRoute.js                  POST /api/price — coin pricing orchestrator
    barPriceRoute.js               POST /api/bar-price — bullion bar pricing
    metalsRoute.js                 GET /api/metals — spot price endpoints
  services/
    pcgsService.js                 PCGS CoinFacts API integration + parser
    ebayService.js                 eBay sold comps (3-tier API cascade)
    valuationService.js            FMV computation + buy/sell decisions
    metalsSpotPrice.js             Multi-provider spot price with round-robin
    MetalsSpotPriceError.js        Custom error class for metals failures
  data/
    pcgsNumbers.js                 PCGS coin number lookup table (10 US series)
    keyDates.js                    Key date / semi-key detection
    mintages.js                    Static mintage reference data
    constants.js                   Zodiac cycle, Perth Lunar series helpers
    lunarReference.js              Lunar series cross-mint comparison
  utils/
    cache.js                       TTLCache with optional JSON file persistence
    stats.js                       Statistical functions (median, MAD, weighted median)
cache/
  ebay_cache.json                  Persisted eBay comp cache (1-hour TTL)
  pcgs_cache.json                  Persisted PCGS data cache (24-hour TTL)
__tests__/
  metalsSpotPrice.test.js          Jest tests for spot price service
```

---

## License

ISC
