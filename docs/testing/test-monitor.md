# Test Monitor

A persistent test-health monitoring system for coin-price-finder-agent.
Zero new dependencies. Works locally and in CI.

## Quick Start

```bash
# Run tests and record metrics
npm run test:metrics

# View health summary
npm run test:summary

# Pass extra Jest args
npm run test:metrics -- --runInBand
npm run test:metrics -- --testPathPattern=cache
```

## Commands

### `npm run test:metrics`

Wraps the canonical `jest --verbose` command and:

1. Runs the full test suite (or subset if you pass `--testPathPattern`).
2. Captures Jest JSON output (duration, pass/fail counts, per-test timing).
3. Appends a JSONL record to `.test-metrics/test-runs.jsonl`.
4. Prints a one-line status with pass/fail counts and duration.
5. Flags a "flake hint" if a previously-failing test now passes.

The JSONL record includes: timestamp, branch, commit, node version,
duration, pass/fail counts, failing test names, top slow tests/files,
and a flake-hint flag.

### `npm run test:summary`

Reads the JSONL history and prints:

| Section | What it shows |
|---------|---------------|
| **Failure frequency** | Tests ranked by how often they fail, with last-seen date. |
| **Flaky tests** | Tests that fail intermittently (failed in some runs, passed in others). Shows fail rate as fraction and percentage. |
| **Duration trends** | Avg/min/max suite duration over the last 10 runs, with a visual timeline. |
| **Slowest files** | Top 5 test files by average wall-clock time. |
| **Slowest tests** | Top 10 individual tests by average duration. |
| **New failures** | Tests that failed after the last fully-green run. |
| **Flake hints** | Runs where the recorder flagged potential flakiness. |

Options:

```bash
# Limit analysis to last N runs
npm run test:summary -- --last=20
```

## Invoking the Test Monitor Agent

In VS Code with GitHub Copilot, you can invoke the Test Monitor agent directly:

```
@test-monitor Run the full suite with metrics, then summarize current test health.
```

Example prompts:

- "Run all tests and report health -- flag any new failures, flaky tests, or slow tests."
- "I just modified pcgsService.js. Are there adequate tests? If not, propose new test cases."
- "The marketAggregator test suite fails intermittently. Find the root cause and fix it."
- "Which tests are slowest? Propose optimizations for the top 5."
- "Do a complete health check: run tests, check gaps, review trends, give me an action list."

The agent follows a five-step loop: **Discover -> Monitor -> Diagnose/Fix -> Improve -> Validate**.

## Interpreting Flaky + Slow Trends

### Flaky tests

A test is flagged as flaky when it fails in some runs but passes in others.
The summary shows the fail rate (e.g., `3/10 runs = 30%`).

Common root causes and fixes:

| Cause | Fix |
|-------|-----|
| Time-dependent assertions | Use `jest.useFakeTimers()` |
| Shared mutable state | Reset in `beforeEach` / `afterEach` |
| Non-deterministic ordering | Seed random data or sort before comparing |
| Real network calls leaking through | Ensure `axios-mock-adapter` covers all paths |
| Port conflicts | Use ephemeral ports or mock the server |

The agent will **never** fix flakiness by skipping tests or adding retries.
It will identify the root cause and apply a deterministic fix.

### Slow tests

The summary shows average and max duration for the slowest tests and files.

Runtime budgets:

| Scope | Budget |
|-------|--------|
| Single test | < 500ms |
| Single file | < 5s |
| Full suite | < 60s |

Tests exceeding these thresholds are flagged for optimization.

## Recommended Workflow

1. **During development**: Run targeted tests first for fast feedback.
   ```bash
   npm run test:metrics -- --testPathPattern=ebayService
   ```

2. **Before committing**: Run the full suite with metrics.
   ```bash
   npm run test:metrics
   ```

3. **Periodically**: Check the summary for trends.
   ```bash
   npm run test:summary
   ```

4. **After multiple runs**: Look for patterns in the summary --
   flaky tests accumulate signal over time. A test that fails 2/10 times
   is easier to diagnose with recorded history than a single failure.

## File Layout

```
scripts/test-metrics/
  run-with-metrics.cjs    # Test runner wrapper
  summarize.cjs           # Summary report generator

.test-metrics/
  test-runs.jsonl         # Append-only run data (gitignored)
  .gitkeep                # Keeps directory in git

.github/
  agents/
    test-monitor.agent.md # Copilot agent persona
  copilot-instructions.md # Workspace-wide rules

docs/testing/
  test-monitor.md         # This file
```
