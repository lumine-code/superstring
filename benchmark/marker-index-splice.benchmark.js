'use strict';

// Measures the JS-marshalling cost of MarkerIndex query results: every
// operation below returns Sets containing (almost) all marker ids, so the
// timings are dominated by building those Sets rather than by tree work.

const {MarkerIndex} = require('..')

const MARKER_COUNT = 10000
const SPLICE_COUNT = 1000
const QUERY_COUNT = 200

const markerIndex = new MarkerIndex()
const center = {row: 5000, column: 0}
for (let i = 0; i < MARKER_COUNT; i++) {
  markerIndex.insert(i, {row: i, column: 0}, {row: MARKER_COUNT + i, column: 0})
}

let total = 0

console.time(`${SPLICE_COUNT} splices inside ${MARKER_COUNT} markers`)
for (let i = 0; i < SPLICE_COUNT; i++) {
  const {touch, inside, overlap, surround} = markerIndex.splice(center, {row: 0, column: 0}, {row: 0, column: 1})
  total += touch.size + inside.size + overlap.size + surround.size
}
console.timeEnd(`${SPLICE_COUNT} splices inside ${MARKER_COUNT} markers`)

console.time(`${QUERY_COUNT} findIntersecting over ${MARKER_COUNT} markers`)
for (let i = 0; i < QUERY_COUNT; i++) {
  const result = markerIndex.findIntersecting({row: 0, column: 0}, {row: 2 * MARKER_COUNT, column: 0})
  total += result.size
}
console.timeEnd(`${QUERY_COUNT} findIntersecting over ${MARKER_COUNT} markers`)

console.log(`total ids marshalled: ${total}`)
