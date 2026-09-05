/**
 * Real-git coverage for the mirror sync fetch's negotiation tips: a branch
 * rewritten on top of the current default branch must negotiate against
 * that base and receive only its own new commits, not the whole default
 * branch history since the branch's old fork point.
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

const TRUNK_COMMITS_AFTER_FORK = 40

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {encoding: 'utf8'}).trim()
}

function commit(repo: string, msg: string): string {
  fs.writeFileSync(path.join(repo, `${msg}.txt`), msg)
  git(repo, 'add', `${msg}.txt`)
  git(
    repo,
    '-c',
    'user.email=test@example.com',
    '-c',
    'user.name=Test',
    'commit',
    '-q',
    '-m',
    msg
  )
  return git(repo, 'rev-parse', 'HEAD')
}

/** Loose + packed object count, i.e. everything a fetch wrote so far. */
function objectCount(repo: string): number {
  let total = 0
  for (const line of git(repo, 'count-objects', '-v').split('\n')) {
    const match = /^(count|in-pack): (\d+)$/.exec(line.trim())
    if (match) {
      total += parseInt(match[2], 10)
    }
  }
  return total
}

function packetLines(packetTrace: string, re: RegExp): Set<string> {
  const out = new Set<string>()
  if (!fs.existsSync(packetTrace)) {
    return out
  }
  for (const line of fs.readFileSync(packetTrace, 'utf8').split('\n')) {
    const match = re.exec(line)
    if (match) {
      out.add(match[1])
    }
  }
  return out
}

describe('mirror sync negotiation with real git', () => {
  let tmpDir: string
  let sourceRepo: string
  let mirrorPath: string
  let trunkTip: string
  let oldFeatureTip: string
  let newFeatureTip: string
  const savedEnv = {...process.env}

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-sync-nego-'))
    sourceRepo = path.join(tmpDir, 'source')
    fs.mkdirSync(sourceRepo)
    git(sourceRepo, 'init', '-q', '--initial-branch=trunk', '.')
    commit(sourceRepo, 'base-1')
    commit(sourceRepo, 'base-2')
    git(sourceRepo, 'checkout', '-q', '-b', 'feature')
    oldFeatureTip = commit(sourceRepo, 'feature-work')
    git(sourceRepo, 'checkout', '-q', 'trunk')
    for (let i = 0; i < TRUNK_COMMITS_AFTER_FORK; i++) {
      trunkTip = commit(sourceRepo, `trunk-${i}`)
    }

    // Mirror taken while feature still sits on its old fork point. HEAD in
    // the mirror is refs/heads/trunk (not main/master), so the base tip has
    // to come from the HEAD symref.
    mirrorPath = path.join(tmpDir, 'mirror.git')
    git(tmpDir, 'clone', '-q', '--mirror', sourceRepo, mirrorPath)
    git(mirrorPath, 'commit-graph', 'write', '--reachable')
    expect(git(mirrorPath, 'symbolic-ref', 'HEAD')).toBe('refs/heads/trunk')

    // Upstream rewrites feature on top of the current trunk (rebase +
    // force-push). Its old tip is now only an ancestor of trunk's fork point.
    git(sourceRepo, 'checkout', '-q', 'feature')
    git(
      sourceRepo,
      '-c',
      'user.email=test@example.com',
      '-c',
      'user.name=Test',
      'rebase',
      '-q',
      'trunk'
    )
    newFeatureTip = git(sourceRepo, 'rev-parse', 'HEAD')
    expect(newFeatureTip).not.toBe(oldFeatureTip)
    git(sourceRepo, 'checkout', '-q', 'trunk')
  })

  afterAll(() => {
    process.env = {...savedEnv}
    fs.rmSync(tmpDir, {recursive: true, force: true})
  })

  afterEach(() => {
    process.env = {...savedEnv}
  })

  it('control: negotiating from the old tip alone re-downloads trunk since the fork point', () => {
    const control = path.join(tmpDir, 'control.git')
    fs.cpSync(mirrorPath, control, {recursive: true})
    const before = objectCount(control)
    git(
      control,
      '-c',
      'fetch.negotiationAlgorithm=skipping',
      'fetch',
      '-q',
      '--no-tags',
      `--negotiation-tip=${oldFeatureTip}`,
      'origin',
      '+refs/heads/feature:refs/heads/feature'
    )
    const received = objectCount(control) - before
    // 40 trunk commits x (commit + tree + blob) plus the rewritten feature
    // commit: everything since the old fork point.
    expect(received).toBeGreaterThan(TRUNK_COMMITS_AFTER_FORK * 3)
  })

  it('sync offers the HEAD branch tip and receives only the rewritten commit', async () => {
    const packetTrace = path.join(tmpDir, 'sync-packets')
    process.env['GIT_TRACE_PACKET'] = packetTrace
    const before = objectCount(mirrorPath)

    const result = await blacksmithCache.syncMirrorFromRemote(
      mirrorPath,
      'https://example.invalid/owner/repo',
      'token',
      false,
      60
    )

    expect(result.success).toBe(true)
    expect(result.timedOut).toBe(false)
    expect(result.changed).toBe(true)
    expect(git(mirrorPath, 'rev-parse', 'refs/heads/feature')).toBe(
      newFeatureTip
    )
    expect(git(mirrorPath, 'rev-parse', 'refs/heads/trunk')).toBe(trunkTip)

    const haves = packetLines(packetTrace, /fetch> have ([0-9a-f]+)/)
    expect(haves.has(trunkTip)).toBe(true)
    expect(haves.has(oldFeatureTip)).toBe(true)
    const acks = packetLines(packetTrace, /fetch< ACK ([0-9a-f]+)/)
    expect(acks.has(trunkTip)).toBe(true)

    // Only the rewritten feature commit and its tree/blob are new relative
    // to trunk; git may add a few bookkeeping objects, but never trunk's
    // history again.
    const received = objectCount(mirrorPath) - before
    expect(received).toBeGreaterThan(0)
    expect(received).toBeLessThan(TRUNK_COMMITS_AFTER_FORK)
  })
})
