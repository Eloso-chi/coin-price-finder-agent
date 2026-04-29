---
mode: agent
agent: pricing-health
description: >
  Run end-to-end pricing health check. Picks diverse coins from the golden set
  and Terapeak store, traces each through all pricing routes, compares FMV
  across routes, and flags comp attrition anomalies where Terapeak data is
  lost through the filter pipeline.
---
Run the full Pricing Health check procedure. Pick at least 10 coins (6+ from the
golden set, 4+ from Terapeak store), trace each through Price Discovery and Batch
Pricing, and produce the health report with cross-route consistency, comp attrition,
and Terapeak-to-valuation pipeline analysis.
