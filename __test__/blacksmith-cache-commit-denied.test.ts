const mockClient = {
  up: jest.fn(),
  getStickyDisk: jest.fn()
}

jest.mock('@connectrpc/connect', () => ({
  createClient: jest.fn(() => mockClient),
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

jest.mock('@actions/exec', () => ({
  exec: jest.fn(async () => 0),
  getExecOutput: jest.fn(async (_tool: string, args?: string[]) => {
    const stdout = args?.[0] === 'blockdev' ? '1073741824\n' : 'TYPE="ext4"\n'
    return {exitCode: 0, stdout, stderr: ''}
  })
}))

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as blacksmithCache from '../src/blacksmith-cache'

const agentResponse = {
  exposeId: 'expose-1',
  diskIdentifier: '/dev/vdb',
  parentSnapshotName: '',
  cloneName: '',
  commitEarlyDeny: false,
  commitEarlyDenyReason: ''
}

describe('sticky disk commit denied at expose time', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      BLACKSMITH_VM_ID: 'vm-1',
      BLACKSMITH_AGENT_ADDR: '127.0.0.1',
      BLACKSMITH_STICKY_DISK_GRPC_PORT: '5557'
    }
    mockClient.up.mockResolvedValue({})
  })

  afterEach(() => {
    process.env = originalEnv
    jest.clearAllMocks()
  })

  it('setupCache reports the denial and its reason', async () => {
    mockClient.getStickyDisk.mockResolvedValue({
      ...agentResponse,
      commitEarlyDeny: true,
      commitEarlyDenyReason:
        'branch protection: event "pull_request" is not a trusted trigger'
    })

    const cacheInfo = await blacksmithCache.setupCache('owner', 'repo')

    expect(cacheInfo.hydrationInProgress).toBe(false)
    expect(cacheInfo.exposeId).toBe('expose-1')
    expect(cacheInfo.commitDenied).toBe(true)
    expect(cacheInfo.commitDeniedReason).toContain('pull_request')
  })

  it('setupCache leaves the mirror committable when the agent allows it', async () => {
    mockClient.getStickyDisk.mockResolvedValue(agentResponse)

    const cacheInfo = await blacksmithCache.setupCache('owner', 'repo')

    expect(cacheInfo.commitDenied).toBe(false)
    expect(cacheInfo.commitDeniedReason).toBeUndefined()
  })

  describe('shouldSkipHydration', () => {
    let tmpDir: string

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-denied-'))
    })

    afterEach(() => {
      fs.rmSync(tmpDir, {recursive: true, force: true})
    })

    function cacheInfoFor(
      mirrorPath: string,
      commitDenied: boolean
    ): blacksmithCache.CacheInfo {
      return {
        exposeId: 'expose-1',
        stickyDiskKey: 'owner-repo',
        repoName: 'owner/repo',
        device: '/dev/vdb',
        mountPoint: tmpDir,
        mirrorPath,
        hydrationInProgress: false,
        performedHydration: false,
        commitDenied
      }
    }

    it('skips the initial clone when the commit is denied and no mirror exists', () => {
      const mirrorPath = path.join(tmpDir, 'v1', 'owner-repo.git')
      expect(
        blacksmithCache.shouldSkipHydration(cacheInfoFor(mirrorPath, true))
      ).toBe(true)
    })

    it('still uses an existing mirror when the commit is denied', () => {
      const mirrorPath = path.join(tmpDir, 'v1', 'owner-repo.git')
      fs.mkdirSync(mirrorPath, {recursive: true})
      expect(
        blacksmithCache.shouldSkipHydration(cacheInfoFor(mirrorPath, true))
      ).toBe(false)
    })

    it('hydrates when the commit is allowed', () => {
      const mirrorPath = path.join(tmpDir, 'v1', 'owner-repo.git')
      expect(
        blacksmithCache.shouldSkipHydration(cacheInfoFor(mirrorPath, false))
      ).toBe(false)
    })
  })
})
