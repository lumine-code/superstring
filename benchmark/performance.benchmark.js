'use strict'

// Run with --expose-gc to collect discarded native buffers between samples.
// Setup, garbage collection, result consumption and assertions are not timed.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {createRequire} = require('node:module')
const {compileFunction} = require('node:vm')

const options = {samples: 9, warmups: 2, json: false, filter: null}
for (let i = 2; i < process.argv.length; i++) {
  const argument = process.argv[i]
  if (argument === '--json') options.json = true
  else if (argument === '--help') {
    console.log('Usage: node --expose-gc benchmark/performance.benchmark.js [--json] [--filter REGEXP] [--samples N] [--warmups N] [--binding FILE.node [--compare-binding OTHER.node] | --module DIRECTORY]')
    process.exit(0)
  } else if (['--filter', '--samples', '--warmups', '--binding', '--compare-binding', '--module'].includes(argument)) {
    const value = process.argv[++i]
    assert(value && !value.startsWith('--'), `${argument} requires a value`)
    options[argument === '--compare-binding' ? 'compareBinding' : argument.slice(2)] = value
  } else throw new Error(`Unknown argument: ${argument}`)
}
options.samples = Number(options.samples)
options.warmups = Number(options.warmups)
assert(Number.isInteger(options.samples) && options.samples >= 7, '--samples must be at least 7')
assert(Number.isInteger(options.warmups) && options.warmups >= 1, '--warmups must be at least 1')
assert(!(options.binding && options.module), 'Choose --binding or --module')
assert(!options.compareBinding || options.binding, '--compare-binding requires --binding')
if (options.compareBinding) assert.notEqual(fs.realpathSync(options.binding), fs.realpathSync(options.compareBinding), 'Comparison bindings must have distinct paths')
const filter = options.filter ? new RegExp(options.filter) : null

const modulePath = options.module ? path.resolve(options.module) : path.resolve(__dirname, '..')
function loadPackage(bindingPath) {
  if (!bindingPath) return require(modulePath)
  // Reuse the public wrapper without changing its source or requiring a current
  // build. Its native imports are redirected only inside this wrapper instance.
  const binding = require(path.resolve(bindingPath))
  const filename = path.join(modulePath, 'index.js')
  const normalRequire = createRequire(filename)
  const wrapperRequire = request => {
    if (request === './build/Release/superstring.node' || request === './build/Debug/superstring.node') return binding
    return normalRequire(request)
  }
  const wrapperModule = {exports: {}}
  const execute = compileFunction(fs.readFileSync(filename, 'utf8'), ['exports', 'require', 'module', '__filename', '__dirname'], {filename})
  execute.call(wrapperModule.exports, wrapperModule.exports, wrapperRequire, wrapperModule, filename, modulePath)
  return wrapperModule.exports
}
const packages = [loadPackage(options.binding)]
if (options.compareBinding) packages.push(loadPackage(options.compareBinding))
let {TextBuffer, MarkerIndex} = packages[0]
const benchmarks = []
let checksum = 0

function add(name, workload, setup, run, verify) {
  if (!filter || filter.test(name)) benchmarks.push({name, workload, setup, run, verify})
}

const sourceLine = 'const sample_value = bar(baz, qux); // lorem ipsum editor 😀\n'
for (const targetUnits of [1_000_000, 8_000_000]) {
  const rowCount = Math.ceil(targetUnits / sourceLine.length)
  const text = Buffer.from(sourceLine.repeat(rowCount), 'utf16le').toString('utf16le')
  const label = `${targetUnits / 1_000_000}M UTF-16 units`
  const workload = {utf16Units: text.length, rows: rowCount + 1, operations: 1}
  const fresh = () => new TextBuffer(text)

  add(`text/construct/${label}`, workload, () => text,
    input => new TextBuffer(input), result => {
      assert.equal(result.getText(), text)
      return result.getLength()
    })
  add(`text/setText/${label}`, workload, () => new TextBuffer('old text'), buffer => {
    buffer.setText(text)
    return buffer
  }, result => {
    assert.equal(result.getText(), text)
    return result.getLength()
  })
  add(`text/getText/${label}`, workload, fresh, buffer => buffer.getText(), result => {
    assert.equal(result, text)
    return result.length
  })

  const readCount = 10000
  const rows = Array.from({length: readCount}, (_, i) => (i * 7919 + 31) % rowCount)
  add(`text/randomLines/${label}`, {...workload, operations: readCount}, fresh, buffer => {
    let total = 0
    for (const row of rows) total += buffer.lineForRow(row).length
    return total
  }, result => {
    assert.equal(result, readCount * (sourceLine.length - 1))
    return result
  })

  const editCount = 250
  for (const [positionName, row] of [['start', 0], ['middle', Math.floor(rowCount / 2)], ['end', rowCount]]) {
    const position = {row, column: 0}
    const range = {start: position, end: position}
    const offset = row * sourceLine.length
    const expected = text.slice(0, offset) + 'x'.repeat(editCount) + text.slice(offset)
    add(`text/insert-${positionName}/${label}`, {...workload, operations: editCount}, fresh, buffer => {
      for (let i = 0; i < editCount; i++) buffer.setTextInRange(range, 'x')
      return buffer
    }, result => {
      assert.equal(result.getText(), expected)
      return result.getLength()
    })
  }

  add(`search/absent/${label}`, workload, fresh, buffer => buffer.findSync('absent_token_xyz'), result => {
    assert.equal(result, null)
    return 1
  })
  add(`search/frequent/${label}`, workload, fresh, buffer => buffer.findAllSync('bar'), result => {
    assert.equal(result.length, rowCount)
    assert.deepEqual(result[0], {start: {row: 0, column: 21}, end: {row: 0, column: 24}})
    assert.equal(result[result.length - 1].start.row, rowCount - 1)
    return result.length
  })
}

