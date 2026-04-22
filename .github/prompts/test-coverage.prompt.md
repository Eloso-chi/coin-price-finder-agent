---
mode: agent
description: "Analyze test coverage gaps and write new tests for missing behavioral coverage"
agent: test-coverage
---

Analyze the current test suite and identify coverage gaps.

Focus on these behavioral areas (skip any that are already fully covered):
- Coin parsing: US coins, US bullion, world bullion (randomized seeded selection)
- Graded vs ungraded separation in filtering and valuation
- Proof-only filter enforcement
- Packaging terms: "tube", "roll", "N coin roll"
- Cross-tab propagation of coin context (tracker, history, melt)
- Pricing tolerance checks (non-flaky, no logic reimplementation)

Follow the Step 0 -> Step 1 -> Step 2 -> Step 3 procedure from your agent definition.
Do not write any code until Steps 0 and 1 are complete.
