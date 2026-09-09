/**
 * Real-git coverage for the workspace-side mirror operations (ref copy,
 * dissociate) on a workspace git considers owned by another user, as in a
 * job container where the runner creates the workspace and git runs as
 * root. Git's own GIT_TEST_ASSUME_DIFFERENT_OWNER knob stands in for the
 * uid mismatch; the checkout's safe.directory entry lives in a temporary
 * HOME, so the operations only succeed when run with that environment.
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

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {encoding: 'utf8'}).trim()
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

function baseEnv(): {[key: string]: string} {
  const env: {[key: string]: string} = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value
    }
  }
  env['GIT_TEST_ASSUME_DIFFERENT_OWNER'] = '1'
  return env
}

function gitRefusesForeignOwner(): boolean {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-probe-'))
  try {
    execFileSync('git', ['init', '-q', tmp])
    execFileSync('git', ['-C', tmp, 'rev-parse', '--git-dir'], {
      env: baseEnv(),
      stdio: 'ignore'
    })
    return false
  } catch {
    return true
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true})
  }
}

const describeIfSupported = gitRefusesForeignOwner() ? describe : describe.skip

describeIfSupported(
  'workspace mirror operations on a foreign-owned workspace',
  () => {
    let tmpDir: string
    let mirrorPath: string
    let workspace: string
    let checkoutEnv: {[key: string]: string}

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-env-test-'))
      const sourceRepo = path.join(tmpDir, 'source')
      mirrorPath = path.join(tmpDir, 'mirror')
      workspace = path.join(tmpDir, 'workspace')

      fs.mkdirSync(sourceRepo)
      git(sourceRepo, 'init', '-q', '-b', 'main', '.')
      commit(sourceRepo, 'one')
      commit(sourceRepo, 'two')
      git(sourceRepo, 'tag', 'v1')
      execFileSync('git', ['clone', '-q', '--mirror', sourceRepo, mirrorPath])

      fs.mkdirSync(workspace)
      git(workspace, 'init', '-q', '.')
      git(workspace, 'remote', 'add', 'origin', sourceRepo)
      const infoDir = path.join(workspace, '.git', 'objects', 'info')
      fs.mkdirSync(infoDir, {recursive: true})
      fs.writeFileSync(
        path.join(infoDir, 'alternates'),
        `${mirrorPath}/objects\n`
      )

      // What the action's temporary global config holds after
      // `git config --global --add safe.directory <workspace>`
      const tempHome = path.join(tmpDir, 'home')
      fs.mkdirSync(tempHome)
      fs.writeFileSync(
        path.join(tempHome, '.gitconfig'),
        `[safe]\n\tdirectory = ${workspace}\n`
      )
      checkoutEnv = {...baseEnv(), HOME: tempHome}
    })

    afterEach(() => {
      fs.rmSync(tmpDir, {recursive: true, force: true})
    })

    it('dissociate fails without the checkout environment', async () => {
      await expect(
        blacksmithCache.dissociate(workspace, baseEnv())
      ).rejects.toThrow(/exit code 128/)
      expect(
        fs.existsSync(
          path.join(workspace, '.git', 'objects', 'info', 'alternates')
        )
      ).toBe(true)
    })

    it('ref copy and dissociate succeed with the checkout environment and leave a self-contained workspace', async () => {
      expect(
        await blacksmithCache.fetchRefsFromMirror(
          workspace,
          mirrorPath,
          checkoutEnv
        )
      ).toBe(true)
      // The fast path wrote packed-refs; the ref listing is what verifies it
      expect(git(workspace, 'rev-parse', 'refs/remotes/origin/main')).toBe(
        git(mirrorPath, 'rev-parse', 'refs/heads/main')
      )

      await blacksmithCache.dissociate(workspace, checkoutEnv)

      expect(
        fs.existsSync(
          path.join(workspace, '.git', 'objects', 'info', 'alternates')
        )
      ).toBe(false)
      fs.rmSync(mirrorPath, {recursive: true, force: true})
      git(workspace, 'fsck', '--no-dangling')
      git(workspace, 'rev-list', '--objects', '--all', '--quiet')
      expect(git(workspace, 'rev-parse', 'refs/tags/v1^{commit}')).toBe(
        git(workspace, 'rev-parse', 'refs/remotes/origin/main')
      )
    })
  }
)
