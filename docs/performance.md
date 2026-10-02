# Performance measurements

Measured on 2026-10-02 using Node v24.18.0, Windows x64, and Intel(R) Core(TM) i9-10900K CPU @ 3.70GHz. The baseline is commit 3d785eb; the optimized implementation is commit d5e5275. Both native addons were built in Release mode with the same Node and Visual Studio toolchain. These are local synthetic workload measurements, not cross-platform performance guarantees.

## Changes

Patch node creation now moves its owned old and new text into the node instead of copying UTF-16 content and line offsets. Autocomplete moves temporary scoring variants and result position vectors, reserves the final result vector, and retains at most 81 characters of a word that will be rejected for exceeding the existing 80-character limit. Its JavaScript result marshalling allocates positions only for the requested prefix of matches. Public results, ranking, scores, positions, and patch serialization are preserved.

## Method

The general runner covers 24 workloads; the patch runner covers eight. Both use deterministic local fixtures, two warmups, and the median of repeated samples (nine for general workloads, seven for patches). Each sample measures the baseline and optimized binary serially, alternating their order. Input preparation, fresh buffer/index/patch setup, explicit garbage collection, result checks, and result consumption are outside the measured region. Timings include the public JavaScript/native boundary; autocomplete includes worker scheduling and result marshalling. The general runner additionally records the median of ratios for corresponding samples to distinguish timing drift from changes in the ratio of independent medians.

Text sizes count UTF-16 code units. One Mi code units is 1,048,576 units, or 2 MiB of UTF-16 payload per text; a replacement passes both old and new text. Patch timings are milliseconds per splice; general timings are milliseconds per workload batch, with operation counts recorded in the raw data.

## Results

| Workload | Before (ms) | After (ms) | Speedup |
| --- | ---: | ---: | ---: |
| fresh replacement flat 1 Mi UTF-16 units | 4.144 | 3.126 | 1.33x |
| independent insertion and replacement flat 1 Mi UTF-16 units | 3.546 | 2.739 | 1.29x |
| fresh replacement multiline 1 Mi UTF-16 units | 4.242 | 3.448 | 1.23x |
| independent insertion and replacement multiline 1 Mi UTF-16 units | 3.414 | 2.618 | 1.30x |
| fresh replacement flat 8 Mi UTF-16 units | 29.869 | 23.289 | 1.28x |
| independent insertion and replacement flat 8 Mi UTF-16 units | 31.604 | 24.287 | 1.30x |
| fresh replacement multiline 8 Mi UTF-16 units | 35.253 | 23.889 | 1.48x |
| independent insertion and replacement multiline 8 Mi UTF-16 units | 30.057 | 23.304 | 1.29x |
| text/setText/1M UTF-16 units | 2.926 | 2.478 | 1.18x |
| text/setText/8M UTF-16 units | 24.916 | 20.699 | 1.20x |
| autocomplete/duplicate-words | 4.519 | 4.429 | 1.02x |
| autocomplete/unique-words-max10 | 34.914 | 26.952 | 1.30x |
| autocomplete/oversized-word | 73.234 | 22.363 | 3.27x |

The general runner also measures construction, full reads, random line reads, small edits, absent/frequent searches, and marker operations. Untouched controls have timing variation, so their apparent gains or losses should not be attributed to these changes. A suspicious frequent-search median was checked with 21 additional paired samples: its median paired speedup was 1.006x, with no repeatable slowdown. Full sample distributions, fixture sizes, operation counts, and binary SHA-256 values are in [the raw report](../benchmark/results/2026-10-02-win32-x64.json).

For one returned word with one position and a discarded lower-ranked word appearing one million times, the positions ArrayBuffer shrank from 8,000,016 bytes to 12 bytes. This measures that specific output allocation, not the process's total memory.

## Reproduce

Build a source checkout and run the current version:

```sh
npm run build:node
npm run benchmark
npm run benchmark:patch
```

Save the Release native addon from each revision as separate files, then compare them using the same checkout's JavaScript wrapper and fixtures:

```sh
node --expose-gc benchmark/performance.benchmark.js --binding before.node --compare-binding after.node --json
node --expose-gc benchmark/patch-splice.benchmark.js --module ./before.node --compare-module ./after.node
```

Use `--filter autocomplete` on the general runner for a focused measurement. Its `--samples` and `--warmups` options control repetitions, and `--json` records every sample.

## Correctness

All 139 JavaScript specs and 57 native test cases (116,260 assertions) passed locally. New cases cover result limits, result independence, the 80/81-character boundary, oversized word tails, and words split across edit chunks. Native regression cases cover ownership of large multiline patch text through caller destruction, patch copy/inversion/serialization, competing scoring paths, repeated queries, and snapshots. An additional deterministic differential check compared 458 autocomplete results over 400 generated corpora against the baseline with zero discrepancies. A Release addon smoke test passed under the editor's Electron 44.5.1 (Node 24.21.0, Node-API 10); package validation passed and npm audit reported zero vulnerabilities. Cross-platform CI outcomes are reported with the change.
