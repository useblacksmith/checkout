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

/** Pushes HEAD of `src` as one pack of its own, whatever its object count. */
function pushPack(src: string, mirror: string, branch: string): void {
  git(
    src,
    'push',
    '-q',
    '--receive-pack=git -c receive.unpackLimit=1 receive-pack',
    mirror,
    `HEAD:refs/heads/${branch}`
  )
}

function packSizes(mirror: string): Map<string, number> {
  const packDir = path.join(mirror, 'objects', 'pack')
  return new Map(
    packs(mirror).map(p => [p, fs.statSync(path.join(packDir, p)).size])
  )
}

/** Bytes of packs present after a run that were not present before it. */
function bytesWritten(
  before: Map<string, number>,
  after: Map<string, number>
): number {
  let n = 0
  for (const [name, size] of after) {
    if (!before.has(name)) {
      n += size
    }
  }
  return n
}

function stampReclaim(mirror: string, at: number): void {
  fs.writeFileSync(
    path.join(mirror, blacksmithCache.MAINTENANCE_RECLAIM_STAMP),
    `${at}\n`
  )
}

/**
 * Bare mirror with one base pack larger than KEEP_BYTES, several small
 * packs (pushed with receive.unpackLimit=1) and a few loose objects. Auto
 * maintenance on the receiving side is disabled so the pack layout is
 * exactly what the pushes produced, whatever the git version.
 */