const duplicateRows = 10000
const duplicateText = Buffer.from('banana bandana ban_ana bandaid band bNa\n'.repeat(duplicateRows), 'utf16le').toString('utf16le')
add('autocomplete/duplicate-words', {utf16Units: duplicateText.length, rows: duplicateRows + 1, operations: 1},
  () => new TextBuffer(duplicateText), buffer => buffer.findWordsWithSubsequence('bna', '_', 10), result => {
    assert.deepEqual(result.map(match => match.word), ['bNa', 'ban_ana', 'banana', 'bandana', 'bandaid'])
    for (const match of result) assert.equal(match.positions.length, duplicateRows)
    return result.reduce((total, match) => total + match.positions.length, 0)
  })

const uniqueWords = Array.from({length: 12000}, (_, i) => `candidate_word_${i}`)
const uniqueText = uniqueWords.join('\n')
const uniqueWordSet = new Set(uniqueWords)
add('autocomplete/unique-words-max10', {utf16Units: uniqueText.length, rows: uniqueWords.length, maxCount: 10, operations: 1},
  () => new TextBuffer(uniqueText), buffer => buffer.findWordsWithSubsequence('caw', '_', 10), result => {
    assert.equal(result.length, 10)
    const seen = new Set()
    for (const match of result) {
      assert(uniqueWordSet.has(match.word))
      assert.equal(match.positions.length, 1)
      assert(!seen.has(match.word))
      seen.add(match.word)
    }
    return seen.size
  })

const oversizedText = Buffer.from('a'.repeat(8_000_000) + '\nbanana', 'utf16le').toString('utf16le')
add('autocomplete/oversized-word', {utf16Units: oversizedText.length, rows: 2, operations: 1},
  () => new TextBuffer(oversizedText), buffer => buffer.findWordsWithSubsequence('bna', '', 10), result => {
    assert.equal(result.length, 1)
    assert.equal(result[0].word, 'banana')
    assert.deepEqual(result[0].positions, [{row: 1, column: 0}])
    return result[0].word.length
  })

const markerCount = 10000
const allIds = Uint32Array.from({length: markerCount}, (_, i) => i)
const start = {row: 0, column: 0}
const end = {row: 2 * markerCount, column: 0}
const center = {row: markerCount / 2, column: 0}
const zero = {row: 0, column: 0}
const inserted = {row: 0, column: 1}
function freshMarkers() {
  const index = new MarkerIndex(1)
  for (let i = 0; i < markerCount; i++) {
    index.insert(i, {row: i, column: 0}, {row: markerCount + i, column: 0})
  }
  return index
}

const queryCount = 100
add('markers/intersecting-all', {markers: markerCount, operations: queryCount}, freshMarkers, index => {
  let total = 0
  for (let i = 0; i < queryCount; i++) total += index.findIntersecting(start, end).size
  return total
}, result => {
  assert.equal(result, markerCount * queryCount)
  return result
})
add('markers/getRanges-all', {markers: markerCount, operations: queryCount}, freshMarkers, index => {
  let result
  for (let i = 0; i < queryCount; i++) result = index.getRanges(allIds)
  return result
}, result => {
  assert.equal(result.length, markerCount * 4)
  for (let i = 0; i < markerCount; i++) {
    assert.equal(result[i * 4], i)
    assert.equal(result[i * 4 + 1], 0)
    assert.equal(result[i * 4 + 2], markerCount + i)
    assert.equal(result[i * 4 + 3], 0)
  }
  return result.length
})
const spliceCount = 100
add('markers/splicePacked-overlapping', {markers: markerCount, operations: spliceCount, touchedPerSplice: markerCount / 2 + 1}, freshMarkers, index => {
  let total = 0
  for (let i = 0; i < spliceCount; i++) {
    const invalidated = index.splicePacked(center, zero, inserted)
    total += invalidated ? invalidated.length : 0
  }
  return {index, total}
}, result => {
  assert.equal(result.total, spliceCount * (markerCount / 2 + 1) * 2)
  assert.deepEqual(result.index.getStart(markerCount / 2), {row: markerCount / 2, column: 0})
  assert.deepEqual(result.index.getEnd(0), {row: markerCount, column: 0})
  return result.total
})

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function summarize(samplesMs) {
  return {medianMs: median(samplesMs), minMs: Math.min(...samplesMs), maxMs: Math.max(...samplesMs), samplesMs}
}

