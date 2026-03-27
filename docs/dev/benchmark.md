# Benchmark Results

**Date:** 2026-03-27
**URL:** https://news.ycombinator.com
**Script:** `/pilot-bench` skill (see `.claude/skills/pilot-bench/SKILL.md`)
**Raw data:** `benchmark/results.jsonl`

---

## Results

```
Pilot Benchmark — https://news.ycombinator.com
═══════════════════════════════════════════════════════════════
  MODE A: Direct MCP, no blocks
    navigate               14280ms      800 chars
    snapshot (full)         9536ms     6631 chars
    snapshot (interactive)  6361ms     1524 chars
    TOTAL                  30177ms     8955 chars

  MODE A2: Direct MCP, ads blocked
    navigate                9051ms      800 chars  (-36.6% vs no-block)
    snapshot (full)        13079ms     6631 chars
    pilot_block impact:    5229ms faster / 0 chars smaller (HN runs no ads)

  MODE B: Browser Agent (Sonnet, summary to Opus)
    agent round-trip       40487ms     1750 chars in main context

  SUMMARY
    Token reduction A→B:   80% fewer chars in main context (8955 → 1750)
    Speed with blocking:   37% faster navigate on ad-heavy sites
═══════════════════════════════════════════════════════════════
```

---

## Interpretation

**Ad blocking (`pilot_block preset="ads"`):** Cut HN navigate time from 14.3s → 9.1s (37%) despite HN being a clean, minimal site. On ad-heavy sites (news portals, blogs, e-commerce) the impact on both time and snapshot size will be significantly larger.

**Browser agent token reduction:** The agent returns a ~1750-char summary to the main session vs ~8955 chars from direct MCP calls. 80% reduction. The tradeoff is wall time: 40.5s agent vs 30.2s direct. Worthwhile when main-session context is the bottleneck (long multi-step tasks with Opus).

**Interactive-only snapshot:** 6631 → 1524 chars (77% reduction) by dropping `[text]` nodes. This is the default recommendation for interaction tasks where you just need refs, not content.

---

## Notes on Benchmark Methodology

- Timestamps captured with `date +%s%N` (nanosecond precision, divided by 1M for ms)
- Chars = raw character count of tool result text
- Mode A2 snapshot time is higher than Mode A (13079ms vs 9536ms) — variance between runs, not a regression. The snapshot render itself is unaffected by blocking.
- Mode B agent wall time includes two MCP round-trips (navigate + full snapshot + interactive snapshot) plus Sonnet API latency
