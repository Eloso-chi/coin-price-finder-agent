# Label Feature Implementation Context

> Historical planning note, refreshed 2026-08-13. The label feature is now
> implemented with server-side plaintext storage; references below describe
> current integration points, not pending client-side encryption work.

## Key Code Sections Found

### 1. "I have this coin" Button (index.html ~L3520)
- Button ID: `add-coin-btn` in `add-coin-wrap`
- Handler: `CoinStorage.addCoin(user.userId, user.key, _addCoin)` (legacy key argument ignored)
- Stores server-side fields including `series`, `year`, `mint`, `grade`, `weight`, `query`, and `label`
- Post-add allows inline cost entry via `updateCostPer()`

### 2. Coin Storage Schema
`public/js/storage.js` is a thin `/api/coins/*` client. The authoritative
plaintext schema and persistence live in `src/services/coinStorageService.js`.

### 3. coinHash() Function
`src/services/coinStorageService.js` computes SHA-256 over
`series|year|mint|grade|notes|label`. `public/js/storage.js` mirrors the same
canonical string for parity. `crypto.js` and `CoinCrypto` are no longer used.

### 4. scoreMatch() Variant Penalty (ebayService.js ~L560)
- VARIANT_TOKENS: golden, gilded, reverse proof, burnished, first strike, first release, first day, etc.
- Penalty: `score -= 30` for unwanted variants
- Can integrate label detection here

### 5. buildKeywords() (ebayService.js ~L1370)
- Builds eBay search keywords from PCGS data
- Could append label tokens for better eBay matching

### 6. My Coins Table (my-coins.js)
- Columns: Coin, Grade, Qty, Troy Oz, FMV, Total, Cost, P/L, Melt, Avg eBay, Range, Notes, Added
- Note: Could add Label column here

## Current Integration Status
1. `label` is part of the server storage schema and dedup hash.
2. The add-coin flow and My Coins table expose label values.
3. My Coins filtering and sorting include labels.
4. Pricing requests pass label as a variant hint; common variant handling remains in `ebayService.js`.
