/**
 * Real-git coverage for the post-step mirror gc: a `gc --auto` that finds
 * nothing to collect is reported as skipped (no maintenance row), while one
 * that repacks is a real gc result.
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

// A bare repo whose objects live in exactly two packs (one per commit) and
// no loose objects, so `gc --auto` is a no-op at the default autoPackLimit
// and repacks to a single pack once autoPackLimit is 1.
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

describe('mirror gc telemetry', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-gc-'))
    jest.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    fs.rmSync(root, {recursive: true, force: true})
    jest.restoreAllMocks()
  })

  it('reports a no-op gc --auto as skipped', async () => {
    const mirror = twoPackMirror(root)
    const packsBefore = packCount(mirror)

    const result = await blacksmithCache.cleanup({
      exposeId: 'expose-1',
      stickyDiskKey: 'owner-repo',
      mirrorPath: mirror,
      shouldCommit: true,
      vmHydratedGitMirror: false
    })

    expect(packCount(mirror)).toBe(packsBefore)
    expect(result.gcResult.success).toBe(true)
    expect(result.gcResult.skipped).toBe(true)
  })

  it('reports a gc --auto that repacked as a real run', async () => {
    const mirror = twoPackMirror(root)
    git(mirror, 'config', 'gc.autoPackLimit', '1')

    const result = await blacksmithCache.cleanup({
      exposeId: 'expose-1',
      stickyDiskKey: 'owner-repo',
      mirrorPath: mirror,
      shouldCommit: true,
      vmHydratedGitMirror: false
    })

    expect(packCount(mirror)).toBe(1)
    expect(result.gcResult.success).toBe(true)
    expect(result.gcResult.skipped).toBeUndefined()
    expect(result.gcResult.mirrorSizeBytes).toBeGreaterThan(0)
  })
})
