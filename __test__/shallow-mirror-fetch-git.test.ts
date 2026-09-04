/**
 * Real-git coverage for the shallow (fetch-depth > 0) fetch against a
 * workspace that shares the sticky-disk mirror's objects through alternates:
 * negotiation tips resolved from the mirror, alternate ref discovery
 * disabled, and the resulting checkout being identical to a plain shallow
 * fetch regardless of how stale the mirror is.
 */
// Mock the gRPC dependencies before importing blacksmith-cache
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
import * as gitCommandManager from '../src/git-command-manager'

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

/** Commits offered to the server as `have`s, from a GIT_TRACE_PACKET file. */
function havesSent(packetTrace: string): Set<string> {
  const haves = new Set<string>()
  if (!fs.existsSync(packetTrace)) {
    return haves
  }
  for (const line of fs.readFileSync(packetTrace, 'utf8').split('\n')) {
    const match = /fetch> have ([0-9a-f]+)/.exec(line)
    if (match) {
      haves.add(match[1])
    }
  }
  return haves
}

/** Whether git listed the alternate's refs, from a GIT_TRACE2_EVENT file. */
function listedAlternateRefs(trace2: string, mirrorPath: string): boolean {
  if (!fs.existsSync(trace2)) {
    return false
  }
  return fs
    .readFileSync(trace2, 'utf8')
    .split('\n')
    .some(
      line =>
        line.includes('"for-each-ref"') &&
        line.includes(`--git-dir=${mirrorPath}`)
    )
}

