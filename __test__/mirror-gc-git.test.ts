/**
 * Real-git coverage for post-step maintenance telemetry: a geometric repack
 * that finds nothing to roll up is reported as skipped (no maintenance
 * row), while one that consolidates packs is a real maintenance result.
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
import * as mirrorTelemetry from '../src/mirror-telemetry'

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com'
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: gitEnv
  }).trim()
}

function packCount(repo: string): number {
  const packDir = path.join(repo, 'objects', 'pack')
  return fs.readdirSync(packDir).filter(f => f.endsWith('.pack')).length
}

// Writes one pack holding exactly the given objects; returns its basename.
function writePack(repo: string, objects: string): string {
  const hash = execFileSync(
    'git',
    [
      '-C',
      repo,
      'pack-objects',
      '-q',
      path.join(repo, 'objects', 'pack', 'pack')
    ],
    {input: objects, encoding: 'utf8', env: gitEnv}
  ).trim()
  return `pack-${hash}`
}

// A bare repo whose objects live in exactly two similarly sized packs (one
// per commit) and no loose objects: a geometric repack rolls them into one.
function twoPackMirror(root: string): string {
  const work = path.join(root, 'work')
  fs.mkdirSync(work)
  git(work, 'init', '-q')
  fs.writeFileSync(path.join(work, 'a.txt'), 'one\n')
  git(work, 'add', 'a.txt')
  git(work, 'commit', '-q', '-m', 'one')
  fs.writeFileSync(path.join(work, 'b.txt'), 'two\n')
  git(work, 'add', 'b.txt')
  git(work, 'commit', '-q', '-m', 'two')

  const mirror = path.join(root, 'mirror.git')
  git(root, 'clone', '-q', '--mirror', work, mirror)
  const keep = new Set([
    writePack(mirror, git(mirror, 'rev-list', '--objects', 'HEAD~1')),
    writePack(mirror, git(mirror, 'rev-list', '--objects', 'HEAD~1..HEAD'))
  ])
  const packDir = path.join(mirror, 'objects', 'pack')
  for (const f of fs.readdirSync(packDir)) {
    if (!keep.has(f.replace(/\.(pack|idx|rev)$/, ''))) {
      fs.rmSync(path.join(packDir, f))
    }
  }
  git(mirror, 'prune-packed', '-q')
  expect(packCount(mirror)).toBe(2)
  return mirror
}

// A bare repo already consolidated into a single pack with no loose
// objects, so a geometric repack has nothing to do.
function onePackMirror(root: string): string {
  const mirror = twoPackMirror(root)
  git(mirror, '-c', 'repack.writeBitmaps=false', 'repack', '-a', '-d', '-q')
  git(mirror, 'prune-packed', '-q')
  expect(packCount(mirror)).toBe(1)
  return mirror
}

describe('mirror maintenance telemetry', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-gc-'))
    jest.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    fs.rmSync(root, {recursive: true, force: true})
    jest.restoreAllMocks()
  })

  it('reports a repack that rolled nothing up as skipped', async () => {
    const mirror = onePackMirror(root)
    const packsBefore = await mirrorTelemetry.packNamesOrNull(mirror)

    const result = await blacksmithCache.cleanup({
      exposeId: 'expose-1',
      stickyDiskKey: 'owner-repo',
      mirrorPath: mirror,
      shouldCommit: true,
      vmHydratedGitMirror: false
    })

    expect(await mirrorTelemetry.packNamesOrNull(mirror)).toEqual(packsBefore)
    expect(result.maintenanceResult.success).toBe(true)
    expect(result.maintenanceResult.skipped).toBe(true)
  })

  it('reports a repack that consolidated packs as a real run', async () => {
    const mirror = twoPackMirror(root)

    const result = await blacksmithCache.cleanup({
      exposeId: 'expose-1',
      stickyDiskKey: 'owner-repo',
      mirrorPath: mirror,
      shouldCommit: true,
      vmHydratedGitMirror: false
    })

    expect(packCount(mirror)).toBe(1)
    expect(result.maintenanceResult.success).toBe(true)
    expect(result.maintenanceResult.skipped).toBeUndefined()
    expect(result.maintenanceResult.durationMs).toBeGreaterThanOrEqual(0)
    expect(result.maintenanceResult.mirrorSizeBytes).toBeGreaterThan(0)
  })

  it('reports no maintenance when the disk is not committed', async () => {
    const mirror = twoPackMirror(root)

    const result = await blacksmithCache.cleanup({
      exposeId: 'expose-1',
      stickyDiskKey: 'owner-repo',
      mirrorPath: mirror,
      shouldCommit: false,
      vmHydratedGitMirror: false
    })

    expect(packCount(mirror)).toBe(2)
    expect(result.maintenanceResult.skipped).toBe(true)
  })
})

describe('pack measurement', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-pack-'))
  })

  afterEach(() => {
    fs.rmSync(root, {recursive: true, force: true})
  })

  it('sums only the files under objects/pack', async () => {
    const mirror = twoPackMirror(root)
    // Loose objects and refs must not count.
    fs.mkdirSync(path.join(mirror, 'objects', 'ab'))
    fs.writeFileSync(
      path.join(mirror, 'objects', 'ab', 'cdef'),
      'x'.repeat(4096)
    )
    const packDir = path.join(mirror, 'objects', 'pack')
    const expected = fs
      .readdirSync(packDir)
      .reduce((sum, f) => sum + fs.statSync(path.join(packDir, f)).size, 0)

    expect(await mirrorTelemetry.packSizeBytesOrNull(mirror)).toBe(expected)
    expect(await mirrorTelemetry.packNamesOrNull(mirror)).toHaveLength(2)
  })

  it('measures a repository without packs as empty, not unmeasurable', async () => {
    const bare = path.join(root, 'empty.git')
    git(root, 'init', '-q', '--bare', 'empty.git')
    fs.rmSync(path.join(bare, 'objects', 'pack'), {recursive: true})

    expect(await mirrorTelemetry.packSizeBytesOrNull(bare)).toBe(0)
    expect(await mirrorTelemetry.packNamesOrNull(bare)).toEqual([])
    expect(
      await mirrorTelemetry.packSizeBytesOrNull(path.join(root, 'missing'))
    ).toBe(0)
  })
})
