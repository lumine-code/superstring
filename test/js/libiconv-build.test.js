const fs = require('fs')
const os = require('os')
const path = require('path')
const {spawnSync} = require('child_process')
const {assert} = require('./helpers/assert')

const bash = process.platform === 'win32'
  ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe')
  : 'bash'

describe('the macOS libiconv build cache', () => {
  let directory
  let tracePath
  let scriptPath
  let runnerPath

  function shellPath (filePath) {
    return filePath.replace(/\\/g, '/').replace(/^([a-z]):/i, (_, drive) => `/${drive.toLowerCase()}`)
  }

  function writeScript (name, content) {
    const filePath = path.join(directory, name)
    fs.mkdirSync(path.dirname(filePath), {recursive: true})
    fs.writeFileSync(filePath, '#!/bin/bash\nset -euo pipefail\n' + content, {mode: 0o755})
    return filePath
  }

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'superstring libiconv target-'))
    tracePath = path.join(directory, 'trace')
    fs.writeFileSync(tracePath, '')
    scriptPath = path.join(directory, 'script', 'fetch-libiconv-61.sh')
    fs.mkdirSync(path.dirname(scriptPath))
    fs.copyFileSync(path.join(__dirname, '../../script/fetch-libiconv-61.sh'), scriptPath)
    runnerPath = writeScript('run', `
export PATH="$FIXTURE_BIN:$PATH"
exec bash "$@"
`)

    writeScript('configure', `
printf 'configure:%s\\n' "$MACOSX_DEPLOYMENT_TARGET" >> "$TRACE_PATH"
for argument; do
  case "$argument" in
    --prefix=*) printf '%s' "\${argument#--prefix=}" > prefix ;;
  esac
done
`)
    writeScript('bin/git', `
printf 'clone:%s\\n' "$MACOSX_DEPLOYMENT_TARGET" >> "$TRACE_PATH"
mkdir -p libiconv/libiconv
cp "$CONFIGURE_FIXTURE" libiconv/libiconv/configure
printf 'license' > libiconv/libiconv/COPYING.LIB
printf 'readme' > libiconv/libiconv/README
`)
    writeScript('bin/make', `
printf 'make:%s:%s\\n' "$*" "$MACOSX_DEPLOYMENT_TARGET" >> "$TRACE_PATH"
if [ "\${FAIL_BUILD:-}" = 1 ]; then exit 9; fi
if [ "\${1:-}" = install ]; then
  prefix="$(cat prefix)"
  mkdir -p "$prefix/lib"
  printf '%s' "$MACOSX_DEPLOYMENT_TARGET" > "$prefix/lib/libiconv.2.dylib"
fi
`)
    writeScript('bin/install_name_tool', `
printf 'install-name:%s\\n' "$MACOSX_DEPLOYMENT_TARGET" >> "$TRACE_PATH"
if [ "\${FAIL_INSTALL_NAME:-}" = 1 ]; then exit 7; fi
test -f "$3"
`)
  })

  afterEach(() => {
    fs.rmSync(directory, {recursive: true, force: true})
  })

  function build (target, extraEnvironment = {}) {
    return spawnSync(bash, [shellPath(runnerPath), shellPath(scriptPath), ...(target ? [target] : [])], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
      env: {
        ...process.env,
        FIXTURE_BIN: shellPath(path.join(directory, 'bin')),
        TRACE_PATH: shellPath(tracePath),
        CONFIGURE_FIXTURE: shellPath(path.join(directory, 'configure')),
        // The explicit configured minimum must override the build host's minimum.
        MACOSX_DEPLOYMENT_TARGET: '26.0',
        ...extraEnvironment
      }
    })
  }

  function assertSucceeded (result) {
    assert.equal(result.status, 0, result.error?.message || result.stderr)
  }

  function clones () {
    return fs.readFileSync(tracePath, 'utf8').split('\n').filter(line => line.startsWith('clone:'))
  }

  it('exports the configured minimum to every compiler step and reuses a matching library', () => {
    assertSucceeded(build('13.5'))
    assertSucceeded(build('13.5'))

    assert.deepEqual(clones(), ['clone:13.5'])
    assert.equal(fs.readFileSync(path.join(directory, 'ext/lib/libiconv.2.dylib'), 'utf8'), '13.5')
    assert.equal(fs.readFileSync(path.join(directory, 'ext/libiconv-deployment-target-13.5'), 'utf8'), '13.5\n')
    const trace = fs.readFileSync(tracePath, 'utf8')
    assert.include(trace, 'configure:13.5')
    assert.include(trace, 'make::13.5')
    assert.include(trace, 'make:install:13.5')
    assert.isFalse(fs.existsSync(path.join(directory, 'scratch')))
  })

  it('rebuilds when a caller changes the configured minimum and retires the old stamp', () => {
    assertSucceeded(build('13.5'))
    assertSucceeded(build('14.0'))
    assertSucceeded(build(null, {MACOSX_DEPLOYMENT_TARGET: '14.0'}))

    assert.deepEqual(clones(), ['clone:13.5', 'clone:14.0'])
    assert.equal(fs.readFileSync(path.join(directory, 'ext/lib/libiconv.2.dylib'), 'utf8'), '14.0')
    assert.isFalse(fs.existsSync(path.join(directory, 'ext/libiconv-deployment-target-13.5')))
    assert.equal(fs.readFileSync(path.join(directory, 'ext/libiconv-deployment-target-14.0'), 'utf8'), '14.0\n')
  })

  it('rebuilds a preexisting library whose deployment minimum was never recorded', () => {
    fs.mkdirSync(path.join(directory, 'ext/lib'), {recursive: true})
    fs.writeFileSync(path.join(directory, 'ext/lib/libiconv.2.dylib'), '26.0')

    assertSucceeded(build('13.5'))

    assert.deepEqual(clones(), ['clone:13.5'])
    assert.equal(fs.readFileSync(path.join(directory, 'ext/lib/libiconv.2.dylib'), 'utf8'), '13.5')
  })

  it('rebuilds when the recorded minimum disagrees with the requested target', () => {
    assertSucceeded(build('13.5'))
    fs.writeFileSync(path.join(directory, 'ext/libiconv-deployment-target-13.5'), '26.0\n')

    assertSucceeded(build('13.5'))

    assert.deepEqual(clones(), ['clone:13.5', 'clone:13.5'])
    assert.equal(fs.readFileSync(path.join(directory, 'ext/libiconv-deployment-target-13.5'), 'utf8'), '13.5\n')
  })

  it('defaults a direct invocation to 13.5 and rejects invalid explicit or environment targets', () => {
    assertSucceeded(build(null, {MACOSX_DEPLOYMENT_TARGET: ''}))

    assert.deepEqual(clones(), ['clone:13.5'])
    assert.equal(build('unknown').status, 1)
    assert.equal(build(null, {MACOSX_DEPLOYMENT_TARGET: 'unknown'}).status, 1)
    assert.deepEqual(clones(), ['clone:13.5'])
  })

  it('leaves no success stamp after a failed rebuild and retries on the next build', () => {
    assertSucceeded(build('13.5'))
    assert.equal(build('14.0', {FAIL_BUILD: '1'}).status, 9)
    assert.isFalse(fs.existsSync(path.join(directory, 'ext/libiconv-deployment-target-13.5')))
    assert.isFalse(fs.existsSync(path.join(directory, 'ext/libiconv-deployment-target-14.0')))
    assert.isFalse(fs.existsSync(path.join(directory, 'scratch')))

    assertSucceeded(build('14.0'))

    assert.deepEqual(clones(), ['clone:13.5', 'clone:14.0', 'clone:14.0'])
    assert.equal(fs.readFileSync(path.join(directory, 'ext/libiconv-deployment-target-14.0'), 'utf8'), '14.0\n')
  })

  it('records no successful output when adjusting the install name fails', () => {
    assert.equal(build('13.5', {FAIL_INSTALL_NAME: '1'}).status, 7)
    assert.isFalse(fs.existsSync(path.join(directory, 'ext/libiconv-deployment-target-13.5')))

    assertSucceeded(build('13.5'))

    assert.deepEqual(clones(), ['clone:13.5', 'clone:13.5'])
    assert.equal(fs.readFileSync(path.join(directory, 'ext/libiconv-deployment-target-13.5'), 'utf8'), '13.5\n')
  })
})