function bindingHash(bindingPath) {
  return require('node:crypto').createHash('sha256').update(fs.readFileSync(path.resolve(bindingPath))).digest('hex')
}

async function main() {
  assert(benchmarks.length > 0, 'No benchmarks matched --filter')
  const report = {
    environment: {
      node: process.version, v8: process.versions.v8, napi: process.versions.napi,
      platform: process.platform, architecture: process.arch, cpu: os.cpus()[0]?.model,
      logicalCpus: os.cpus().length, binding: options.binding ? path.resolve(options.binding) : modulePath,
      bindingSha256: options.binding ? bindingHash(options.binding) : undefined,
      comparisonBinding: options.compareBinding ? path.resolve(options.compareBinding) : undefined,
      comparisonBindingSha256: options.compareBinding ? bindingHash(options.compareBinding) : undefined,
      gcBetweenSamples: typeof global.gc === 'function'
    },
    methodology: {samples: options.samples, warmups: options.warmups, statistic: 'median', unit: 'ms per batch', setupTimed: false},
    results: []
  }
  if (options.compareBinding) {
    report.methodology.pairedComparison = true
    report.methodology.order = 'Alternate baseline-first and comparison-first within each warmup and sample'
  }
  if (!options.json) console.log(`${report.environment.node}, ${report.environment.platform} ${report.environment.architecture}, ${report.environment.cpu}\n${options.samples} samples after ${options.warmups} warmups; times are milliseconds per batch. Text sizes are UTF-16 code units.`)

  const checksums = packages.map(() => 0)
  for (const benchmark of benchmarks) {
    const samplesByVariant = packages.map(() => [])
    for (let sample = -options.warmups; sample < options.samples; sample++) {
      const order = options.compareBinding ? ((sample + options.warmups) % 2 ? [1, 0] : [0, 1]) : [0]
      for (const variant of order) {
        ;({TextBuffer, MarkerIndex} = packages[variant])
        if (global.gc) global.gc()
        const state = benchmark.setup()
        const started = process.hrtime.bigint()
        let result = benchmark.run(state)
        if (result && typeof result.then === 'function') result = await result
        const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
        const consumed = benchmark.verify(result)
        checksum = (checksum + consumed) % 0x100000000
        checksums[variant] = (checksums[variant] + consumed) % 0x100000000
        if (sample >= 0) samplesByVariant[variant].push(elapsedMs)
      }
    }
    const result = {name: benchmark.name, workload: benchmark.workload}
    if (options.compareBinding) {
      result.baseline = summarize(samplesByVariant[0])
      result.comparison = summarize(samplesByVariant[1])
      result.speedup = result.baseline.medianMs / result.comparison.medianMs
      result.pairedSpeedupMedian = median(samplesByVariant[0].map((elapsed, i) => elapsed / samplesByVariant[1][i]))
    } else Object.assign(result, summarize(samplesByVariant[0]))
    report.results.push(result)
    if (!options.json) {
      if (options.compareBinding) console.log(`${result.name.padEnd(43)} ${result.baseline.medianMs.toFixed(3).padStart(10)} -> ${result.comparison.medianMs.toFixed(3).padStart(10)} ms  ${result.speedup.toFixed(2)}x`)
      else console.log(`${result.name.padEnd(43)} ${result.medianMs.toFixed(3).padStart(10)} ms  [${result.minMs.toFixed(3)}, ${result.maxMs.toFixed(3)}]`)
    }
  }
  if (options.compareBinding) {
    assert.equal(checksums[0], checksums[1], 'Compared builds produced different checksums')
    report.checksums = {baseline: checksums[0], comparison: checksums[1]}
  }
  report.checksum = checksum
  if (options.json) console.log(JSON.stringify(report, null, 2))
  else console.log(`Checksum: ${checksum}`)
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
