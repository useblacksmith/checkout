/**
 * Real-git coverage for post-step mirror maintenance: large packs are
 * marked kept and never rewritten, small packs and loose objects are
 * rolled up, the mirror stays intact, repeated runs are no-ops, and a
 * killed or failing maintenance leaves no temporary or lock files behind.
 */
jest.mock('@connectrpc/connect', () => ({
  createClient: jest.fn(),
  ConnectError: class ConnectError extends Error {},
  Code: {Aborted: 'ABORTED'}
}))

jest.mock('@connectrpc/connect-node', () => ({
  createGrpcTransport: jest.fn()
}))

jest.mock(
  '@buf/blacksmith_vm-agent.connectrpc_es/stickydisk/v1/stickydisk_connect',
  () => ({
    StickyDiskService: {}
  })
)

jest.mock('../src/container-detector', () => ({
  isRunningInContainer: jest.fn(() => false)
}))

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {execFileSync} from 'child_process'
import * as blacksmithCache from '../src/blacksmith-cache'

const KEEP_BYTES = 1024 * 1024

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {encoding: 'utf8'}).trim()
}

function commitBlob(repo: string, name: string, bytes: number): void {
  const buf = Buffer.alloc(bytes)
  for (let i = 0; i < bytes; i += 4) {
    buf.writeUInt32LE((Math.random() * 0xffffffff) >>> 0, i)
  }
  fs.writeFileSync(path.join(repo, name), buf)
  git(repo, 'add', name)
  git(
    repo,
    '-c',
    'user.email=test@example.com',
    '-c',
    'user.name=Test',
    'commit',
    '-q',
    '-m',
    name
  )
}

function packs(mirror: string): string[] {
  return fs
    .readdirSync(path.join(mirror, 'objects', 'pack'))
    .filter(f => f.endsWith('.pack'))
    .sort()
}

function looseObjects(mirror: string): number {
  const objects = path.join(mirror, 'objects')
  let n = 0
  for (const dir of fs.readdirSync(objects)) {
    if (/^[0-9a-f]{2}$/.test(dir)) {
      n += fs.readdirSync(path.join(objects, dir)).length
    }
  }
  return n
}

function refsResolve(mirror: string): void {
  const out = git(mirror, 'for-each-ref', '--format=%(objectname)')
  for (const sha of out.split('\n').filter(Boolean)) {
    git(mirror, 'cat-file', '-e', `${sha}^{commit}`)
  }
}

function fsck(mirror: string): void {
  execFileSync('git', ['-C', mirror, 'fsck', '--strict'], {stdio: 'pipe'})
}

/**
 * Bare mirror with one base pack larger than KEEP_BYTES, several small
 * packs (pushed with receive.unpackLimit=1) and a few loose objects.
 */
function buildMirror(root: string): {mirror: string; basePack: string} {
  const src = path.join(root, 'src')
  const mirror = path.join(root, 'mirror.git')
  fs.mkdirSync(src)
  git(root, 'init', '-q', '--bare', 'mirror.git')
  git(root, 'init', '-q', '-b', 'main', 'src')
  for (let i = 0; i < 6; i++) {
    commitBlob(src, `base-${i}`, 300 * 1024)
    git(src, 'push', '-q', mirror, `HEAD:refs/heads/base-${i}`)
  }
  git(mirror, '-c', 'repack.writeBitmaps=false', 'repack', '-a', '-d', '-q')
  const basePacks = packs(mirror)
  expect(basePacks).toHaveLength(1)
  expect(
    fs.statSync(path.join(mirror, 'objects', 'pack', basePacks[0])).size
  ).toBeGreaterThan(KEEP_BYTES)

  for (let i = 0; i < 6; i++) {
    commitBlob(src, `small-${i}`, 100 * 1024)
    git(
      src,
      'push',
      '-q',
      '--receive-pack=git -c receive.unpackLimit=1 receive-pack',
      mirror,
      `HEAD:refs/heads/small-${i}`
    )
  }
  commitBlob(src, 'loose', 512)
  git(src, 'push', '-q', mirror, 'HEAD:refs/heads/loose')

  expect(packs(mirror).length).toBe(7)
  expect(looseObjects(mirror)).toBeGreaterThan(0)
  return {mirror, basePack: basePacks[0]}
}

