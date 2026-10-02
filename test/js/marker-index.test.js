const Random = require('random-seed')
const {traverse, traversalDistance, compare, isZero, max, format: formatPoint} = require('./helpers/point-helpers')
const {assert} = require('./helpers/assert')
const {MarkerIndex} = require('../..')
const MAX_INT32 = 4294967296

describe('MarkerIndex', () => {
  describe('queries covering every marker endpoint', () => {
    const point = (row, column) => ({row, column})
    const zero = point(0, 0)
    const infinite = point(Infinity, Infinity)
    const maximum = 0xffffffff

    it('keeps sorted Set results for finite and Infinity bounds after edits and removals', () => {
      const index = new MarkerIndex(7)
      index.insert(maximum, point(2, 0), point(2, 0))
      index.insert(31, zero, point(10, 3))
      index.insert(0, point(1, 2), point(1, 2))
      index.insert(8, point(1, 2), point(1, 2))
      index.insert(99, point(12, 0), point(12, 0))
      index.setExclusive(8, true)
      const all = [0, 8, 31, 99, maximum]
      for (const end of [point(12, 0), infinite]) {
        const result = index.findIntersecting(zero, end)
        assert(result instanceof Set)
        assert.deepEqual([...result], all)
      }
      assert.deepEqual([...index.findIntersecting(zero, point(10, 3))], [0, 8, 31, maximum])
      assert.deepEqual([...index.findIntersecting(point(2, 0), infinite)], [31, 99, maximum])
      index.splice(point(1, 2), zero, point(0, 3))
      assert.deepEqual(index.getRange(0), {start: point(1, 2), end: point(1, 5)})
      assert.deepEqual(index.getRange(8), {start: point(1, 5), end: point(1, 5)})
      assert.deepEqual([...index.findIntersecting(zero, point(12, 0))], all)
      index.remove(31)
      index.splice(point(1, 0), point(1, 0), zero)
      for (const id of [0, 8, maximum]) {
        assert.deepEqual(index.getRange(id), {start: point(1, 0), end: point(1, 0)})
      }
      for (const end of [point(11, 0), infinite]) {
        assert.deepEqual([...index.findIntersecting(zero, end)], [0, 8, 99, maximum])
      }
      for (const id of [0, 8, 99, maximum]) index.remove(id)
      assert.deepEqual([...index.findIntersecting(zero, infinite)], [])
    })

    it('retains orphaned endpoint visibility after duplicate-ID removal and reinsertion', () => {
      for (let scenario = 0; scenario < 3; scenario++) {
        const index = new MarkerIndex(1)
        index.insert(7, point(1, 0), point(5, 0))
        index.insert(7, point(scenario === 0 ? 1 : 3, 0), point(scenario === 1 ? 5 : 9, 0))
        index.remove(7)
        assert.isFalse(index.has(7))
        assert.deepEqual([...index.findIntersecting(zero, infinite)], [7])
        index.insert(7, zero, point(2, 0))
        index.remove(7)
        index.insert(maximum, point(12, 0), point(12, 0))
        assert.deepEqual([...index.findIntersecting(zero, point(12, 0))], [7, maximum])
      }
    })

    it('preserves finite column limits when row saturation changes endpoint ordering', () => {
      const index = new MarkerIndex(0)
      index.insert(0, zero, zero)
      index.insert(1, point(maximum - 1, 30), point(maximum - 1, 30))
      index.insert(2, point(maximum, 0), point(maximum, 0))
      index.splice(zero, zero, point(1, 0))
      assert.deepEqual([...index.findIntersecting(zero, point(maximum, 0))], [0])
      assert.deepEqual([...index.findIntersecting(zero, point(Infinity, 0))], [0])
      assert.deepEqual([...index.findIntersecting(zero, infinite)], [0, 1, 2])
    })
  })

  describe('remove with an unknown id', () => {
    it('ignores a removal from an empty index', () => {
      const index = new MarkerIndex(1)
      index.remove(1)
      assert.isFalse(index.has(1))
      assert.deepEqual(index.dump(), {})
    })

    it('keeps surrounding markers intact after repeated and unknown removals', () => {
      const index = new MarkerIndex(1)
      index.insert(1, {row: 0, column: 0}, {row: 0, column: 5})
      index.insert(2, {row: 1, column: 0}, {row: 1, column: 5})
      index.setExclusive(1, true)
      index.setExclusive(2, true)

      index.remove(999)
      assert.isTrue(index.has(1))
      assert.deepEqual(index.getRange(1), {start: {row: 0, column: 0}, end: {row: 0, column: 5}})

      index.remove(1)
      index.remove(1)
      index.remove(999)
      assert.isFalse(index.has(1))
      assert.isTrue(index.has(2))
      assert.deepEqual(index.getRange(2), {start: {row: 1, column: 0}, end: {row: 1, column: 5}})
      assert.deepEqual([...index.findIntersecting({row: 0, column: 0}, {row: 2, column: 0})], [2])

      index.insert(3, {row: 1, column: 1}, {row: 1, column: 2})
      index.splice({row: 1, column: 0}, {row: 0, column: 0}, {row: 0, column: 2})
      assert.deepEqual(index.getRange(2), {start: {row: 1, column: 2}, end: {row: 1, column: 7}})
      assert.deepEqual(index.getRange(3), {start: {row: 1, column: 3}, end: {row: 1, column: 4}})
    })
  })

  describe('packed marker transfer', () => {
    const point = (row, column) => ({row, column})
    const zero = point(0, 0)
    const strategies = ['touch', 'inside', 'overlap', 'surround']
    const scalarRanges = (index, ids) => new Uint32Array(Array.from(ids).flatMap(id => {
      const {start, end} = index.getRange(id)
      return [start.row, start.column, end.row, end.column]
    }))

    function checkSplice (scalar, packed, start, oldExtent, newExtent, message) {
      const expected = scalar.splice(start, oldExtent, newExtent)
      const actual = packed.splicePacked(start, oldExtent, newExtent)
      for (const strategy of strategies) {
        for (const id of expected[strategy]) assert(expected.touch.has(id), message)
      }
      if (expected.touch.size === 0) {
        assert.isNull(actual, message)
      } else {
        assert(actual instanceof Uint32Array, message)
        const values = [...expected.touch].sort((a, b) => a - b).flatMap(id => [
          id, strategies.reduce((flags, strategy, bit) => flags | (expected[strategy].has(id) ? 1 << bit : 0), 0)
        ])
        assert.deepEqual([...actual], values, message)
      }
      assert.deepEqual(packed.dump(), scalar.dump(), message)
      return actual
    }

    it('matches all invalidation strategies at inclusive, exclusive and point boundaries', () => {
      const markers = [
        [8, point(0, 0), point(4, 0)],
        [3, point(1, 2), point(1, 7)],
        [5, point(1, 2), point(1, 2)],
        [0, point(1, 7), point(1, 7)],
        [0xffffffff, point(2, 0), point(3, 3)],
        [7, point(0, 0), point(0, 0)]
      ]
      const edits = [
        [point(1, 2), zero, point(0, 3)],
        [point(1, 7), zero, point(1, 0)],
        [point(1, 3), point(0, 2), zero],
        [point(1, 0), point(2, 4), point(1, 8)],
        [point(1, 3), point(0, 2), point(0, 2)],
        [point(1, 2), zero, zero],
        [point(5, 0), zero, point(1, 2)]
      ]
      for (const exclusive of [false, true]) {
        for (const edit of edits) {
          const scalar = new MarkerIndex(7)
          const packed = new MarkerIndex(7)
          for (const index of [scalar, packed]) {
            for (const [id, start, end] of markers) {
              index.insert(id, start, end)
              index.setExclusive(id, exclusive)
            }
          }
          checkSplice(scalar, packed, ...edit, JSON.stringify({exclusive, edit}))
          const ids = new Uint32Array([0xffffffff, 5, 0, 8, 3, 7, 5, 99])
          assert.deepEqual(packed.getRanges(ids), scalarRanges(scalar, ids))
        }
      }
    })

    it('returns null for untouched edits even when later marker positions move', () => {
      const index = new MarkerIndex(3)
      assert.isNull(index.splicePacked(zero, zero, point(0, 3)))
      index.insert(1, point(0, 10), point(0, 20))
      assert.isNull(index.splicePacked(zero, zero, point(0, 3)))
      assert.deepEqual(index.getRange(1), {start: point(0, 13), end: point(0, 23)})
      assert.isNull(index.splicePacked(point(0, 30), point(0, 2), point(0, 2)))
      assert.isNull(index.splicePacked(point(0, 15), zero, zero))
      assert.deepEqual([...index.splicePacked(point(0, 15), point(0, 2), point(0, 2))], [1, 3])
    })

    it('matches scalar operations through deterministic insert, remove and undo-like edit sequences', () => {
      for (let seed = 0; seed < 30; seed++) {
        const random = new Random(seed)
        const scalar = new MarkerIndex(seed)
        const packed = new MarkerIndex(seed)
        const ids = []
        let nextId = 1
        for (let step = 0; step < 80; step++) {
          const action = random(10)
          const message = `Seed ${seed}, step ${step}`
          if (action < 4 || ids.length === 0) {
            const id = nextId++
            const start = point(random(5), random(20))
            const end = traverse(start, point(random(3), random(12)))
            const exclusive = !!random(2)
            ids.push(id)
            for (const index of [scalar, packed]) {
              index.insert(id, start, end)
              index.setExclusive(id, exclusive)
            }
          } else if (action === 4) {
            const offset = random(ids.length)
            for (const index of [scalar, packed]) index.remove(ids[offset])
            ids.splice(offset, 1)
          } else if (action === 5) {
            const id = ids[random(ids.length)]
            const exclusive = !!random(2)
            for (const index of [scalar, packed]) index.setExclusive(id, exclusive)
          } else {
            const start = point(random(7), random(20))
            const oldExtent = point(random(3), random(8))
            const newExtent = point(random(3), random(8))
            checkSplice(scalar, packed, start, oldExtent, newExtent, message)
            if (action === 9) checkSplice(scalar, packed, start, newExtent, oldExtent, message)
          }
          const requested = new Uint32Array([nextId + 10, ...ids.slice().reverse(), ids[0] || 0, 0xffffffff])
          assert.deepEqual(packed.getRanges(requested), scalarRanges(scalar, requested), message)
          assert.deepEqual(packed.dump(), scalar.dump(), message)
        }
      }
    })

    it('preserves maximum coordinates, Infinity endpoints and historical reversed ranges', () => {
      const maximum = 0xffffffff
      const scalar = new MarkerIndex(2)
      const packed = new MarkerIndex(2)
      for (const index of [scalar, packed]) {
        index.insert(maximum, point(10, 0), point(Infinity, Infinity))
        index.insert(0, point(0, 20), point(0, 10))
      }
      for (const column of [1, 14, 25]) {
        checkSplice(scalar, packed, point(0, column), point(0, 2), point(0, 2))
      }
      checkSplice(scalar, packed, point(20, 1), point(0, 2), point(0, 2))
      checkSplice(scalar, packed, point(maximum, maximum - 1), point(0, 1), point(0, 1))
      const ids = new Uint32Array([maximum, 0, maximum, 123])
      assert.deepEqual(packed.getRanges(ids), scalarRanges(scalar, ids))
      assert.deepEqual([...packed.getRanges(new Uint32Array([maximum]))], [10, 0, maximum, maximum])
    })

    it('uses the same scalar point conversions and rejects malformed splice arguments without mutations', () => {
      const scalar = new MarkerIndex(2)
      const packed = new MarkerIndex(2)
      for (const index of [scalar, packed]) index.insert(1, point(0, 1), point(1, 3))
      checkSplice(scalar, packed, point(-1, -4), point(-1, 0.9), point(0, 2.8))
      const before = packed.dump()
      for (let slot = 0; slot < 3; slot++) {
        for (const invalid of [undefined, null, false, 1, {}, {row: 0}, point(0, '1'), {column: 1}]) {
          const args = [zero, zero, zero]
          args[slot] = invalid
          let legacyError
          try { scalar.splice(...args) } catch (error) { legacyError = error }
          assert(legacyError)
          assert.throws(() => packed.splicePacked(...args), error => error.constructor === legacyError.constructor && error.message === legacyError.message)
          assert.deepEqual(packed.dump(), before)
          assert.deepEqual(scalar.dump(), before)
        }
        for (const property of ['row', 'column']) {
          const failure = new Error(`Throwing ${property}, argument ${slot}`)
          const invalid = point(0, 0)
          Object.defineProperty(invalid, property, {get () { throw failure }})
          const args = [zero, zero, zero]
          args[slot] = invalid
          assert.throws(() => scalar.splice(...args), error => error === failure)
          assert.throws(() => packed.splicePacked(...args), error => error === failure)
          assert.deepEqual(packed.dump(), before)
          assert.deepEqual(scalar.dump(), before)
        }
      }
    })

    it('preserves batch order, duplicate and missing ids, subviews and owned output storage', () => {
      const index = new MarkerIndex(5)
      index.insert(3, point(1, 2), point(4, 5))
      index.insert(1, point(0, 2), point(0, 8))
      const storage = new Uint32Array([77, 3, 99, 1, 3, 88])
      const ids = storage.subarray(1, 5)
      const before = [...storage]
      const result = index.getRanges(ids)
      assert(result instanceof Uint32Array)
      assert.deepEqual(result, scalarRanges(index, ids))
      assert.deepEqual([...storage], before)
      assert.notEqual(result.buffer, storage.buffer)
      assert.notEqual(result.buffer, index.getRanges(ids).buffer)
      result.fill(99)
      assert.deepEqual(index.getRanges(ids), scalarRanges(index, ids))
      const empty = index.getRanges(new Uint32Array())
      assert.equal(empty.length, 0)
      assert.notEqual(empty.buffer, index.getRanges(new Uint32Array()).buffer)

      const invalidated = index.splicePacked(point(0, 3), point(0, 1), point(0, 2))
      const invalidatedBefore = [...invalidated]
      index.splicePacked(point(0, 3), point(0, 1), point(0, 2))
      assert.deepEqual([...invalidated], invalidatedBefore)
      invalidated.fill(99)
      assert(index.has(1))
      assert.deepEqual(index.getRange(1), {start: point(0, 2), end: point(0, 10)})
    })

    it('requires Uint32Array batch inputs and exposes writable packed methods', () => {
      const index = new MarkerIndex()
      assert.throws(() => index.getRanges(), TypeError)
      for (const input of [undefined, null, [], {}, new Int32Array(), new Float64Array(), new BigUint64Array(), new DataView(new ArrayBuffer(4)), Buffer.alloc(4), Object.create(Uint32Array.prototype)]) {
        assert.throws(() => index.getRanges(input), TypeError)
      }
      for (const name of ['splicePacked', 'getRanges']) {
        const descriptor = Object.getOwnPropertyDescriptor(MarkerIndex.prototype, name)
        assert.isTrue(descriptor.writable)
        assert.isTrue(descriptor.configurable)
      }
    })
  })

  it('maintains correct marker positions during randomized insertions and mutations', function () {
    let seed, seedMessage, random, markerIndex, markers, idCounter

    const generateSeed = Random.create()
    for (let i = 0; i < 1000; i++) {
      seed = generateSeed(MAX_INT32)
      seedMessage = `Random Seed: ${seed}`
      random = new Random(seed)
      markerIndex = new MarkerIndex(seed)
      markers = []
      idCounter = 1

      for (let j = 0; j < 50; j++) {
        let n = random(10)
        if (n >= 4) { // 60% insert
          performInsert()
        } else if (n >= 2) { // 20% splice
          performSplice()
        } else if (markers.length > 0) {
          performDelete()
        }

        verifyRanges()
        verifyHighestPossiblePaths()
      }

      const verifications = [
        verifyRanges,
        testDump,
        testFindIntersecting,
        testFindContaining,
        testFindContainedIn,
        testFindStartingIn,
        testFindEndingIn,
        testFindStartingAt,
        testFindEndingAt,
        testFindBoundariesAfter
      ].sort((a, b) => random.intBetween(-1, 1))

      verifications.forEach(verification => verification())
    }

    //  uncomment for debug output in electron (`npm run tdd`)
    function write (f) {
      // document.write(f())
    }

    function verifyRanges () {
      for (let marker of markers) {
        let range = markerIndex.getRange(marker.id)
        assert.deepEqual(range.start, marker.start, `Marker ${marker.id} start. ` + seedMessage)
        assert.deepEqual(range.end, marker.end, `Marker ${marker.id} end. ` + seedMessage)
      }
    }

    function testDump () {
      if (markers.length === 0) return

      let expectedSnapshot = {}

      for (let marker of markers) {
        expectedSnapshot[marker.id] = {start: marker.start, end: marker.end}
      }

      let actualSnapshot = markerIndex.dump()

      assert.deepEqual(actualSnapshot, expectedSnapshot, seedMessage)
    }

    function verifyHighestPossiblePaths (node, alreadySeen) {
      if (!node) {
        if (markerIndex.root) verifyHighestPossiblePaths(markerIndex.root, new Set())
        return
      }

      for (let markerId of node.leftMarkerIds) {
        assert(!alreadySeen.has(markerId), `Redundant path for ${markerId}. ` + seedMessage)
      }
      for (let markerId of node.rightMarkerIds) {
        assert(!alreadySeen.has(markerId), `Redundant paths for ${markerId}. ` + seedMessage)
      }

      if (node.left) {
        let alreadySeenOnLeft = new Set()
        for (let markerId of alreadySeen) {
          alreadySeenOnLeft.add(markerId)
        }
        for (let markerId of node.leftMarkerIds) {
          alreadySeenOnLeft.add(markerId)
        }
        verifyHighestPossiblePaths(node.left, alreadySeenOnLeft)
      }

      if (node.right) {
        let alreadySeenOnRight = new Set()
        for (let markerId of alreadySeen) {
          alreadySeenOnRight.add(markerId)
        }
        for (let markerId of node.rightMarkerIds) {
          alreadySeenOnRight.add(markerId)
        }
        verifyHighestPossiblePaths(node.right, alreadySeenOnRight)
      }
    }

    function verifyContinuousPaths () {
      let startedMarkers = new Set()
      let endedMarkers = new Set()

      let iterator = markerIndex.iterator
      iterator.reset()
      while (iterator.node && iterator.node.left) iterator.descendLeft()

      let node = iterator.node
      while (node) {
        for (let markerId of node.leftMarkerIds) {
          assert(!endedMarkers.has(markerId), `Marker ${markerId} in left markers, but already ended. ` + seedMessage)
          assert(startedMarkers.has(markerId), `Marker ${markerId} in left markers, but not yet started. ` + seedMessage)
        }

        for (let markerId of node.startMarkerIds) {
          assert(!endedMarkers.has(markerId), `Marker ${markerId} in start markers, but already ended. ` + seedMessage)
          assert(!startedMarkers.has(markerId), `Marker ${markerId} in start markers, but already started. ` + seedMessage)
          startedMarkers.add(markerId)
        }

        for (let markerId of node.endMarkerIds) {
          assert(startedMarkers.has(markerId), `Marker ${markerId} in end markers, but not yet started. ` + seedMessage)
          startedMarkers.delete(markerId)
          endedMarkers.add(markerId)
        }

        for (let markerId of node.rightMarkerIds) {
          assert(!endedMarkers.has(markerId), `Marker ${markerId} in right markers, but already ended. ` + seedMessage)
          assert(startedMarkers.has(markerId), `Marker ${markerId} in right markers, but not yet started. ` + seedMessage)
        }

        iterator.moveToSuccessor()
        node = iterator.node
      }
    }

    function testFindIntersecting () {
      for (let i = 0; i < 10; i++) {
        let [start, end] = getRange()

        let expectedIds = new Set()
        for (let marker of markers) {
          if (compare(marker.start, end) <= 0 && compare(start, marker.end) <= 0) {
            expectedIds.add(marker.id)
          }
        }

        let actualIds = markerIndex.findIntersecting(start, end)

        assert.equal(actualIds.size, expectedIds.size, seedMessage)
        for (let id of expectedIds) {
          assert(actualIds.has(id), `Expected ${id} to be in set. ` + seedMessage)
        }
      }
    }

    function testFindContaining () {
      for (let i = 0; i < 10; i++) {
        let [start, end] = getRange()

        let expectedIds = new Set()
        for (let marker of markers) {
          if (compare(marker.start, start) <= 0 && compare(end, marker.end) <= 0) {
            expectedIds.add(marker.id)
          }
        }

        let actualIds = markerIndex.findContaining(start, end)
        assert.equal(actualIds.size, expectedIds.size, seedMessage)
        for (let id of expectedIds) {
          assert(actualIds.has(id), `Expected ${id} to be in set. ` + seedMessage)
        }
      }
    }

    function testFindContainedIn () {
      for (let i = 0; i < 10; i++) {
        let [start, end] = getRange()

        let expectedIds = new Set()
        for (let marker of markers) {
          if (compare(start, marker.start) <= 0 && compare(marker.end, end) <= 0) {
            expectedIds.add(marker.id)
          }
        }

        let actualIds = markerIndex.findContainedIn(start, end)
        assert.equal(actualIds.size, expectedIds.size, seedMessage)
        for (let id of expectedIds) {
          assert(actualIds.has(id), `Expected ${id} to be in set. ` + seedMessage)
        }
      }
    }

    function testFindStartingIn () {
      for (let i = 0; i < 10; i++) {
        let [start, end] = getRange()

        let expectedIds = new Set()
        for (let marker of markers) {
          if (compare(start, marker.start) <= 0 && compare(marker.start, end) <= 0) {
            expectedIds.add(marker.id)
          }
        }

        let actualIds = markerIndex.findStartingIn(start, end)
        for (let id of expectedIds) {
          assert(actualIds.has(id), `Expected ${id} to start in (${formatPoint(start)}, ${formatPoint(end)}). ` + seedMessage)
        }
        assert.equal(actualIds.size, expectedIds.size, seedMessage)
      }
    }

    function testFindEndingIn () {
      for (let i = 0; i < 10; i++) {
        let [start, end] = getRange()

        let expectedIds = new Set()
        for (let marker of markers) {
          if (compare(start, marker.end) <= 0 && compare(marker.end, end) <= 0) {
            expectedIds.add(marker.id)
          }
        }

        let actualIds = markerIndex.findEndingIn(start, end)
        for (let id of expectedIds) {
          assert(actualIds.has(id), `Expected ${id} to be in set. ` + seedMessage)
        }
        assert.equal(actualIds.size, expectedIds.size, seedMessage)
      }
    }

    function testFindStartingAt () {
      for (let i = 0; i < 10; i++) {
        let point = {row: random(100), column: random(100)}

        let expectedIds = new Set()
        for (let marker of markers) {
          if (compare(marker.start, point) === 0) {
            expectedIds.add(marker.id)
          }
        }

        let actualIds = markerIndex.findStartingAt(point)
        assert.equal(actualIds.size, expectedIds.size, seedMessage)
        for (let id of expectedIds) {
          assert(actualIds.has(id), `Expected ${id} to be in set. ` + seedMessage)
        }
      }
    }

    function testFindEndingAt () {
      for (let i = 0; i < 10; i++) {
        let point = {row: random(100), column: random(100)}

        let expectedIds = new Set()
        for (let marker of markers) {
          if (compare(marker.end, point) === 0) {
            expectedIds.add(marker.id)
          }
        }

        let actualIds = markerIndex.findEndingAt(point)
        assert.equal(actualIds.size, expectedIds.size, seedMessage)
        for (let id of expectedIds) {
          assert(actualIds.has(id), `Expected ${id} to be in set. ` + seedMessage)
        }
      }
    }

    function testFindBoundariesAfter () {
      for (let i = 0; i < 10; i++) {
        const start = {row: random(100), column: random(100)}
        const maxCount = random(20)

        const expectedContainingMarkerIds = []
        let expectedBoundaries = []
        const sortedMarkers = markers.slice().sort(compareMarkers)
        for (let marker of sortedMarkers) {
          if (compare(marker.start, start) < 0 && compare(marker.end, start) >= 0) {
            expectedContainingMarkerIds.push(marker.id)
          }

          if (compare(marker.start, start) >= 0) {
            expectedBoundaries.push({
              position: marker.start,
              starting: new Set([marker.id]),
              ending: new Set()
            })
          }

          if (compare(marker.end, start) >= 0) {
            expectedBoundaries.push({
              position: marker.end,
              starting: new Set(),
              ending: new Set([marker.id])
            })
          }
        }

        expectedBoundaries.sort((a, b) => compare(a.position, b.position))
        expectedBoundaries = expectedBoundaries.reduce((acc, currentBoundary) => {
          const lastBoundary = acc[acc.length - 1]
          if (lastBoundary && compare(lastBoundary.position, currentBoundary.position) === 0) {
            lastBoundary.starting = unifySets(lastBoundary.starting, currentBoundary.starting)
            lastBoundary.ending = unifySets(lastBoundary.ending, currentBoundary.ending)
          } else {
            acc.push(currentBoundary)
          }
          return acc
        }, [])
        expectedBoundaries = expectedBoundaries.slice(0, maxCount)

        const {containingStart, boundaries} = markerIndex.findBoundariesAfter(start, maxCount)
        assert.deepEqual(containingStart, expectedContainingMarkerIds, seedMessage)

        assert.equal(boundaries.length, expectedBoundaries.length, seedMessage)
        for (let i = 0; i < boundaries.length; i++) {
          const actual = boundaries[i]
          const expected = expectedBoundaries[i]
          assert.deepEqual(actual.position, expected.position, seedMessage)

          assert.equal(actual.starting.size, expected.starting.size, seedMessage)
          for (const id of actual.starting) {
            assert(expected.starting.has(id), seedMessage)
          }

          assert.equal(actual.ending.size, expected.ending.size, seedMessage)
          for (const id of actual.ending) {
            assert(expected.ending.has(id), seedMessage)
          }
        }
      }
    }

    function performInsert () {
      let id = idCounter++
      let [start, end] = getRange()
      let exclusive = !!random(2)
      write(() => `insert ${id}, ${formatPoint(start)}, ${formatPoint(end)}, exclusive: ${exclusive}`)
      assert(!markerIndex.has(id), `Expected marker index to not have ${id}. ` + seedMessage)
      markerIndex.insert(id, start, end)
      if (exclusive) markerIndex.setExclusive(id, true)
      markers.push({id, start, end, exclusive})
      assert(markerIndex.has(id), `Expected marker index to have ${id}. ` + seedMessage)
    }

    function performSplice () {
      let [start, oldExtent, newExtent] = getSplice()
      write(() => `splice ${formatPoint(start)}, ${formatPoint(oldExtent)}, ${formatPoint(newExtent)}`)
      let actualInvalidatedSets = markerIndex.splice(start, oldExtent, newExtent)
      let expectedInvalidatedSets = applySplice(markers, start, oldExtent, newExtent)
      checkInvalidatedSets(actualInvalidatedSets, expectedInvalidatedSets)
    }

    function performDelete () {
      let [{id}] = markers.splice(random(markers.length), 1)
      write(() => `delete ${id}`)
      assert(markerIndex.has(id), `Expected marker index to have ${id}. ` + seedMessage)
      markerIndex.remove(id)
      assert(!markerIndex.has(id), `Expected marker index to not have ${id}. ` + seedMessage)
    }

    function getRange () {
      let start = {row: random(100), column: random(100)}
      let end = start
      while (random(3) > 0) {
        end = traverse(end, {row: random.intBetween(-10, 10), column: random.intBetween(-10, 10)})
      }
      end.row = Math.max(end.row, 0)
      end.column = Math.max(end.column, 0)

      if (compare(start, end) <= 0) {
        return [start, end]
      } else {
        return [end, start]
      }
    }

    function getSplice () {
      let [start, oldEnd] = getRange()
      let oldExtent = traversalDistance(oldEnd, start)
      let newExtent = {row: 0, column: 0}
      while (random(2)) {
        newExtent = traverse(newExtent, {row: random(10), column: random(10)})
      }
      // Exercise equal-extent replacements, including disjoint and intersecting
      // ranges, against the same position/invalidation oracle.
      if (random(2)) newExtent = oldExtent
      return [start, oldExtent, newExtent]
    }

    function applySplice (markers, spliceStart, oldExtent, newExtent) {
      if (isZero(oldExtent) && isZero(newExtent)) return

      let spliceOldEnd = traverse(spliceStart, oldExtent)
      let spliceNewEnd = traverse(spliceStart, newExtent)
      let spliceDelta = traversalDistance(newExtent, oldExtent)
      let isInsertion = isZero(oldExtent)

      let invalidated = {
        touch: new Set,
        inside: new Set,
        overlap: new Set,
        surround: new Set
      }

      for (let marker of markers) {
        let isEmpty = compare(marker.start, marker.end) === 0

        if (compare(spliceStart, marker.end) <= 0 && compare(marker.start, spliceOldEnd) <= 0) {
          let invalidateInside = compare(spliceStart, marker.end) < 0 && compare(spliceOldEnd, marker.start) > 0
          let markerStartsWithinSplice, markerEndsWithinSplice

          if (marker.exclusive) {
            markerStartsWithinSplice =
              (compare(spliceStart, marker.start) < 0 || (!isEmpty && compare(spliceStart, marker.start) === 0)) &&
                compare(spliceOldEnd, marker.start) > 0
            markerEndsWithinSplice =
              compare(spliceStart, marker.end) < 0 &&
                (compare(spliceOldEnd, marker.end) > 0 || (!isEmpty && compare(spliceOldEnd, marker.end) === 0))
          } else {
            invalidateInside = invalidateInside || ((!isEmpty || isInsertion) && (compare(spliceStart, marker.start) === 0 || compare(spliceOldEnd, marker.end) === 0))
            markerStartsWithinSplice = compare(spliceStart, marker.start) < 0 && compare(marker.start, spliceOldEnd) < 0
            markerEndsWithinSplice = compare(spliceStart, marker.end) < 0 && compare(marker.end, spliceOldEnd) < 0
          }

          invalidated.touch.add(marker.id)
          if (invalidateInside) {
            invalidated.inside.add(marker.id)
          }
          if (markerStartsWithinSplice || markerEndsWithinSplice) {
            invalidated.overlap.add(marker.id)
          }
          if (markerStartsWithinSplice && markerEndsWithinSplice) {
            invalidated.surround.add(marker.id)
          }
        }

        let moveMarkerStart =
          (compare(spliceStart, marker.start) < 0) ||
            (marker.exclusive && (!isEmpty || isInsertion) && compare(spliceStart, marker.start) === 0)

        let moveMarkerEnd =
          moveMarkerStart ||
            (compare(spliceStart, marker.end) < 0) ||
              (!marker.exclusive && compare(spliceOldEnd, marker.end) === 0)

        if (moveMarkerStart) {
          if (compare(spliceOldEnd, marker.start) <= 0) { // splice precedes marker start
            marker.start = traverse(spliceNewEnd, traversalDistance(marker.start, spliceOldEnd))
          } else { // splice surrounds marker start
            marker.start = spliceNewEnd
          }
        }

        if (moveMarkerEnd) {
          if (compare(spliceOldEnd, marker.end) <= 0) { // splice precedes marker end
            marker.end = traverse(spliceNewEnd, traversalDistance(marker.end, spliceOldEnd))
          } else { // splice surrounds marker end
            marker.end = spliceNewEnd
          }
        }
      }

      return invalidated
    }

    function checkInvalidatedSets (actualSets, expectedSets) {
      for (let strategy in expectedSets) {
        let expectedSet = expectedSets[strategy]
        let actualSet = actualSets[strategy]

        assert.equal(actualSet.size, expectedSet.size, `Strategy: ${strategy}. Expected: [${Array.from(expectedSet)}], Actual: [${Array.from(actualSet)}]. Seed ${seed}.`)
        for (let markerId of expectedSet) {
          assert(actualSet.has(markerId), `Expected marker ${markerId} to be invalidated via ${strategy} strategy. Seed ${seed}.`)
        }
      }
    }

    function compareMarkers (a, b) {
      const startComparison = compare(a.start, b.start)
      if (startComparison === 0) {
        const endComparison = compare(b.end, a.end)
        if (endComparison === 0) {
          return a.id - b.id
        } else {
          return endComparison
        }
      } else {
        return startComparison
      }
    }

    function unifySets (a, b) {
      const union = new Set(a)
      for (const value of b) {
        union.add(value)
      }
      return union
    }
  })

  it('can compare marker ranges', function () {
    let index = new MarkerIndex()
    index.insert(1, {row: 1, column: 2}, {row: 3, column: 4})
    index.insert(2, {row: 1, column: 2}, {row: 3, column: 4})
    index.insert(3, {row: 2, column: 2}, {row: 3, column: 4})
    index.insert(4, {row: 1, column: 2}, {row: 3, column: 5})

    assert.equal(index.compare(1, 2), 0)
    assert.equal(index.compare(2, 1), 0)
    assert.equal(index.compare(1, 3), -1)
    assert.equal(index.compare(3, 1), 1)
    assert.equal(index.compare(1, 4), 1)
    assert.equal(index.compare(4, 1), -1)
  })

  it('handles range queries involving Infinity', () => {
    let index = new MarkerIndex()
    index.insert(1, {row: 10, column: 10}, {row: 20, column: 20})
    let result = index.findEndingIn({row: 0, column: 0}, {row: Infinity, column: Infinity})
    assert(result.has(1))
  })

  it('preserves cached positions across disjoint equal-extent replacements and later mutations', () => {
    const index = new MarkerIndex(7)
    const point = column => ({row: 0, column})
    index.insert(1, point(10), point(20))
    index.insert(2, point(40), point(50))
    index.insert(3, point(70), point(70))
    index.setExclusive(2, true)
    index.setExclusive(3, true)
    const expected = index.dump()

    for (let i = 0; i < 50; i++) {
      for (const column of [1, 30, 80]) {
        for (const id of [1, 2, 3]) index.getRange(id)
        const invalidated = index.splice(point(column), point(2), point(2))
        for (const ids of Object.values(invalidated)) assert.equal(ids.size, 0)
        assert.deepEqual(index.dump(), expected)
        assert.deepEqual([...index.findIntersecting(point(10), point(50))], [1, 2])
      }
    }

    index.splice(point(0), point(0), point(3))
    assert.deepEqual(index.getRange(1), {start: point(13), end: point(23)})
    assert.deepEqual(index.getRange(2), {start: point(43), end: point(53)})
    assert.deepEqual(index.getRange(3), {start: point(73), end: point(73)})
    index.remove(2)
    index.insert(4, point(25), point(28))
    index.splice(point(26), point(1), point(1))
    assert.deepEqual(index.getRange(4), {start: point(25), end: point(28)})
    assert.deepEqual([...index.findIntersecting(point(25), point(28))], [4])
  })

  it('keeps a single marker stable across equal-extent edits before and after its range', () => {
    const point = column => ({row: 0, column})
    for (const exclusive of [false, true]) {
      const index = new MarkerIndex(7)
      index.insert(1, point(10), point(20))
      index.setExclusive(1, exclusive)
      for (let i = 0; i < 50; i++) {
        for (const column of [1, 30]) {
          const invalidated = index.splice(point(column), point(2), point(2))
          for (const ids of Object.values(invalidated)) assert.equal(ids.size, 0)
          assert.deepEqual(index.getRange(1), {start: point(10), end: point(20)})
        }
      }
      index.splice(point(0), point(0), point(3))
      assert.deepEqual(index.getRange(1), {start: point(13), end: point(23)})
      index.splice(point(1), point(2), point(2))
      assert.deepEqual(index.getRange(1), {start: point(13), end: point(23)})
    }
  })

  it('keeps closed boundary invalidation for equal-extent replacements', () => {
    const point = column => ({row: 0, column})
    for (const exclusive of [false, true]) {
      for (const [start, end, spliceStart] of [[10, 20, 8], [10, 20, 20], [10, 10, 8], [10, 10, 10]]) {
        const index = new MarkerIndex(3)
        index.insert(1, point(start), point(end))
        index.setExclusive(1, exclusive)
        const invalidated = index.splice(point(spliceStart), point(2), point(2))
        assert.deepEqual([...invalidated.touch], [1])
        assert.equal(invalidated.overlap.size, 0)
        assert.equal(invalidated.surround.size, 0)
      }
    }
  })

  it('invalidates enclosing markers even when no endpoint falls inside the splice', () => {
    const point = column => ({row: 0, column})
    const index = new MarkerIndex(8)
    index.insert(1, point(0), point(100))
    const invalidated = index.splice(point(40), point(2), point(2))
    assert.deepEqual([...invalidated.touch], [1])
    assert.deepEqual([...invalidated.inside], [1])
    assert.equal(invalidated.overlap.size, 0)
    assert.equal(invalidated.surround.size, 0)
    assert.deepEqual(index.getRange(1), {start: point(0), end: point(100)})
  })

  it('requires both row and column extents to match before preserving later positions', () => {
    const index = new MarkerIndex(2)
    index.insert(1, {row: 5, column: 3}, {row: 6, column: 4})
    let invalidated = index.splice({row: 0, column: 4}, {row: 1, column: 2}, {row: 1, column: 2})
    for (const ids of Object.values(invalidated)) assert.equal(ids.size, 0)
    assert.deepEqual(index.getRange(1), {start: {row: 5, column: 3}, end: {row: 6, column: 4}})
    invalidated = index.splice({row: 0, column: 4}, {row: 1, column: 2}, {row: 0, column: 2})
    for (const ids of Object.values(invalidated)) assert.equal(ids.size, 0)
    assert.deepEqual(index.getRange(1), {start: {row: 4, column: 3}, end: {row: 5, column: 4}})
  })

  it('keeps historical reversed-range handling on the normal splice path', () => {
    const point = column => ({row: 0, column})
    const index = new MarkerIndex(1)
    index.insert(1, point(20), point(10))
    for (const column of [1, 14, 25]) {
      const invalidated = index.splice(point(column), point(2), point(2))
      for (const ids of Object.values(invalidated)) assert.equal(ids.size, 0)
      assert.deepEqual(index.getRange(1), {start: point(20), end: point(10)})
    }
  })

  it('preserves Infinity endpoints and their closed-boundary invalidation', () => {
    const maximum = 0xffffffff
    const index = new MarkerIndex(2)
    index.insert(1, {row: 10, column: 0}, {row: Infinity, column: Infinity})
    const before = index.getRange(1)
    let invalidated = index.splice({row: 0, column: 1}, {row: 0, column: 2}, {row: 0, column: 2})
    for (const ids of Object.values(invalidated)) assert.equal(ids.size, 0)
    assert.deepEqual(index.getRange(1), before)
    invalidated = index.splice({row: 20, column: 1}, {row: 0, column: 2}, {row: 0, column: 2})
    assert.deepEqual([...invalidated.touch], [1])
    assert.deepEqual([...invalidated.inside], [1])
    assert.deepEqual(index.getEnd(1), {row: maximum, column: maximum})
    invalidated = index.splice({row: maximum, column: maximum - 1}, {row: 0, column: 1}, {row: 0, column: 1})
    assert.deepEqual([...invalidated.touch], [1])
    assert.deepEqual(index.getRange(1), before)
  })
})