function buildMirror(root: string): {mirror: string; basePack: string} {
  const src = path.join(root, 'src')
  const mirror = path.join(root, 'mirror.git')
  fs.mkdirSync(src)
  git(root, 'init', '-q', '--bare', 'mirror.git')
  git(mirror, 'config', 'gc.auto', '0')
  git(mirror, 'config', 'receive.autogc', 'false')
  git(mirror, 'config', 'maintenance.auto', 'false')
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

    const result = await blacksmithCache.runMirrorMaintenance(mirror, {
      timeoutSecs: 60,
      keepBytes: KEEP_BYTES
    })
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
    await blacksmithCache.runMirrorMaintenance(mirror, {
      timeoutSecs: 60,
      keepBytes: KEEP_BYTES
    })
    const first = packs(mirror)

    const result = await blacksmithCache.runMirrorMaintenance(mirror, {
      timeoutSecs: 60,
      keepBytes: KEEP_BYTES
    })
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

    const result = await blacksmithCache.runMirrorMaintenance(mirror, {
      timeoutSecs: 60,
      keepBytes: Number.MAX_SAFE_INTEGER
    })
    expect(result.success).toBe(true)
    expect(packs(mirror)).toContain(basePack)
    fsck(mirror)
    refsResolve(mirror)
  })

  it('marks only packs at or above the threshold as kept', async () => {
    const {mirror, basePack} = buildMirror(root)
    const kept = await blacksmithCache.markKeepPacks(mirror, KEEP_BYTES)
    expect(kept).toEqual({
      kept: [basePack.replace(/\.pack$/, '')],
      deferred: []
    })
    const keepFiles = fs
      .readdirSync(path.join(mirror, 'objects', 'pack'))
      .filter(f => f.endsWith('.keep'))
    expect(keepFiles).toEqual([basePack.replace(/\.pack$/, '.keep')])

    // Idempotent: already-kept packs are reported, no duplicates written.
    expect(await blacksmithCache.markKeepPacks(mirror, KEEP_BYTES)).toEqual(
      kept
    )
  })

  it('never rewrites more than the keep threshold per run, whatever the object counts', async () => {
    const {mirror, basePack} = buildMirror(root)
    const src = path.join(root, 'src')
    // Four medium packs of one large object each, and one pack of many tiny
    // objects: all below the threshold on their own, well above it together.
    // Geometric repack would pick them by object count; the byte bound must
    // hold regardless.
    for (let i = 0; i < 4; i++) {
      commitBlob(src, `medium-${i}`, 400 * 1024)
      pushPack(src, mirror, `medium-${i}`)
    }
    for (let i = 0; i < 200; i++) {
      fs.writeFileSync(path.join(src, `tiny-${i}`), `tiny ${i}\n`)
    }
    git(src, 'add', '.')
    git(
      src,
      '-c',
      'user.email=test@example.com',
      '-c',
      'user.name=Test',
      'commit',
      '-q',
      '-m',
      'tiny'
    )
    pushPack(src, mirror, 'tiny')

    const packDir = path.join(mirror, 'objects', 'pack')
    let before = packSizes(mirror)
    let unkept = 0
    for (const [name, size] of before) {
      if (name !== basePack) {
        unkept += size
      }
    }
    expect(unkept).toBeGreaterThan(2 * KEEP_BYTES)

    for (let run = 0; run < 3; run++) {
      const result = await blacksmithCache.runMirrorMaintenance(mirror, {
        timeoutSecs: 60,
        keepBytes: KEEP_BYTES
      })
      expect(result).toEqual({success: true, timedOut: false})
      const after = packSizes(mirror)
      expect(bytesWritten(before, after)).toBeLessThan(KEEP_BYTES)
      expect(after.has(basePack)).toBe(true)
      // Only the base pack is kept for good; deferrals do not outlive the run.
      const keepFiles = fs.readdirSync(packDir).filter(f => f.endsWith('.keep'))
      expect(keepFiles).toEqual([basePack.replace(/\.pack$/, '.keep')])
      fsck(mirror)
      refsResolve(mirror)
      before = after
    }
    expect(looseObjects(mirror)).toBe(0)
  })

  it('defers the largest packs until the rest fit under the threshold', async () => {
    const {mirror, basePack} = buildMirror(root)
    const src = path.join(root, 'src')
    for (let i = 0; i < 3; i++) {
      commitBlob(src, `medium-${i}`, 400 * 1024)
      pushPack(src, mirror, `medium-${i}`)
    }
    const sizes = packSizes(mirror)
    const medium = [...sizes.entries()]
      .filter(([, size]) => size > 300 * 1024 && size < KEEP_BYTES)
      .map(([name]) => name.replace(/\.pack$/, ''))
      .sort()
    expect(medium).toHaveLength(3)

    const selection = await blacksmithCache.markKeepPacks(mirror, KEEP_BYTES)
    expect(selection.kept).toEqual([basePack.replace(/\.pack$/, '')])
    // 3 x 400 KiB + 6 x 100 KiB + loose: dropping two of the medium packs
    // brings the rest under 1 MiB.
    expect(selection.deferred).toHaveLength(2)
    for (const base of selection.deferred) {
      expect(medium).toContain(base)
      expect(
        fs.readFileSync(
          path.join(mirror, 'objects', 'pack', `${base}.keep`),
          'utf8'
        )
      ).not.toBe('')
    }

    // A deferral left behind by a killed run is lifted and re-evaluated.
    const again = await blacksmithCache.markKeepPacks(mirror, KEEP_BYTES)
    expect(again).toEqual(selection)
    const withoutLimit = await blacksmithCache.markKeepPacks(
      mirror,
      Number.MAX_SAFE_INTEGER
    )
    expect(withoutLimit.deferred).toEqual([])
  })

  describe('reclaim', () => {
    // Pushes a branch into its own kept pack, optionally records it in the
    // commit-graph, then deletes the branch so its objects are unreachable.
    function addGarbage(
      root: string,
      mirror: string,
      options: {commitGraph?: boolean} = {}
    ): {pack: string; blob: string; commit: string} {
      const src = path.join(root, 'src')
      const before = new Set(packs(mirror))
      commitBlob(src, 'garbage', 600 * 1024)
      const blob = git(src, 'rev-parse', 'HEAD:garbage')
      const commit = git(src, 'rev-parse', 'HEAD')
      pushPack(src, mirror, 'garbage')
      const pack = packs(mirror).find(p => !before.has(p)) as string
      fs.writeFileSync(
        path.join(mirror, 'objects', 'pack', pack.replace(/\.pack$/, '.keep')),
        ''
      )
      if (options.commitGraph) {
        git(mirror, 'commit-graph', 'write', '--reachable', '--split')
      }
      git(mirror, 'update-ref', '-d', 'refs/heads/garbage')
      return {pack, blob, commit}
    }

    function hasObject(mirror: string, oid: string): boolean {
      try {
        execFileSync('git', ['-C', mirror, 'cat-file', '-e', oid], {
          stdio: 'pipe'
        })
        return true
      } catch {
        return false
      }
    }

    it('starts the interval on first sight instead of reclaiming at once', async () => {
      const {mirror} = buildMirror(root)
      const {pack, blob} = addGarbage(root, mirror)
      const stamp = path.join(mirror, blacksmithCache.MAINTENANCE_RECLAIM_STAMP)
      expect(fs.existsSync(stamp)).toBe(false)

      const result = await blacksmithCache.runMirrorMaintenance(mirror, {
        timeoutSecs: 60,
        keepBytes: KEEP_BYTES,
        now: 1000
      })
      expect(result).toEqual({success: true, timedOut: false})
      expect(fs.readFileSync(stamp, 'utf8').trim()).toBe('1000')
      expect(packs(mirror)).toContain(pack)
      expect(hasObject(mirror, blob)).toBe(true)

      // Within the interval: still incremental.
      await blacksmithCache.runMirrorMaintenance(mirror, {
        timeoutSecs: 60,
        keepBytes: KEEP_BYTES,
        reclaimIntervalMs: 10_000,
        now: 5000
      })
      expect(fs.readFileSync(stamp, 'utf8').trim()).toBe('1000')
      expect(packs(mirror)).toContain(pack)
      fsck(mirror)
    })

    it('rewrites the whole mirror and drops unreachable objects when due', async () => {
      const {mirror, basePack} = buildMirror(root)
      const {
        pack,
        blob,
        commit: garbageCommit
      } = addGarbage(root, mirror, {commitGraph: true})
      expect(blacksmithCache.hasCommitGraph(mirror)).toBe(true)
      stampReclaim(mirror, 0)

      const result = await blacksmithCache.runMirrorMaintenance(mirror, {
        timeoutSecs: 60,
        keepBytes: KEEP_BYTES,
        reclaimIntervalMs: 10_000,
        now: 20_000
      })
      expect(result).toEqual({success: true, timedOut: false})

      const packDir = path.join(mirror, 'objects', 'pack')
      const remaining = packs(mirror)
      expect(remaining).toHaveLength(1)
      expect(remaining).not.toContain(pack)
      expect(remaining).not.toContain(basePack)
      expect(hasObject(mirror, blob)).toBe(false)
      expect(fs.readdirSync(packDir).filter(f => f.endsWith('.keep'))).toEqual(
        []
      )
      expect(looseObjects(mirror)).toBe(0)
      expect(
        fs
          .readFileSync(
            path.join(mirror, blacksmithCache.MAINTENANCE_RECLAIM_STAMP),
            'utf8'
          )
          .trim()
      ).toBe('20000')
      expect(fs.existsSync(path.join(packDir, 'multi-pack-index'))).toBe(true)
      // The graph was rebuilt without the pruned commit.
      expect(blacksmithCache.hasCommitGraph(mirror)).toBe(true)
      git(mirror, 'commit-graph', 'verify')
      expect(hasObject(mirror, garbageCommit)).toBe(false)
      fsck(mirror)
      refsResolve(mirror)

      // The next run keeps the new single pack and is incremental again.
      const next = await blacksmithCache.runMirrorMaintenance(mirror, {
        timeoutSecs: 60,
        keepBytes: KEEP_BYTES,
        reclaimIntervalMs: 10_000,
        now: 25_000
      })
      expect(next).toEqual({success: true, timedOut: false})
      expect(packs(mirror)).toEqual(remaining)
      expect(fs.readdirSync(packDir).filter(f => f.endsWith('.keep'))).toEqual([
        remaining[0].replace(/\.pack$/, '.keep')
      ])
    })
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
    function installFakeGit(script: string, command = 'repack'): void {
      const realGit = execFileSync('which', ['git'], {encoding: 'utf8'}).trim()
      const realTimeout = execFileSync('which', ['timeout'], {
        encoding: 'utf8'
      }).trim()
      fs.writeFileSync(
        path.join(binDir, 'git'),
        `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "${command}" ]; then
${script}
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

      const result = await blacksmithCache.runMirrorMaintenance(mirror, {
        timeoutSecs: 1,
        keepBytes: KEEP_BYTES
      })
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

      const result = await blacksmithCache.runMirrorMaintenance(mirror, {
        timeoutSecs: 60,
        keepBytes: KEEP_BYTES
      })
      expect(result.success).toBe(false)
      expect(result.timedOut).toBe(false)
      expect(result.error).toContain('128')
      fsck(mirror)
    })
    it('reports a pack-refs failure without a timeout flag', async () => {
      const {mirror} = buildMirror(root)
      installFakeGit('    exit 3', 'pack-refs')

      const result = await blacksmithCache.runMirrorMaintenance(mirror, {
        timeoutSecs: 60,
        keepBytes: KEEP_BYTES
      })
      expect(result).toEqual({
        success: false,
        timedOut: false,
        error: expect.stringContaining('pack-refs failed with exit code 3')
      })
      fsck(mirror)
      refsResolve(mirror)
    })

    it('reports a pack-refs timeout and removes its lock file', async () => {
      const {mirror} = buildMirror(root)
      installFakeGit(
        `    touch "${mirror}/packed-refs.lock"
    sleep 30`,
        'pack-refs'
      )

      const result = await blacksmithCache.runMirrorMaintenance(mirror, {
        timeoutSecs: 1,
        keepBytes: KEEP_BYTES
      })
      expect(result).toEqual({
        success: false,
        timedOut: true,
        error: expect.stringContaining('pack-refs timed out')
      })
      expect(fs.existsSync(path.join(mirror, 'packed-refs.lock'))).toBe(false)
      fsck(mirror)
      refsResolve(mirror)
    })

    it('a reclaim that times out leaves the mirror intact and is not retried', async () => {
      const {mirror, basePack} = buildMirror(root)
      const packDir = path.join(mirror, 'objects', 'pack')
      const keepFile = path.join(packDir, basePack.replace(/\.pack$/, '.keep'))
      fs.writeFileSync(keepFile, '')
      stampReclaim(mirror, 0)
      const before = packs(mirror)
      installFakeGit(`    touch "${packDir}/tmp_pack_reclaim"
    sleep 30`)

      const result = await blacksmithCache.runMirrorMaintenance(mirror, {
        timeoutSecs: 60,
        keepBytes: KEEP_BYTES,
        reclaimIntervalMs: 10_000,
        reclaimTimeoutSecs: 1,
        now: 20_000
      })
      expect(result.success).toBe(false)
      expect(result.timedOut).toBe(true)
      expect(packs(mirror)).toEqual(before)
      expect(fs.existsSync(path.join(packDir, 'tmp_pack_reclaim'))).toBe(false)
      fsck(mirror)
      refsResolve(mirror)

      // The stamp was advanced before the attempt, so the following run is
      // incremental and re-marks the base pack instead of trying again.
      process.env.PATH = originalPath
      const next = await blacksmithCache.runMirrorMaintenance(mirror, {
        timeoutSecs: 60,
        keepBytes: KEEP_BYTES,
        reclaimIntervalMs: 10_000,
        now: 25_000
      })
      expect(next).toEqual({success: true, timedOut: false})
      expect(fs.existsSync(keepFile)).toBe(true)
      expect(packs(mirror)).toContain(basePack)
      fsck(mirror)
    })
  })
})