describe('runMirrorMaintenance (real git)', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-maint-'))
  })

  afterEach(() => {
    fs.rmSync(root, {recursive: true, force: true})
  })

  it('keeps the base pack, rolls up small packs and loose objects', async () => {
    const {mirror, basePack} = buildMirror(root)
    const before = fs.statSync(path.join(mirror, 'objects', 'pack', basePack))

    const result = await blacksmithCache.runMirrorMaintenance(
      mirror,
      60,
      KEEP_BYTES
    )
    expect(result).toEqual({success: true, timedOut: false})

    const packDir = path.join(mirror, 'objects', 'pack')
    expect(
      fs.existsSync(path.join(packDir, basePack.replace(/\.pack$/, '.keep')))
    ).toBe(true)
    const after = fs.statSync(path.join(packDir, basePack))
    expect(after.ino).toBe(before.ino)
    expect(after.size).toBe(before.size)

    const remaining = packs(mirror)
    expect(remaining).toContain(basePack)
    expect(remaining.length).toBeLessThanOrEqual(3)
    expect(looseObjects(mirror)).toBe(0)
    expect(fs.existsSync(path.join(packDir, 'multi-pack-index'))).toBe(true)
    expect(fs.existsSync(path.join(mirror, 'packed-refs'))).toBe(true)
    fsck(mirror)
    refsResolve(mirror)
  })

  it('is a no-op on an already maintained mirror', async () => {
    const {mirror} = buildMirror(root)
    await blacksmithCache.runMirrorMaintenance(mirror, 60, KEEP_BYTES)
    const first = packs(mirror)

    const result = await blacksmithCache.runMirrorMaintenance(
      mirror,
      60,
      KEEP_BYTES
    )
    expect(result).toEqual({success: true, timedOut: false})
    expect(packs(mirror)).toEqual(first)
    fsck(mirror)
  })

  it('excludes kept packs from the roll-up regardless of size', async () => {
    const {mirror, basePack} = buildMirror(root)
    // Kept by an earlier run; a larger pack arriving later must not pull
    // it into the roll-up.
    fs.writeFileSync(
      path.join(
        mirror,
        'objects',
        'pack',
        basePack.replace(/\.pack$/, '.keep')
      ),
      ''
    )
    const src = path.join(root, 'src')
    commitBlob(src, 'huge', 4 * 1024 * 1024)
    git(
      src,
      'push',
      '-q',
      '--receive-pack=git -c receive.unpackLimit=1 receive-pack',
      mirror,
      'HEAD:refs/heads/huge'
    )

    const result = await blacksmithCache.runMirrorMaintenance(
      mirror,
      60,
      Number.MAX_SAFE_INTEGER
    )
    expect(result.success).toBe(true)
    expect(packs(mirror)).toContain(basePack)
    fsck(mirror)
    refsResolve(mirror)
  })

  it('marks only packs at or above the threshold as kept', async () => {
    const {mirror, basePack} = buildMirror(root)
    const kept = await blacksmithCache.markKeepPacks(mirror, KEEP_BYTES)
    expect(kept).toEqual([basePack.replace(/\.pack$/, '')])
    const keepFiles = fs
      .readdirSync(path.join(mirror, 'objects', 'pack'))
      .filter(f => f.endsWith('.keep'))
    expect(keepFiles).toEqual([basePack.replace(/\.pack$/, '.keep')])

    // Idempotent: already-kept packs are reported, no duplicates written.
    expect(await blacksmithCache.markKeepPacks(mirror, KEEP_BYTES)).toEqual(
      kept
    )
  })

  describe('with a misbehaving git', () => {
    let binDir: string
    let originalPath: string | undefined

    beforeEach(() => {
      binDir = path.join(root, 'bin')
      fs.mkdirSync(binDir)
      originalPath = process.env.PATH
    })

    afterEach(() => {
      process.env.PATH = originalPath
    })

    // Jest's sandboxed process.env is not what child processes inherit, so
    // the shim is installed as a `timeout` found through the sandbox PATH
    // that puts binDir first on the PATH of the real one.
    function installFakeGit(repackScript: string): void {
      const realGit = execFileSync('which', ['git'], {encoding: 'utf8'}).trim()
      const realTimeout = execFileSync('which', ['timeout'], {
        encoding: 'utf8'
      }).trim()
      fs.writeFileSync(
        path.join(binDir, 'git'),
        `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "repack" ]; then
${repackScript}
  fi
done
exec ${realGit} "$@"
`,
        {mode: 0o755}
      )
      fs.writeFileSync(
        path.join(binDir, 'timeout'),
        `#!/bin/sh
PATH="${binDir}:$PATH" exec ${realTimeout} "$@"
`,
        {mode: 0o755}
      )
      process.env.PATH = `${binDir}:${originalPath}`
    }

    it('reports a timeout and removes leftovers without touching the mirror', async () => {
      const {mirror, basePack} = buildMirror(root)
      const before = packs(mirror)
      const packDir = path.join(mirror, 'objects', 'pack')
      installFakeGit(`    touch "${packDir}/tmp_pack_abc" "${packDir}/.tmp-1-pack-abc.pack" "${packDir}/multi-pack-index.lock" "${mirror}/packed-refs.lock"
    sleep 30`)

      const result = await blacksmithCache.runMirrorMaintenance(
        mirror,
        1,
        KEEP_BYTES
      )
      expect(result.success).toBe(false)
      expect(result.timedOut).toBe(true)

      expect(packs(mirror)).toEqual(before)
      expect(fs.existsSync(path.join(packDir, 'tmp_pack_abc'))).toBe(false)
      expect(fs.existsSync(path.join(packDir, '.tmp-1-pack-abc.pack'))).toBe(
        false
      )
      expect(fs.existsSync(path.join(packDir, 'multi-pack-index.lock'))).toBe(
        false
      )
      expect(fs.existsSync(path.join(mirror, 'packed-refs.lock'))).toBe(false)
      expect(
        fs.existsSync(path.join(packDir, basePack.replace(/\.pack$/, '.keep')))
      ).toBe(true)
      fsck(mirror)
      refsResolve(mirror)
    })

    it('reports a failure without a timeout flag', async () => {
      const {mirror} = buildMirror(root)
      installFakeGit('    exit 128')

      const result = await blacksmithCache.runMirrorMaintenance(
        mirror,
        60,
        KEEP_BYTES
      )
      expect(result.success).toBe(false)
      expect(result.timedOut).toBe(false)
      expect(result.error).toContain('128')
      fsck(mirror)
    })
  })
})
