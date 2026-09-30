#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const {spawnSync} = require('child_process')

const testsPath = path.resolve(__dirname, '..', 'build', 'Debug', process.platform === 'win32' ? 'tests.exe' : 'tests')
const dotPath = path.resolve(__dirname, '..', 'build', 'debug.dot')
const htmlPath = path.join(__dirname, '..', 'build', 'debug.html')

if (fs.existsSync(testsPath)) {
  build(['build', '--debug'])
} else {
  build(['rebuild', '--debug', '--tests'])
}

const args = process.argv.slice(2)

switch (args[0]) {
  case '-d':
  case '--debug':
    args.shift()
    run('lldb', [testsPath, '--', ...args])
    break

  case '-v':
  case '--valgrind':
    args.shift()
    run('valgrind', ['--leak-check=full', testsPath, args[0]])
    break

  case '-s':
  case '--svg':
    args.shift()

    let dotFile = fs.openSync(dotPath, 'w')
    const {status} = spawnSync(testsPath, args, {stdio: ['ignore', 1, dotFile]})
    fs.closeSync(dotFile)

    dotFile = fs.openSync(dotPath, 'r')
    let htmlFile = fs.openSync(htmlPath, 'w')
    fs.writeSync(htmlFile, '<!doctype HTML>\n<style>svg {width: 100%;}</style>\n')
    spawnSync('dot', ['-Tsvg'], {stdio: [dotFile, htmlFile, 2]})
    spawnSync('open', [htmlPath])

    process.exit(status ?? 1)
    break

  default:
    run(testsPath, args)
    break
}

function build(args) {
  const nodeGypPath = process.env.npm_config_node_gyp
  if (nodeGypPath) {
    run(process.execPath, [nodeGypPath, ...args])
  } else {
    run('node-gyp', args)
  }
}

function run(command, args = [], options = {stdio: 'inherit'}) {
  const {status, error} = spawnSync(command, args, options)
  if (error) console.error(error)
  if (status !== 0) process.exit(status ?? 1)
}
