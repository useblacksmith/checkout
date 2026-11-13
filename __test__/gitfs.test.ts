// gitfs.ts pulls in blacksmith-cache for the auth header; stub its gRPC
// dependencies the same way blacksmith-cache.test.ts does.
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
  () => ({StickyDiskService: {}})
)

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {execFileSync} from 'child_process'
import * as gitfs from '../src/gitfs'

const settings = (
  overrides: Partial<gitfs.EligibilitySettings> = {}
): gitfs.EligibilitySettings => ({
  ref: 'refs/heads/main',
  commit: '',
  submodules: false,
  lfs: false,
  sparseCheckout: [],
  filter: undefined,
  dissociate: false,
  repositoryPath: path.join(os.tmpdir(), 'gitfs-test-does-not-exist'),
  ...overrides
})

const ctx: gitfs.EligibilityContext = {
  mirrorPath: '/mnt/git-mirror/owner-repo.git',
  platform: 'linux',
  inContainer: false
}

describe('isGitfsRequested', () => {
  it('is driven by BLACKSMITH_USE_GITFS=true only', () => {
    expect(gitfs.isGitfsRequested({})).toBe(false)
    expect(gitfs.isGitfsRequested({BLACKSMITH_USE_GITFS: 'false'})).toBe(false)
    expect(gitfs.isGitfsRequested({BLACKSMITH_USE_GITFS: 'TRUE'})).toBe(false)
    expect(gitfs.isGitfsRequested({BLACKSMITH_USE_GITFS: 'true'})).toBe(true)
  })
})

describe('gitfsIneligibilityReason', () => {
  it('accepts the plain linux + mirror case', () => {
    expect(gitfs.gitfsIneligibilityReason(settings(), ctx)).toBeNull()
    expect(
      gitfs.gitfsIneligibilityReason(
        settings({ref: '', commit: 'a'.repeat(40)}),
        ctx
      )
    ).toBeNull()
  })

  it('needs a mounted mirror on a linux runner outside a container', () => {
    expect(
      gitfs.gitfsIneligibilityReason(settings(), {...ctx, mirrorPath: null})
    ).toMatch(/mirror/)
    expect(
      gitfs.gitfsIneligibilityReason(settings(), {...ctx, platform: 'darwin'})
    ).toMatch(/linux/)
    expect(
      gitfs.gitfsIneligibilityReason(settings(), {...ctx, inContainer: true})
    ).toMatch(/container/)
  })

  it('leaves features the fetch path implements to the fetch path', () => {
    expect(
      gitfs.gitfsIneligibilityReason(settings({submodules: true}), ctx)
    ).toMatch(/submodules/)
    expect(gitfs.gitfsIneligibilityReason(settings({lfs: true}), ctx)).toMatch(
      /lfs/
    )
    expect(
      gitfs.gitfsIneligibilityReason(settings({sparseCheckout: ['src']}), ctx)
    ).toMatch(/sparse/)
    expect(
      gitfs.gitfsIneligibilityReason(settings({filter: 'blob:none'}), ctx)
    ).toMatch(/filter/)
    expect(
      gitfs.gitfsIneligibilityReason(settings({dissociate: true}), ctx)
    ).toMatch(/dissociate/)
    expect(
      gitfs.gitfsIneligibilityReason(settings({ref: '', commit: ''}), ctx)
    ).toMatch(/ref or commit/)
  })

  it('does not mount over an existing repository', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitfs-elig-'))
    try {
      fs.mkdirSync(path.join(dir, '.git'))
      expect(
        gitfs.gitfsIneligibilityReason(settings({repositoryPath: dir}), ctx)
      ).toMatch(/already contains/)
    } finally {
      fs.rmSync(dir, {recursive: true, force: true})
    }
  })
})

