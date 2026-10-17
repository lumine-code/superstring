const assert = require('node:assert/strict')
const {Worker} = require('node:worker_threads')
const {TextBuffer, Patch} = require('../..')
const point = (row, column) => ({row, column})
const range = (start, end = start) => ({start, end})

describe('Prepared document edits', () => {
  it('captures immutable UTF-16 coordinates and commits exactly once', () => {
    const buffer = new TextBuffer('before\nlast')
    const edit = buffer.prepareEdit(range(point(0, 1), point(0, 4)), 'Ω🚀\r\nx')
    const change = edit.getChange()
    const patch = edit.createPatch()
    assert.equal(buffer.getText(), 'before\nlast')
    assert.equal(change.oldText, 'efo')
    assert.equal(change.newText, 'Ω🚀\r\nx')
    assert.deepEqual([change.startIndex, change.oldEndIndex, change.newEndIndex], [1, 4, 7])
    assert(Object.isFrozen(change))
    assert(Object.isFrozen(change.oldStart))
    edit.commit()
    assert.equal(buffer.getText(), 'bΩ🚀\r\nxre\nlast')
    assert.throws(() => edit.commit(), /already committed or disposed/)
    assert.throws(() => edit.getChange(), /already committed or disposed/)
    assert.throws(() => edit.createPatch(), /already committed or disposed/)
    edit.dispose()
    edit.dispose()
    assert.equal(change.oldText, 'efo')
    assert.equal(patch.getChanges()[0].newText, 'Ω🚀\r\nx')
  })

  for (const mutation of ['setText', 'setTextInRange', 'reset', 'deserializeChanges']) {
    it(`rejects an edit invalidated by ${mutation} without applying it`, () => {
      const buffer = new TextBuffer('abc')
      const edit = buffer.prepareEdit(range(point(0, 0)), 'x')
      if (mutation === 'setTextInRange') buffer[mutation](range(point(0, 0)), 'changed')
      else if (mutation === 'deserializeChanges') {
        const source = new TextBuffer('abc')
        source.setTextInRange(range(point(0, 0)), 'changed')
        buffer.deserializeChanges(source.serializeChanges())
      } else buffer[mutation]('changed')
      const expected = buffer.getText()
      assert.throws(() => edit.commit(), {code: 'ERR_STALE_EDIT'})
      assert.equal(buffer.getText(), expected)
      edit.dispose()
    })
  }

  it('explicitly disposes an abandoned edit without mutating its buffer', () => {
    const buffer = new TextBuffer('abc')
    const edit = buffer.prepareEdit(range(point(0, 0)), 'x'.repeat(100000))
    edit.dispose()
    assert.throws(() => edit.commit(), /disposed/)
    assert.equal(buffer.getText(), 'abc')
  })

  it('shares patch payloads for undo and redo, independent of patch mutation', () => {
    const buffer = new TextBuffer('first\nlast')
    const snapshot = buffer.getSnapshot()
    const edit = buffer.prepareEdit(range(point(0, 0), point(1, 4)), 'replacement\nend')
    const patch = edit.createPatch()
    const encoded = patch.serialize()
    edit.commit()
    const inverse = patch.invert()
    const changes = inverse.getChanges()
    inverse.splice(point(0, 0), point(0, 1), point(0, 1), 'f', 'F')
    const undo = buffer.prepareEditFromChange(changes[0])
    assert.equal(undo.getChange().newText, 'first\nlast')
    undo.commit()
    assert.equal(buffer.getText(), 'first\nlast')
    buffer.prepareEditFromChange(Patch.deserialize(encoded).getChanges()[0]).commit()
    assert.equal(buffer.getText(), 'replacement\nend')
    snapshot.destroy()
    assert.match(changes[0].toString(), /first/)
  })

  it('rejects fabricated, geometry-only and mismatching patch changes', () => {
    const buffer = new TextBuffer('abc')
    assert.throws(() => buffer.prepareEditFromChange({newText:'x'}), /native patch change/)
    const patch = new Patch()
    patch.splice(point(0, 0), point(0, 1), point(0, 1))
    assert.throws(() => buffer.prepareEditFromChange(patch.getChanges()[0]), /old and new text/)
    const other = new TextBuffer('xyz')
    const edit = other.prepareEdit(range(point(0, 0), point(0, 1)), 'q')
    assert.throws(() => buffer.prepareEditFromChange(edit.createPatch().getChanges()[0]), /does not match/)
    edit.dispose()
    assert.equal(buffer.getText(), 'abc')
  })

  it('clips fresh edits and keeps UTF-16 offsets through CRLF and unpaired surrogates', () => {
    const buffer = new TextBuffer('a\r\nb')
    const edit = buffer.prepareEdit(range(point(0, 999), point(999, 999)), '\ud800\n')
    const change = edit.getChange()
    assert.deepEqual(change.oldStart, point(0, 1))
    assert.deepEqual(change.oldEnd, point(1, 1))
    assert.deepEqual([change.startIndex,change.oldEndIndex,change.newEndIndex],[1,4,3])
    edit.commit()
    assert.equal(buffer.getText(), 'a\ud800\n')
  })

  it('supports empty edits without inventing a history delta', () => {
    const buffer = new TextBuffer('abc')
    const edit = buffer.prepareEdit(range(point(0, 1)), '')
    assert.equal(edit.createPatch().getChangeCount(), 0)
    edit.commit()
    assert.equal(buffer.getText(), 'abc')
  })

  it('preserves unpaired code units in owning patch snapshots and replay metadata', () => {
    const buffer = new TextBuffer('b')
    const edit = buffer.prepareEdit(range(point(0, 0), point(0, 1)), '\ud800x')
    const patch = edit.createPatch()
    edit.commit()
    const inverse = patch.invert().getChanges()[0]
    assert.equal(inverse.oldText, '\ud800x')
    buffer.prepareEditFromChange(inverse).commit()
    const redo = buffer.prepareEditFromChange(patch.getChanges()[0])
    assert.equal(redo.getChange().newText, '\ud800x')
    redo.commit()
    assert.equal(buffer.getText(), '\ud800x')
    const fresh = buffer.prepareEdit(range(point(0,0),point(0,1)), 'Q')
    assert.equal(fresh.getChange().oldText, '\ud800')
    fresh.dispose()
  })

  for (const [before, start, end, inserted, after] of [
    ['abc\ndef', 3, 3, '\r', 'abc\r\ndef'],
    ['a\rb', 2, 2, '\n', 'a\r\nb'],
    ['a\rX\n', 2, 3, '', 'a\r\n'],
  ]) {
    it(`keeps CRLF edit edges replayable for ${JSON.stringify(before)}`, () => {
      const buffer = new TextBuffer(before)
      const edit = buffer.prepareEdit(range(point(0,start),point(0,end)),inserted)
      const patch = edit.createPatch()
      edit.commit()
      assert.equal(buffer.getText(),after)
      buffer.prepareEditFromChange(patch.invert().getChanges()[0]).commit()
      assert.equal(buffer.getText(),before)
      buffer.prepareEditFromChange(patch.getChanges()[0]).commit()
      assert.equal(buffer.getText(),after)
    })
  }

  it('replays raw CRLF-interior patch geometry from native file diffs', () => {
    const buffer = new TextBuffer('a\r\nb')
    const addCR = new Patch()
    addCR.splice(point(0,1), point(0,0), point(0,1), '', '\r')
    buffer.prepareEditFromChange(addCR.invert().getChanges()[0]).commit()
    assert.equal(buffer.getText(), 'a\nb')
    buffer.prepareEditFromChange(addCR.getChanges()[0]).commit()
    assert.equal(buffer.getText(), 'a\r\nb')

    const addLF = new Patch()
    addLF.splice(point(0,2), point(0,0), point(1,0), '', '\n')
    buffer.prepareEditFromChange(addLF.invert().getChanges()[0]).commit()
    assert.equal(buffer.getText(), 'a\rb')
    buffer.prepareEditFromChange(addLF.getChanges()[0]).commit()
    assert.equal(buffer.getText(), 'a\r\nb')
  })

  it('keeps the buffer alive until the edit is consumed', () => {
    let buffer = new TextBuffer('abc')
    const edit = buffer.prepareEdit(range(point(0, 1)), 'X'.repeat(100000))
    const patch = edit.createPatch()
    buffer = null
    if (global.gc) global.gc()
    edit.commit()
    if (global.gc) global.gc()
    edit.dispose()
    assert.equal(patch.getChanges()[0].newText.length, 100000)
  })

  it('releases abandoned prepared edits when a worker environment terminates', async () => {
    const worker = new Worker(`
      const {parentPort, workerData} = require('node:worker_threads');
      const {TextBuffer} = require(workerData);
      global.buffer = new TextBuffer('abc');
      global.edit = buffer.prepareEdit({start:{row:0,column:0},end:{row:0,column:0}}, 'x'.repeat(1000000));
      parentPort.postMessage('ready');
      setInterval(() => {}, 1000);
    `, {eval:true, workerData:require.resolve('../..')})
    try {
      await new Promise((resolve,reject) => { worker.once('message',resolve); worker.once('error',reject) })
    } finally {
      await worker.terminate()
    }
  })
})
