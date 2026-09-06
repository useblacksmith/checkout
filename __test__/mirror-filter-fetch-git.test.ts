/**
 * Real-git coverage for fetching into a workspace that shares the mirror's
 * objects through alternates when the caller asked for an object filter: the
 * unfiltered fetch the action issues instead only transfers the delta and
 * leaves the workspace a plain (non-partial) clone, whereas honouring the
 * filter would repack mirror objects into a local promisor pack.
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
import {GitVersion} from '../src/git-version'

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

function objectCount(workspace: string): number {
  const counts = git(workspace, 'count-objects', '-v')
  return (
    Number(/^count: (\d+)/m.exec(counts)?.[1]) +
    Number(/^in-pack: (\d+)/m.exec(counts)?.[1])
  )
}

function promisorPacks(workspace: string): string[] {
  const packDir = path.join(workspace, '.git', 'objects', 'pack')
  if (!fs.existsSync(packDir)) {
    return []
  }
  return fs.readdirSync(packDir).filter(name => name.endsWith('.promisor'))
}

/** git 2.48 started repacking locally available objects linked from a promisor pack. */
const RepacksLocalLinksVersion = new GitVersion('2.48')

describe('object filters with mirror alternates and real git', () => {
  let tmpDir: string
  let sourceRepo: string
  let mirrorPath: string
  let mirrorCommitCount: number
  let sourceMain: string

  const initWorkspace = (): string => {
    const workspace = fs.mkdtempSync(path.join(tmpDir, 'ws-'))
    git(workspace, 'init', '-q', '.')
    git(workspace, 'remote', 'add', 'origin', sourceRepo)
    const infoDir = path.join(workspace, '.git', 'objects', 'info')
    fs.mkdirSync(infoDir, {recursive: true})
    fs.writeFileSync(
      path.join(infoDir, 'alternates'),
      `${mirrorPath}/objects\n`
    )
    return workspace
  }

  const fetchMain = async (
    workspace: string,
    options: gitCommandManager.FetchOptions
  ): Promise<GitVersion> => {
    const git = await gitCommandManager.createCommandManager(
      workspace,
      false,
      false
    )
    await git.fetch(['+refs/heads/main:refs/remotes/origin/main'], options)
    return git.version()
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-filter-test-'))
    sourceRepo = path.join(tmpDir, 'source')
    mirrorPath = path.join(tmpDir, 'mirror')

    fs.mkdirSync(sourceRepo)
    git(sourceRepo, 'init', '-q', '-b', 'main', '.')
    git(sourceRepo, 'config', 'uploadpack.allowFilter', 'true')
    for (let i = 0; i < 20; i++) {
      commit(sourceRepo, `history-${i}`)
    }
    execFileSync('git', ['clone', '-q', '--mirror', sourceRepo, mirrorPath])
    mirrorCommitCount = Number(git(mirrorPath, 'rev-list', '--count', 'HEAD'))

    // The mirror now lags the source by two commits on main.
    commit(sourceRepo, 'new-1')
    sourceMain = commit(sourceRepo, 'new-2')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, {recursive: true, force: true})
  })

  it('shares the mirror object store', async () => {
    await expect(
      blacksmithCache.sharesMirrorObjects(initWorkspace(), mirrorPath)
    ).resolves.toBe(true)
  })

  it.each([{fetchDepth: undefined}, {fetchDepth: 2}])(
    'an unfiltered fetch (%o) only stores the delta and stays a full clone',
    async ({fetchDepth}) => {
      const workspace = initWorkspace()
      await fetchMain(workspace, fetchDepth ? {fetchDepth} : {})

      expect(git(workspace, 'rev-parse', 'refs/remotes/origin/main')).toBe(
        sourceMain
      )
      // 2 commits + 2 trees + 2 blobs
      expect(objectCount(workspace)).toBeLessThanOrEqual(6)
      expect(promisorPacks(workspace)).toEqual([])
      expect(
        fs.readFileSync(path.join(workspace, '.git', 'config'), 'utf8')
      ).not.toMatch(/promisor|partialclonefilter/i)

      // Old and new blobs alike are readable and the tree checks out whole.
      expect(
        git(workspace, 'cat-file', '-t', `${sourceMain}:history-0.txt`)
      ).toBe('blob')
      git(workspace, 'checkout', '-q', '--detach', 'refs/remotes/origin/main')
      expect(
        fs.readdirSync(workspace).filter(f => f.endsWith('.txt'))
      ).toHaveLength(22)
      git(workspace, 'fsck', '--connectivity-only', '--no-dangling')
    }
  )

  it('a blob:none fetch would repack mirror objects into a promisor pack', async () => {
    const workspace = initWorkspace()
    const version = await fetchMain(workspace, {filter: 'blob:none'})

    expect(git(workspace, 'rev-parse', 'refs/remotes/origin/main')).toBe(
      sourceMain
    )
    expect(promisorPacks(workspace)).not.toEqual([])
    if (version.checkMinimum(RepacksLocalLinksVersion)) {
      // The mirror's whole history behind the fetched commits was copied.
      expect(objectCount(workspace)).toBeGreaterThan(mirrorCommitCount)
    }
  })
})
