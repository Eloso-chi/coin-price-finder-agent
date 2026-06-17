# Label Feature Implementation Context

## Key Code Sections Found

### 1. "I have this coin" Button (index.html ~L3520)
- Button ID: `add-coin-btn` in `add-coin-wrap`
- Handler: `CoinStorage.addCoin(user.userId, user.key, _addCoin)`
- Stores: `{series, year, mint, grade, weight, query}`
- Post-add allows inline cost entry via `updateCostPer()`

### 2. Coin Storage Schema (storage.js)
**addCoin() plaintext fields:**
- `series, year, mint, grade, weight, query, count, costPer, notes`
- `baseMetal, fineness, dateAdded`
- `coinHash` computed via `CoinCrypto.coinHash(coin)` for deduplication

### 3. coinHash() Function (crypto.js ~L195)
Includes: `[series, year, mint, grade, notes]` joined by `|`
For Label feature: Add label field to this canonical string to make labeled variants have distinct hashes

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

## Integration Points for Label Feature
1. Add `label` field to coin storage schema
2. Update `coinHash()` to include label for deduplication
3. Modify `scoreMatch()` to detect/penalize label variants
4. Update `buildKeywords()` to include label tokens
5. Add Label field to "I have this coin" form + My Coins table
6. Add label filter/search to My Coins tab
