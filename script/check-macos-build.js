#!/usr/bin/env node
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {execFileSync} = require('node:child_process')

const productDirectory = path.resolve(process.argv[2])
const target = process.argv[3] || process.env.MACOSX_DEPLOYMENT_TARGET
assert.match(target || '', /^\d+(\.\d+){1,2}$/, 'Supply the configured macOS deployment target')

function normalizeVersion (version) {
  const parts = version.split('.').map(Number)
  while (parts.length > 1 && parts.at(-1) === 0) parts.pop()
  return parts.join('.')
}

function checkMinimum (file) {
  const output = execFileSync('otool', ['-l', file], {encoding: 'utf8'})
  const minimums = output.split(/(?=Load command \d+)/).flatMap(command => {
    if (/\bcmd LC_BUILD_VERSION\b/.test(command)) {
      return command.match(/\bminos\s+([\d.]+)/)?.[1] || []
    }
    if (/\bcmd LC_VERSION_MIN_MACOSX\b/.test(command)) {
      return command.match(/\bversion\s+([\d.]+)/)?.[1] || []
    }
    return []
  })
  assert.ok(minimums.length, `No macOS minimum recorded in ${file}`)
  for (const minimum of minimums) {
    assert.equal(normalizeVersion(minimum), normalizeVersion(target), `${file} deployment target`)
  }
}

const library = path.join(productDirectory, 'libiconv.2.dylib')
assert.ok(fs.lstatSync(library).isFile(), 'The companion library must be a copied regular file')
checkMinimum(library)

for (const [name, libraryPath] of [
  ['superstring.node', '@loader_path/libiconv.2.dylib'],
  ['tests', '@executable_path/libiconv.2.dylib']
]) {
  const file = path.join(productDirectory, name)
  if (name === 'tests' && !fs.existsSync(file)) continue
  checkMinimum(file)
  const dependencies = execFileSync('otool', ['-L', file], {encoding: 'utf8'})
  const iconvDependencies = dependencies.split('\n').filter(line => /^\s+\S*libiconv/.test(line))
  assert.equal(iconvDependencies.length, 1, `${name} must link exactly one libiconv`)
  assert.equal(iconvDependencies[0].trim().split(/\s+/)[0], libraryPath, `${name} adjacent library path`)
}

console.log(`Validated ${productDirectory}: macOS ${target} and adjacent libiconv`)
