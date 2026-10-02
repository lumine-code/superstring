'use strict'

// Use --module <path> for one addon, or add --compare-module <path> to alternate
// two addons within each sample and reduce bias from timing drift.
// Payload creation, GC and correctness checks are outside the measured region.
const assert = require('node:assert/strict')
const path = require('node:path')
const {performance} = require('node:perf_hooks')

const moduleFlag = process.argv.indexOf('--module')
const modulePath = moduleFlag < 0 ? '..' : path.resolve(process.argv[moduleFlag + 1])
const {Patch} = require(modulePath)
const compareFlag = process.argv.indexOf('--compare-module')
const compareModulePath = compareFlag < 0 ? undefined : path.resolve(process.argv[compareFlag + 1])
const bindings = [{Patch, module: modulePath}]
if (compareModulePath) bindings.push({Patch: require(compareModulePath).Patch, module: compareModulePath})
const SAMPLES = 7
const WARMUPS = 2
const zero = {row: 0, column: 0}

console.log(JSON.stringify({node: process.version, platform: process.platform,
  arch: process.arch, module: modulePath, compareModule: compareModulePath,
  samples: SAMPLES, warmups: WARMUPS, order: bindings.length === 2 ? 'alternating' : 'single',
  gc: typeof global.gc === 'function'}))

function payload (length, multiline, character) {
  const line = character.repeat(127) + '\n'
  const text = multiline ? line.repeat(length / line.length) : character.repeat(length)
  // Flatten ropes before entering N-API's UTF-16 conversion.
  return Buffer.from(text, 'utf16le').toString('utf16le')
}

function runCase (length, multiline, independent) {
  const oldText = payload(length, multiline, 'a')
  const newText = payload(length, multiline, 'b')
  const extent = multiline ? {row: length / 128, column: 0} : {row: 0, column: length}
  const later = {row: extent.row + 1, column: 0}
  const iterations = length === 1024 * 1024 ? 24 : 4
  const samples = bindings.map(() => [])
  const operations = independent ? 2 : 1

  function measure (Patch) {
    if (global.gc) global.gc()
    const patches = Array.from({length: iterations}, () => new Patch())
    const start = performance.now()
    for (const patch of patches) {
      patch.splice(zero, independent ? zero : extent, extent,
        independent ? '' : oldText, newText)
      if (independent) patch.splice(later, extent, extent, oldText, newText)
    }
    const elapsed = performance.now() - start
    const changes = patches[0].getChanges()
    assert.equal(changes.length, operations)
    assert.equal(changes[0].newText, newText)
    assert.equal(changes[changes.length - 1].oldText, oldText)
    assert.equal(changes[changes.length - 1].newText, newText)
    return elapsed / (iterations * operations)
  }

  for (let sample = -WARMUPS; sample < SAMPLES; sample++) {
    const order = bindings.length === 2 && sample % 2 !== 0 ? [1, 0] : bindings.map((_, i) => i)
    for (const index of order) {
      const elapsed = measure(bindings[index].Patch)
      if (sample >= 0) samples[index].push(elapsed)
    }
  }

  function summarize (index) {
    const sorted = samples[index].slice().sort((a, b) => a - b)
    return {module: bindings[index].module, medianMs: sorted[SAMPLES >> 1],
      minMs: sorted[0], maxMs: sorted[SAMPLES - 1], samplesMs: samples[index]}
  }
  const result = {case: `${independent ? 'independent insertion and replacement' : 'fresh replacement'} ${multiline ? 'multiline' : 'flat'} ${length / 1024 / 1024} Mi UTF-16 units`,
    iterations, operations}
  if (bindings.length === 1) {
    Object.assign(result, summarize(0))
  } else {
    result.baseline = summarize(0)
    result.comparison = summarize(1)
    result.speedup = result.baseline.medianMs / result.comparison.medianMs
  }
  console.log(JSON.stringify(result))
}

for (const length of [1024 * 1024, 8 * 1024 * 1024]) {
  for (const multiline of [false, true]) {
    for (const independent of [false, true]) runCase(length, multiline, independent)
  }
}
