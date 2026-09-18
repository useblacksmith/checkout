/**
 * Post-step cleanup commit decision: mirror sync failure vetoes the commit,
 * maintenance failure or timeout does not, and maintenance only runs when
 * the result will be persisted.
 */
const mockCommitStickyDisk = jest.fn()

jest.mock('@connectrpc/connect', () => ({
  createClient: jest.fn(() => ({commitStickyDisk: mockCommitStickyDisk})),
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

jest.mock('@actions/exec')

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as exec from '@actions/exec'
import * as blacksmithCache from '../src/blacksmith-cache'

const mockExec = exec.exec as jest.MockedFunction<typeof exec.exec>
const mockGetExecOutput = exec.getExecOutput as jest.MockedFunction<
  typeof exec.getExecOutput
>

function isRepack(args: string[] | undefined): boolean {
  return (args || []).includes('repack')
}

function isPackRefs(args: string[] | undefined): boolean {
  return (args || []).includes('pack-refs')
}

function commands(): string[][] {
  return mockGetExecOutput.mock.calls.map(([tool, args]) => [
    tool,
    ...(args || [])
  ])
}

describe('cleanup commit decision', () => {
  let mirrorPath: string
  let repackExitCode: number
  let packRefsExitCode: number

  beforeEach(() => {
    jest.clearAllMocks()
    process.env.BLACKSMITH_AGENT_ADDR = '127.0.0.1'
    process.env.BLACKSMITH_STICKY_DISK_GRPC_PORT = '1'
    mirrorPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-cleanup-'))
    fs.mkdirSync(path.join(mirrorPath, 'objects', 'pack'), {recursive: true})
    repackExitCode = 0
    packRefsExitCode = 0
    mockExec.mockResolvedValue(0)
    mockGetExecOutput.mockImplementation(async (_tool, args) => ({
      exitCode: isRepack(args)
        ? repackExitCode
        : isPackRefs(args)
          ? packRefsExitCode
          : 0,
      stdout: '',
      stderr: ''
    }))
    mockCommitStickyDisk.mockResolvedValue({})
  })

  afterEach(() => {
    fs.rmSync(mirrorPath, {recursive: true, force: true})
  })

  const base = {
    exposeId: 'expose-1',
    stickyDiskKey: 'key-1',
    repoName: 'owner/repo',
    shouldCommit: true,
    vmHydratedGitMirror: true
  }

  it('runs bounded maintenance instead of gc --auto and commits', async () => {
    const result = await blacksmithCache.cleanup({...base, mirrorPath})

    expect(result.maintenanceResult).toMatchObject({
      success: true,
      timedOut: false
    })
    const repack = commands().find(c => c.includes('repack'))
    expect(repack).toBeDefined()
    expect(repack).toEqual(
      expect.arrayContaining([
        '-d',
        '-l',
        '-n',
        '--geometric=2',
        '--write-midx',
        'repack.writeBitmaps=false'
      ])
    )
    expect(commands().some(c => c.includes('gc'))).toBe(false)
    expect(mockCommitStickyDisk).toHaveBeenCalledWith(
      expect.objectContaining({shouldCommit: true, vmHydratedGitMirror: true})
    )
  })

  it('still commits when maintenance times out', async () => {
    repackExitCode = 124
    const result = await blacksmithCache.cleanup({...base, mirrorPath})

    expect(result.maintenanceResult.success).toBe(false)
    expect(result.maintenanceResult.timedOut).toBe(true)
    expect(mockCommitStickyDisk).toHaveBeenCalledWith(
      expect.objectContaining({shouldCommit: true, vmHydratedGitMirror: true})
    )
  })

  it('still commits when maintenance fails', async () => {
    repackExitCode = 128
    const result = await blacksmithCache.cleanup({...base, mirrorPath})

    expect(result.maintenanceResult).toMatchObject({
      success: false,
      timedOut: false,
      error: expect.stringContaining('128')
    })
    expect(mockCommitStickyDisk).toHaveBeenCalledWith(
      expect.objectContaining({shouldCommit: true, vmHydratedGitMirror: true})
    )
  })

  it('reports a pack-refs failure and still commits', async () => {
    packRefsExitCode = 1
    const result = await blacksmithCache.cleanup({...base, mirrorPath})

    expect(result.maintenanceResult).toMatchObject({
      success: false,
      timedOut: false,
      error: expect.stringContaining('pack-refs failed with exit code 1')
    })
    expect(mockCommitStickyDisk).toHaveBeenCalledWith(
      expect.objectContaining({shouldCommit: true, vmHydratedGitMirror: true})
    )
  })

  it('reports a pack-refs timeout and still commits', async () => {
    packRefsExitCode = 124
    const result = await blacksmithCache.cleanup({...base, mirrorPath})

    expect(result.maintenanceResult).toMatchObject({
      success: false,
      timedOut: true,
      error: expect.stringContaining('pack-refs timed out')
    })
    expect(mockCommitStickyDisk).toHaveBeenCalledWith(
      expect.objectContaining({shouldCommit: true, vmHydratedGitMirror: true})
    )
  })

  it('does not commit or run maintenance when the mirror sync failed', async () => {
    const result = await blacksmithCache.cleanup({
      ...base,
      mirrorPath,
      mirrorSyncFailed: true
    })

    expect(result.maintenanceResult).toEqual({
      success: true,
      timedOut: false,
      skipped: true
    })
    expect(commands().some(c => c.includes('repack'))).toBe(false)
    expect(mockCommitStickyDisk).toHaveBeenCalledWith(
      expect.objectContaining({shouldCommit: false, vmHydratedGitMirror: true})
    )
  })

  it('does not commit or run maintenance when the mirror sync timed out', async () => {
    await blacksmithCache.cleanup({
      ...base,
      mirrorPath,
      mirrorSyncTimedOut: true
    })

    expect(commands().some(c => c.includes('repack'))).toBe(false)
    expect(mockCommitStickyDisk).toHaveBeenCalledWith(
      expect.objectContaining({shouldCommit: false, vmHydratedGitMirror: true})
    )
  })

  it('reports a performed hydration as-is when the job is not committing', async () => {
    await blacksmithCache.cleanup({
      ...base,
      mirrorPath,
      shouldCommit: false,
      vmHydratedGitMirror: true
    })

    expect(commands().some(c => c.includes('repack'))).toBe(false)
    expect(mockCommitStickyDisk).toHaveBeenCalledWith(
      expect.objectContaining({shouldCommit: false, vmHydratedGitMirror: true})
    )
  })

  it('skips maintenance when the disk is released without commit', async () => {
    await blacksmithCache.cleanup({
      ...base,
      mirrorPath,
      shouldCommit: false,
      vmHydratedGitMirror: false
    })

    expect(commands().some(c => c.includes('repack'))).toBe(false)
    expect(mockCommitStickyDisk).toHaveBeenCalledWith(
      expect.objectContaining({shouldCommit: false})
    )
  })
})