describe('mirrorRevisionCandidates', () => {
  const sha = 'b'.repeat(40)

  it('prefers the commit and keeps the ref it belongs to', () => {
    expect(gitfs.mirrorRevisionCandidates('refs/heads/main', sha)).toEqual([
      {rev: `${sha}^{commit}`, mirrorRef: 'refs/heads/main', kind: 'branch'}
    ])
    expect(gitfs.mirrorRevisionCandidates('refs/pull/42/merge', sha)).toEqual([
      {rev: `${sha}^{commit}`, mirrorRef: 'refs/pull/42/merge', kind: 'pull'}
    ])
    expect(gitfs.mirrorRevisionCandidates('', sha)).toEqual([
      {rev: `${sha}^{commit}`, mirrorRef: '', kind: 'commit'}
    ])
    // An unqualified ref alongside a commit does not name a mirror ref.
    expect(gitfs.mirrorRevisionCandidates('main', sha)).toEqual([
      {rev: `${sha}^{commit}`, mirrorRef: '', kind: 'other'}
    ])
  })

  it('peels qualified refs to commits', () => {
    expect(gitfs.mirrorRevisionCandidates('refs/tags/v1', '')).toEqual([
      {rev: 'refs/tags/v1^{commit}', mirrorRef: 'refs/tags/v1', kind: 'tag'}
    ])
  })

  it('tries an unqualified ref as a branch, then a tag', () => {
    expect(
      gitfs.mirrorRevisionCandidates('v1', '').map(c => c.mirrorRef)
    ).toEqual(['refs/heads/v1', 'refs/tags/v1'])
    expect(gitfs.mirrorRevisionCandidates('', '')).toEqual([])
  })
})

describe('coldRevision', () => {
  const sha = 'a'.repeat(40)
  it('fetches a commit by sha, a qualified ref by name, a bare ref as a branch', () => {
    expect(gitfs.coldRevision('refs/pull/7/merge', sha)).toBe(sha)
    expect(gitfs.coldRevision('refs/pull/7/merge', '')).toBe(
      'refs/pull/7/merge'
    )
    expect(gitfs.coldRevision('refs/tags/v1', '')).toBe('refs/tags/v1')
    expect(gitfs.coldRevision('dev', '')).toBe('refs/heads/dev')
  })
})

describe('mountCold (needs gitfs on PATH)', () => {
  it('mounts a revision an empty mirror lacks and completes the mirror', async () => {
    const binary = await gitfs.findBinary()
    if (!binary) {
      console.log('skipping: gitfs not on PATH')
      return
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitfs-cold-'))
    const git = (cwd: string, ...args: string[]): string =>
      execFileSync('git', args, {cwd, stdio: 'pipe'}).toString().trim()
    const author = ['-c', 'user.name=t', '-c', 'user.email=t@t']
    const work = path.join(root, 'work')
    fs.mkdirSync(work)
    git(work, 'init', '-q', '-b', 'main')
    git(work, ...author, 'commit', '-q', '--allow-empty', '-m', 'first')
    fs.writeFileSync(path.join(work, 'hello.txt'), 'hello\n')
    git(work, 'add', '-A')
    git(work, ...author, 'commit', '-q', '-m', 'second')
    const upstream = path.join(root, 'upstream.git')
    git(root, 'clone', '-q', '--bare', work, upstream)
    const url = `file://${upstream}`
    const mirror = path.join(root, 'mirror.git')
    git(root, 'init', '-q', '--bare', mirror)
    git(mirror, 'remote', 'add', '--mirror=fetch', 'origin', url)
    const mnt = path.join(root, 'ws')
    fs.mkdirSync(mnt)
    try {
      const sha = await gitfs.mountCold(
        binary,
        mirror,
        'refs/heads/main',
        mnt,
        url,
        ''
      )
      expect(sha).toBe(git(upstream, 'rev-parse', 'refs/heads/main'))
      expect(fs.readFileSync(path.join(mnt, 'hello.txt'), 'utf8')).toBe(
        'hello\n'
      )
      const deadline = Date.now() + 30000
      while (
        fs.existsSync(path.join(mirror, 'shallow')) &&
        Date.now() < deadline
      ) {
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      expect(fs.existsSync(path.join(mirror, 'shallow'))).toBe(false)
      expect(git(mirror, 'rev-list', '--count', 'main')).toBe('2')
    } finally {
      await gitfs.teardown(mnt, mirror)
      fs.rmSync(root, {recursive: true, force: true})
    }
  }, 60000)
})