describe('shallow fetch with mirror alternates and real git', () => {
  let tmpDir: string
  let sourceRepo: string
  let mirrorPath: string
  let mirrorMain: string
  let mirrorDev: string
  let tagCommit: string
  let sourceMain: string

  const initWorkspace = (withAlternates: boolean): string => {
    const workspace = fs.mkdtempSync(path.join(tmpDir, 'ws-'))
    git(workspace, 'init', '-q', '.')
    git(workspace, 'remote', 'add', 'origin', sourceRepo)
    if (withAlternates) {
      const infoDir = path.join(workspace, '.git', 'objects', 'info')
      fs.mkdirSync(infoDir, {recursive: true})
      fs.writeFileSync(
        path.join(infoDir, 'alternates'),
        `${mirrorPath}/objects\n`
      )
    }
    return workspace
  }

  const shallowFetch = async (
    workspace: string,
    refSpec: string[],
    options: gitCommandManager.FetchOptions
  ): Promise<{haves: Set<string>; listedAlternateRefs: boolean}> => {
    const traceDir = fs.mkdtempSync(path.join(tmpDir, 'trace-'))
    const packetTrace = path.join(traceDir, 'packet')
    const trace2 = path.join(traceDir, 'trace2')
    const git = await gitCommandManager.createCommandManager(
      workspace,
      false,
      false
    )
    git.setEnvironmentVariable('GIT_TRACE_PACKET', packetTrace)
    git.setEnvironmentVariable('GIT_TRACE2_EVENT', trace2)
    await git.fetch(refSpec, {...options, fetchDepth: 1})
    return {
      haves: havesSent(packetTrace),
      listedAlternateRefs: listedAlternateRefs(trace2, mirrorPath)
    }
  }

  const expectShallowAt = (workspace: string, sha: string): void => {
    expect(git(workspace, 'rev-parse', 'refs/remotes/origin/main')).toBe(sha)
    expect(
      fs.readFileSync(path.join(workspace, '.git', 'shallow'), 'utf8').trim()
    ).toBe(sha)
    expect(
      git(workspace, 'rev-list', '--count', 'refs/remotes/origin/main')
    ).toBe('1')
    git(workspace, 'fsck', '--connectivity-only', '--no-dangling')
    git(workspace, 'checkout', '-q', '--detach', 'refs/remotes/origin/main')
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shallow-mirror-test-'))
    sourceRepo = path.join(tmpDir, 'source')
    mirrorPath = path.join(tmpDir, 'mirror')

    fs.mkdirSync(sourceRepo)
    git(sourceRepo, 'init', '-q', '-b', 'main', '.')
    commit(sourceRepo, 'one')
    tagCommit = commit(sourceRepo, 'two')
    git(
      sourceRepo,
      '-c',
      'user.email=test@example.com',
      '-c',
      'user.name=Test',
      'tag',
      '-a',
      'v1',
      '-m',
      'annotated'
    )
    mirrorMain = commit(sourceRepo, 'three')
    git(sourceRepo, 'checkout', '-q', '-b', 'dev')
    mirrorDev = commit(sourceRepo, 'dev-only')
    git(sourceRepo, 'checkout', '-q', 'main')
    git(sourceRepo, 'update-ref', 'refs/pull/1/merge', 'HEAD')

    execFileSync('git', ['clone', '-q', '--mirror', sourceRepo, mirrorPath])

    // The mirror now lags the source by two commits on main.
    commit(sourceRepo, 'four')
    sourceMain = commit(sourceRepo, 'five')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, {recursive: true, force: true})
  })

  it('resolves negotiation tips from the mirror for each ref shape', async () => {
    const head = git(mirrorPath, 'rev-parse', 'HEAD')
    expect(head).toBe(mirrorMain)

    await expect(
      blacksmithCache.resolveShallowNegotiationTips(
        mirrorPath,
        'refs/heads/main',
        ''
      )
    ).resolves.toEqual([mirrorMain])
    await expect(
      blacksmithCache.resolveShallowNegotiationTips(
        mirrorPath,
        'refs/heads/dev',
        ''
      )
    ).resolves.toEqual([mirrorDev, mirrorMain])
    // Annotated tags peel to their commit.
    await expect(
      blacksmithCache.resolveShallowNegotiationTips(
        mirrorPath,
        'refs/tags/v1',
        ''
      )
    ).resolves.toEqual([tagCommit, mirrorMain])
    // Pull request refs are not mirrored; the base branch stands in.
    await expect(
      blacksmithCache.resolveShallowNegotiationTips(
        mirrorPath,
        'refs/pull/1/merge',
        'dev'
      )
    ).resolves.toEqual([mirrorDev, mirrorMain])
    // Unknown branch (created after the mirror was taken) and bare SHA.
    await expect(
      blacksmithCache.resolveShallowNegotiationTips(
        mirrorPath,
        'refs/heads/brand-new',
        ''
      )
    ).resolves.toEqual([mirrorMain])
    await expect(
      blacksmithCache.resolveShallowNegotiationTips(mirrorPath, '', '')
    ).resolves.toEqual([mirrorMain])
  })

  it('detects whether the workspace shares the mirror object store', async () => {
    await expect(
      blacksmithCache.sharesMirrorObjects(initWorkspace(true), mirrorPath)
    ).resolves.toBe(true)
    await expect(
      blacksmithCache.sharesMirrorObjects(initWorkspace(false), mirrorPath)
    ).resolves.toBe(false)
    await expect(
      blacksmithCache.sharesMirrorObjects(
        initWorkspace(true),
        path.join(tmpDir, 'other-mirror')
      )
    ).resolves.toBe(false)
  })

  it('negotiates from the explicit tips only and never lists alternate refs', async () => {
    const refSpec = ['+refs/heads/main:refs/remotes/origin/main']

    const plain = initWorkspace(true)
    const plainRun = await shallowFetch(plain, refSpec, {})
    expectShallowAt(plain, sourceMain)
    // Baseline: with alternate ref discovery on, every mirror ref is a tip.
    expect(plainRun.listedAlternateRefs).toBe(true)
    expect(plainRun.haves.has(mirrorDev)).toBe(true)

    const tipped = initWorkspace(true)
    const tips = await blacksmithCache.resolveShallowNegotiationTips(
      mirrorPath,
      'refs/heads/main',
      ''
    )
    const tippedRun = await shallowFetch(tipped, refSpec, {
      ignoreAlternateRefs: true,
      negotiationTips: tips
    })
    expectShallowAt(tipped, sourceMain)
    expect(tippedRun.listedAlternateRefs).toBe(false)
    expect(tippedRun.haves.has(mirrorMain)).toBe(true)
    expect(tippedRun.haves.has(mirrorDev)).toBe(false)

    // The delta pack only carried what the mirror lacks: the fetched
    // objects reachable from the tip are all readable, and the workspace's
    // own store holds no more than the two new commits' objects.
    const objectCount = git(tipped, 'count-objects', '-v')
    const loose = Number(/^count: (\d+)/m.exec(objectCount)?.[1])
    const packed = Number(/^in-pack: (\d+)/m.exec(objectCount)?.[1])
    // 2 commits + 2 trees + 2 blobs
    expect(loose + packed).toBeLessThanOrEqual(6)
    expect(git(tipped, 'cat-file', '-t', `${sourceMain}:one.txt`)).toBe('blob')
  })

  it('offers the tag commit for a shallow tag fetch', async () => {
    const workspace = initWorkspace(true)
    const tips = await blacksmithCache.resolveShallowNegotiationTips(
      mirrorPath,
      'refs/tags/v1',
      ''
    )
    const run = await shallowFetch(workspace, ['+refs/tags/v1:refs/tags/v1'], {
      ignoreAlternateRefs: true,
      negotiationTips: tips
    })
    expect(run.listedAlternateRefs).toBe(false)
    expect(git(workspace, 'rev-parse', 'refs/tags/v1^{commit}')).toBe(tagCommit)
    expect(
      fs.readFileSync(path.join(workspace, '.git', 'shallow'), 'utf8').trim()
    ).toBe(tagCommit)
  })

  it('yields the same result when the mirror tip was force-pushed away', async () => {
    // Rewrite main so nothing the mirror knows is an ancestor of the tip.
    git(sourceRepo, 'checkout', '-q', '--orphan', 'rewritten')
    git(sourceRepo, 'rm', '-rfq', '.')
    const rewritten = commit(sourceRepo, 'rewritten')
    git(sourceRepo, 'branch', '-M', 'rewritten', 'main')

    const workspace = initWorkspace(true)
    const tips = await blacksmithCache.resolveShallowNegotiationTips(
      mirrorPath,
      'refs/heads/main',
      ''
    )
    expect(tips).toEqual([mirrorMain])
    const run = await shallowFetch(
      workspace,
      ['+refs/heads/main:refs/remotes/origin/main'],
      {ignoreAlternateRefs: true, negotiationTips: tips}
    )
    expect(run.listedAlternateRefs).toBe(false)
    expectShallowAt(workspace, rewritten)
    expect(git(workspace, 'cat-file', '-t', `${rewritten}:rewritten.txt`)).toBe(
      'blob'
    )
  })

  it('fetches a detached SHA with the mirror HEAD as the only tip', async () => {
    const workspace = initWorkspace(true)
    const tips = await blacksmithCache.resolveShallowNegotiationTips(
      mirrorPath,
      '',
      ''
    )
    const run = await shallowFetch(workspace, [sourceMain], {
      ignoreAlternateRefs: true,
      negotiationTips: tips
    })
    expect(run.listedAlternateRefs).toBe(false)
    expect(run.haves.has(mirrorMain)).toBe(true)
    expect(git(workspace, 'rev-parse', 'FETCH_HEAD')).toBe(sourceMain)
    expect(
      fs.readFileSync(path.join(workspace, '.git', 'shallow'), 'utf8').trim()
    ).toBe(sourceMain)
    git(workspace, 'checkout', '-q', '--detach', sourceMain)
  })
})
