# PCGS Numbers Collisions (pre-existing data bug, follow-up needed)

Discovered while implementing PR-2b (prefetch grade pruning + round-robin),
2026-06-30. Migrated from `/memories/repo/` to `docs/memory/` on 2026-07-05
so the git-tracked references in `__tests__/prefetchScheduler.test.js` and
`src/services/prefetchScheduler.js` resolve on any machine.

## Symptom

`src/data/pcgsNumbers.js` contains **80 colliding PCGS numbers** -- the
same integer is the value in two different (table, year) slots.

## Root cause

`AMERICAN_GOLD_EAGLE_1OZ` and `AMERICAN_GOLD_EAGLE_HALF` tables appear to
have been copy-pasted from / overlap with `AMERICAN_SILVER_EAGLE`. Example:

| PCGS# | First slot | Second slot |
|---|---|---|
| 9814 | ASE/1999 | AGE_1OZ/1986 |
| 9815 | ASE/2000 | AGE_HALF/1986 |
| 9816 | ASE/2001 | AGE_1OZ/1987 |

The Gold Eagle ranges should be PCGS Category 876-879 (per the comment in
the file). The 9801-9885 range is canonically Silver Eagle.

## Impact

- `lookupPCGSNumber('Gold Eagle 1oz', 1986, 'P')` will return `9814` --
  this is **wrong**; querying PCGS APR returns Silver Eagle 1999 data.
- The bug has been latent since the Gold Eagle tables were added (was not
  introduced by PR-2a or PR-2b).
- PR-2b's queue dedup (`seen` set on `pcgsNo:grade`) prevents double-
  fetching, but the data returned is still wrong.

## Why PR-2b did NOT fix this

Out of scope. PR-2b is queue scheduling only. Fixing requires:
1. Verifying correct PCGS#s for every entry in AGE_1OZ / AGE_HALF /
   AGE_QUARTER / AGE_TENTH against PCGS Coinfacts.
2. Writing a regression test that asserts no collisions across tables.
3. Possibly rewriting the affected tables entirely.

## Follow-up

Open issue when bandwidth allows. Suggested title:
"data(pcgsNumbers): fix collisions between Silver Eagle and Gold Eagle tables"

Tag: `data-integrity`, `prefetch-correctness`.

## Detection snippet (drop in a test file when fixing)

```js
const { TABLES_BY_CATEGORY } = require('../src/data/pcgsNumbers');
const owners = new Map();
for (const tables of Object.values(TABLES_BY_CATEGORY)) {
  for (const [name, t] of Object.entries(tables)) {
    for (const [yr, yd] of Object.entries(t)) {
      for (const n of Object.values(yd)) {
        if (typeof n !== 'number' || n <= 100) continue;
        if (!owners.has(n)) owners.set(n, []);
        owners.get(n).push(`${name}/${yr}`);
      }
    }
  }
}
const collisions = [...owners].filter(([, l]) => l.length > 1);
expect(collisions).toEqual([]); // Currently 80 entries
```
