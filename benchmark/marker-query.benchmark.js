'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const os = require('node:os')
const {performance} = require('node:perf_hooks')
const options = {samples: 9, warmups: 2, iterations: 100, filter: '.*',
  binding: path.resolve(__dirname, '../build/Release/superstring.node')}
for (let i = 2; i < process.argv.length; i++) {
  const flag = process.argv[i]
  assert(['--samples', '--warmups', '--iterations', '--filter', '--binding'].includes(flag), `Unknown option ${flag}`)
  const value = process.argv[++i]
  assert(value !== undefined, `Missing value for ${flag}`)
  options[flag.slice(2)] = ['--samples', '--warmups', '--iterations'].includes(flag) ? Number(value) : value
}
assert(Number.isInteger(options.samples) && options.samples > 0)
assert(Number.isInteger(options.warmups) && options.warmups >= 0)
assert(Number.isInteger(options.iterations) && options.iterations > 0)
const {MarkerIndex} = require(path.resolve(options.binding))
const selected = new RegExp(options.filter)
const zero = {row: 0, column: 0}
let checksum = 0
console.log(JSON.stringify({node: process.version, platform: process.platform, architecture: process.arch,
  cpu: os.cpus()[0]?.model, binding: path.resolve(options.binding), ...options, gc: !!global.gc}))

function summarize (samples) {
  const sorted = samples.slice().sort((a, b) => a - b)
  return {medianMsPerOperation: sorted[sorted.length >> 1], minMs: sorted[0], maxMs: sorted.at(-1), samplesMs: samples}
}

for (const count of [1000, 10000]) for (const dense of [false, true]) for (const all of [false, true]) {
  const center = {row: dense ? count : 2 * count, column: 0}
  const start = all ? zero : center
  const end = {row: all ? 4 * count : center.row + 80, column: 0}
  const expectedIds = Uint32Array.from(Array.from({length: count}, (_, id) => id)
    .filter(id => dense || all || (4 * id >= 2 * count && 4 * id <= 2 * count + 80)))
  const base = `${dense ? 'dense' : 'sparse'}/${all ? 'all' : 'screen80'}/${count}`
  const rangeCount = Math.min(expectedIds.length, 200)
  const rangeIds = new Uint32Array(rangeCount)
  let index, insertions = 0
  function ensureIndex () {
    if (index) return
    index = new MarkerIndex(1)
    for (let id = 0; id < count; id++) index.insert(id,
      {row: dense ? id : 4 * id, column: 0},
      {row: dense ? 3 * count + id : 4 * id, column: dense ? 0 : 10})
  }
  const modes = {
    query () { return index.findIntersecting(start, end) },
    'splice-query-ranges' () {
      const invalidated = index.splicePacked(center, zero, {row: 0, column: 1})
      insertions++
      if (invalidated) checksum += invalidated.length
      const ids = index.findIntersecting(start, end)
      let i = 0
      for (const id of ids) {
        if (i === rangeCount) break
        rangeIds[i++] = id
      }
      const ranges = index.getRanges(rangeIds)
      checksum += ranges[0] ?? 0
      return ids
    },
    // Bounds for the Set construction component; neither control runs C++ queries.
    'set-existing-typed-array' () { return new Set(expectedIds) },
    'set-new-typed-array' () { return new Set(new Uint32Array(expectedIds)) }
  }
  const measurements = {}
  const enabled = Object.keys(modes).filter(mode => selected.test(`${base}/${mode}`))
  if (!enabled.length) continue
  if (enabled.some(mode => mode === 'query' || mode === 'splice-query-ranges')) ensureIndex()
  for (const mode of enabled) measurements[mode] = []
  // Rotate mode order within each sample, reducing drift between queries and controls.
  for (let sample = -options.warmups; sample < options.samples; sample++) {
    const offset = ((sample % enabled.length) + enabled.length) % enabled.length
    const order = enabled.slice(offset).concat(enabled.slice(0, offset))
    for (const mode of order) {
      if (global.gc) global.gc()
      let result
      const started = performance.now()
      for (let operation = 0; operation < options.iterations; operation++) {
        result = modes[mode]()
        checksum += result.size
      }
      const elapsed = (performance.now() - started) / options.iterations
      assert.deepEqual([...result], [...expectedIds], `${base}/${mode} result/order`)
      if (mode === 'splice-query-ranges' && !dense) {
        assert.deepEqual(index.getRange(count / 2), {start: center, end: {row: center.row, column: 10 + insertions}})
      }
      if (sample >= 0) measurements[mode].push(elapsed)
    }
  }
  for (const mode of enabled) console.log(JSON.stringify({case: `${base}/${mode}`,
    markers: count, expectedIds: expectedIds.length, rangeCount: mode === 'splice-query-ranges' ? rangeCount : 0,
    ...summarize(measurements[mode])}))
}
console.log(JSON.stringify({checksum}))
