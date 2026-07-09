// Comprehensive big-file baseline benchmark for superstring.
// Covers: load/setText, edit latency (typing), search, autocomplete, and reads.
// Run: node benchmark/_baseline.js
const { TextBuffer } = require('..')

function bench(name, fn, iterations = 1) {
  // warmup
  fn()
  const start = process.hrtime.bigint()
  for (let i = 0; i < iterations; i++) fn()
  const end = process.hrtime.bigint()
  const ms = Number(end - start) / 1e6 / iterations
  console.log(`  ${name.padEnd(46)} ${ms.toFixed(3)} ms`)
  return ms
}

async function benchAsync(name, fn, iterations = 1) {
  await fn()
  const start = process.hrtime.bigint()
  for (let i = 0; i < iterations; i++) await fn()
  const end = process.hrtime.bigint()
  const ms = Number(end - start) / 1e6 / iterations
  console.log(`  ${name.padEnd(46)} ${ms.toFixed(3)} ms`)
  return ms
}

// Build a realistic-ish source text of approximately `targetBytes` UTF-16 chars.
function makeText(targetChars) {
  const line = 'const foo = bar(baz, qux); // some comment about things\n'
  const reps = Math.ceil(targetChars / line.length)
  return line.repeat(reps)
}

const SIZES = [
  ['1 MB', 1_000_000],
  ['8 MB', 8_000_000],
  ['32 MB', 32_000_000],
]

async function main() {
for (const [label, chars] of SIZES) {
  console.log(`\n=== ${label} (${chars.toLocaleString()} chars) ===`)
  const text = makeText(chars)
  const lineCount = (text.match(/\n/g) || []).length

  // 1. Construction (load)
  bench('construct new TextBuffer(text)', () => { new TextBuffer(text) })

  // 2. setText (replace whole buffer)
  const buf = new TextBuffer('')
  bench('setText (whole buffer)', () => { buf.setText(text) })

  // 3. getText (full materialization)
  bench('getText (full copy)', () => { buf.getText() }, 5)

  // 4. Random line access
  bench('lineForRow x10000 (random)', () => {
    for (let i = 0; i < 10000; i++) buf.lineForRow((i * 7919) % lineCount)
  })

  // 5. Edit latency: single-char inserts at START (worst case for flat base)
  bench('insert 1 char x1000 @ start', () => {
    for (let i = 0; i < 1000; i++) buf.setTextInRange({ start: { row: 0, column: 0 }, end: { row: 0, column: 0 } }, 'x')
  })
  buf.setText(text) // reset

  // 6. Edit latency: single-char inserts at END
  bench('insert 1 char x1000 @ end', () => {
    const row = lineCount
    for (let i = 0; i < 1000; i++) buf.setTextInRange({ start: { row, column: 0 }, end: { row, column: 0 } }, 'x')
  })
  buf.setText(text) // reset

  // 7. Edit latency: inserts at MIDDLE
  bench('insert 1 char x1000 @ middle', () => {
    const row = Math.floor(lineCount / 2)
    for (let i = 0; i < 1000; i++) buf.setTextInRange({ start: { row, column: 0 }, end: { row, column: 0 } }, 'x')
  })
  buf.setText(text) // reset

  // 8. Search: findAllSync for a frequent token
  bench('findAllSync /bar/', () => { buf.findAllSync('bar') })

  // 9. Search: findSync (first match) for a rare token near the end
  bench('findSync /qux/', () => { buf.findSync('qux') })

  // 10. Autocomplete: findWordsWithSubsequence (async)
  await benchAsync('findWordsWithSubsequence("baz")', () => buf.findWordsWithSubsequence('baz', '', 100), 3)
}

console.log('\ndone')
}

main()
