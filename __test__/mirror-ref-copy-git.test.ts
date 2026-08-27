/**
 * Real-git coverage for the direct mirror ref copy used by fetch-depth: 0
 * checkouts: fresh and reused workspaces, symbolic-ref (origin/HEAD)
 * preservation, pruning, annotated tags, connectivity, eligibility gating
 * (alternates, ref backend), and the local-fetch fallback.
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

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {encoding: 'utf8'}).trim()
}

function refMap(repo: string): Map<string, string> {
  const out = git(repo, 'for-each-ref', '--format=%(objectname) %(refname)')
  const map = new Map<string, string>()
  for (const line of out.split('\n')) {
    const [sha, ref] = line.trim().split(' ')
    if (sha && ref) {
      map.set(ref, sha)
    }
  }
  return map
}

function commit(repo: string, msg: string): void {
  fs.writeFileSync(path.join(repo, 'file.txt'), msg)
  git(repo, 'add', 'file.txt')
  git(
    repo,
    '-c',
    'user.email=test@example.com',
    '-c',
    'user.name=Test',
    'commit',
    '-m',
    msg
  )
}

function gitSupportsReftable(): boolean {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reftable-probe-'))
  try {
    execFileSync('git', ['init', '--ref-format=reftable', tmp], {
      stdio: 'ignore'
    })
    return true
  } catch {
    return false
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true})
  }
}

describe('mirror ref copy with real git', () => {
  let tmpDir: string
  let sourceRepo: string
  let mirrorPath: string

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

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-copy-test-'))
    sourceRepo = path.join(tmpDir, 'source')
    mirrorPath = path.join(tmpDir, 'mirror')

    fs.mkdirSync(sourceRepo)
    git(sourceRepo, 'init', '-q', '-b', 'main', '.')
    commit(sourceRepo, 'one')
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
    git(sourceRepo, 'tag', 'light')
    git(sourceRepo, 'branch', 'dev')
    git(sourceRepo, 'update-ref', 'refs/pull/1/merge', 'HEAD')

    execFileSync('git', ['clone', '-q', '--mirror', sourceRepo, mirrorPath])
  })

  afterEach(() => {
    fs.rmSync(tmpDir, {recursive: true, force: true})
  })

  it('fresh workspace: packed-refs fast path with exact refs, connectivity, lazy tag peel', async () => {
    const workspace = initWorkspace(true)

    expect(
      await blacksmithCache.copyRefsFromMirror(workspace, mirrorPath)
    ).toBe(true)

    const refs = refMap(workspace)
    const mainSha = git(mirrorPath, 'rev-parse', 'refs/heads/main')
    expect(refs.get('refs/remotes/origin/main')).toBe(mainSha)
    expect(refs.get('refs/remotes/origin/dev')).toBe(mainSha)
    expect(refs.has('refs/tags/v1')).toBe(true)
    expect(refs.has('refs/tags/light')).toBe(true)
    expect([...refs.keys()].some(r => r.includes('refs/pull'))).toBe(false)

    // The fast path wrote packed-refs directly and never ran a fetch
    expect(fs.existsSync(path.join(workspace, '.git', 'packed-refs'))).toBe(
      true
    )
    expect(fs.existsSync(path.join(workspace, '.git', 'FETCH_HEAD'))).toBe(
      false
    )

    // Annotated tag peels lazily through the alternate object store
    expect(git(workspace, 'rev-parse', 'v1^{commit}')).toBe(mainSha)
    // All copied refs are connected
    git(workspace, 'fsck', '--no-dangling')
    git(workspace, 'rev-list', '--objects', '--all', '--quiet')
  })

  it('reused workspace: reconciles changes, prunes, preserves origin/HEAD, clears stale FETCH_HEAD', async () => {
    const workspace = initWorkspace(true)
    await blacksmithCache.copyRefsFromMirror(workspace, mirrorPath)
    git(workspace, 'remote', 'set-head', 'origin', 'main')
    fs.writeFileSync(
      path.join(workspace, '.git', 'FETCH_HEAD'),
      'stale content\n'
    )

    // Advance main, delete dev, add a branch upstream; sync the mirror
    commit(sourceRepo, 'two')
    git(sourceRepo, 'branch', '-D', 'dev')
    git(sourceRepo, 'branch', 'feature')
    git(mirrorPath, 'fetch', '-q', '--prune', 'origin')

    expect(
      await blacksmithCache.copyRefsFromMirror(workspace, mirrorPath)
    ).toBe(true)

    const refs = refMap(workspace)
    const newMain = git(mirrorPath, 'rev-parse', 'refs/heads/main')
    expect(refs.get('refs/remotes/origin/main')).toBe(newMain)
    expect(refs.get('refs/remotes/origin/feature')).toBe(newMain)
    expect(refs.has('refs/remotes/origin/dev')).toBe(false)

    // origin/HEAD survives as a symref and its target branch still exists
    expect(git(workspace, 'symbolic-ref', 'refs/remotes/origin/HEAD')).toBe(
      'refs/remotes/origin/main'
    )
    expect(git(workspace, 'rev-parse', 'refs/remotes/origin/HEAD')).toBe(
      newMain
    )
    expect(fs.existsSync(path.join(workspace, '.git', 'FETCH_HEAD'))).toBe(
      false
    )
    git(workspace, 'fsck', '--no-dangling')
  })

  it('workspace without the mirror alternate: copy refuses, local-fetch fallback produces complete refs and objects', async () => {
    const workspace = initWorkspace(false)

    expect(
      await blacksmithCache.copyRefsFromMirror(workspace, mirrorPath)
    ).toBe(false)
    expect(refMap(workspace).size).toBe(0)

    expect(
      await blacksmithCache.fetchRefsFromMirror(workspace, mirrorPath)
    ).toBe(true)
    const refs = refMap(workspace)
    expect(refs.has('refs/remotes/origin/main')).toBe(true)
    expect(refs.has('refs/remotes/origin/dev')).toBe(true)
    expect(refs.has('refs/tags/v1')).toBe(true)
    // The fetch moved the objects: everything resolves without any alternate
    git(workspace, 'fsck', '--no-dangling')
    git(workspace, 'rev-list', '--objects', '--all', '--quiet')
  })

  it('workspace whose alternates point at a different object store: copy refuses', async () => {
    const workspace = initWorkspace(false)
    const otherStore = path.join(tmpDir, 'other')
    fs.mkdirSync(otherStore)
    const infoDir = path.join(workspace, '.git', 'objects', 'info')
    fs.mkdirSync(infoDir, {recursive: true})
    fs.writeFileSync(path.join(infoDir, 'alternates'), `${otherStore}\n`)

    expect(
      await blacksmithCache.copyRefsFromMirror(workspace, mirrorPath)
    ).toBe(false)
  })

  const maybeReftable = gitSupportsReftable() ? it : it.skip
  maybeReftable(
    'reftable workspace: copy refuses so packed-refs is never written',
    async () => {
      const workspace = fs.mkdtempSync(path.join(tmpDir, 'ws-'))
      execFileSync('git', [
        'init',
        '-q',
        '--ref-format=reftable',
        '-b',
        'main',
        workspace
      ])
      git(workspace, 'remote', 'add', 'origin', sourceRepo)
      const infoDir = path.join(workspace, '.git', 'objects', 'info')
      fs.mkdirSync(infoDir, {recursive: true})
      fs.writeFileSync(
        path.join(infoDir, 'alternates'),
        `${mirrorPath}/objects\n`
      )

      expect(
        await blacksmithCache.copyRefsFromMirror(workspace, mirrorPath)
      ).toBe(false)
      expect(fs.existsSync(path.join(workspace, '.git', 'packed-refs'))).toBe(
        false
      )

      // The fallback local fetch still materializes the refs correctly
      expect(
        await blacksmithCache.fetchRefsFromMirror(workspace, mirrorPath)
      ).toBe(true)
      expect(refMap(workspace).has('refs/remotes/origin/main')).toBe(true)
    }
  )
})
