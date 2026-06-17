# Azure Infrastructure

## App Service
- Name: coinpricefinder-h3a3b5g0dmdydna4
- RG: CoinPriceFinder_group-82d5
- Region: Canada Central
- SKU: B2 Linux
- Managed identity: enabled (principalId: 0a61d4ad-36de-4b31-860a-eaaf4b3c86b7)

## Key Vault
- Name: coinpricefinder-kv
- Access: managed identity (get, list)
- Secrets: ADMIN-API-KEY, JWT-SECRET, EBAY-APP-ID, EBAY-CLIENT-SECRET, EBAY-CERT-ID, PCGS-API-KEY, GREYSHEET-API-TOKEN, GREYSHEET-API-KEY, COSMOS-KEY
- All app settings use @Microsoft.KeyVault() references

## Cosmos DB
- Account: coinpricefinder-cosmos (serverless, NoSQL API)
- Database: coinprice
- Containers:
  - users (pk: /username) -- authService
  - user-coins (pk: /userId) -- coinStorageService
  - terapeak-sold (pk: /searchTerm) -- terapeakService
  - greysheet-history (pk: /coinKey) -- 592 real coin snapshots migrated
  - metals-history (pk: /metal) -- 4 metals (91 days) migrated
- Connection: COSMOS_ENDPOINT + COSMOS_KEY (via KV) + COSMOS_DB app settings

## Azure Files
- Storage: coinpricecache01, share: appcache (1GB), mounted at /mnt/cache
- CACHE_DIR=/mnt/cache

## Dual-mode storage pattern
- All services check cosmos.isEnabled() (true when COSMOS_ENDPOINT is set)
- If Cosmos: write-through to Cosmos + file store (belt-and-suspenders)
- If no Cosmos: pure file storage (local dev, tests)
- Tests run without COSMOS_ENDPOINT -- 100% backward compatible
- Migration script: scripts/migrate-to-cosmos.js (one-time, real data only)
