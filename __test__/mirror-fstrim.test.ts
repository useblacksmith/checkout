/**
 * Pre-unmount fstrim in cleanup: runs only with a positive host budget when
 * committing, as root (via asRoot), and its result is carried in
 * CleanupResult and folded into a maintenance row for the agent.
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

import * as exec from '@actions/exec'
import * as blacksmithCache from '../src/blacksmith-cache'
import {maintenanceRunFromTrim} from '../src/mirror-telemetry'

const mockExec = exec.exec as jest.MockedFunction<typeof exec.exec>
const mockGetExecOutput = exec.getExecOutput as jest.MockedFunction<
  typeof exec.getExecOutput
>

function fstrimCalls(): string[][] {
  return mockGetExecOutput.mock.calls
    .map(([tool, args]) => [tool, ...(args || [])])
    .filter(c => c.includes('fstrim'))
}

describe('cleanup fstrim', () => {
  let fstrimExitCode: number
  let fstrimStdout: string
  let fstrimStderr: string

  beforeEach(() => {
    jest.clearAllMocks()
    process.env.BLACKSMITH_AGENT_ADDR = '127.0.0.1'
    process.env.BLACKSMITH_STICKY_DISK_GRPC_PORT = '1'
    fstrimExitCode = 0
    fstrimStdout = '/mnt/m: 1 GiB (1073741824 bytes) trimmed\n'
    fstrimStderr = ''
    mockExec.mockResolvedValue(0)
    mockGetExecOutput.mockImplementation(async (tool, args) => {
      const argv = [tool, ...(args || [])]
      if (argv.includes('fstrim')) {
        return {
          exitCode: fstrimExitCode,
          stdout: fstrimStdout,
          stderr: fstrimStderr
        }
      }
      return {exitCode: 0, stdout: '', stderr: ''}
    })
    mockCommitStickyDisk.mockResolvedValue({})
  })

  const base = {
    exposeId: 'expose-1',
    stickyDiskKey: 'key-1',
    repoName: 'owner/repo',
    mountPoint: '/mnt/m',
    shouldCommit: true,
    vmHydratedGitMirror: false,
    fstrimTimeoutSecs: 5
  }

  it('trims as root before unmount and reports the bytes', async () => {
    const result = await blacksmithCache.cleanup({
      ...base,
      fstrimMinExtentBytes: 4194304
    })

    const calls = fstrimCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual([
      ...blacksmithCache.asRoot('timeout', '5', 'fstrim', '-v'),
      '-m',
      '4194304',
      '--',
      '/mnt/m'
    ])
    const all = mockGetExecOutput.mock.calls.map(([tool, args]) => [
      tool,
      ...(args || [])
    ])
    expect(all.findIndex(c => c.includes('fstrim'))).toBeLessThan(
      all.findIndex(c => c.includes('umount'))
    )
    expect(result.fstrimResult).toMatchObject({
      outcome: 'ok',
      trimmedBytes: 1073741824
    })
  })

  it('omits -m without a minimum extent', async () => {
    await blacksmithCache.cleanup(base)
    expect(fstrimCalls()[0]).not.toContain('-m')
  })

  it('skips the trim without a budget or when not committing', async () => {
    await blacksmithCache.cleanup({...base, fstrimTimeoutSecs: 0})
    await blacksmithCache.cleanup({...base, shouldCommit: false})
    const noBudget = await blacksmithCache.cleanup({
      ...base,
      fstrimTimeoutSecs: undefined
    })
    expect(fstrimCalls()).toHaveLength(0)
    expect(noBudget.fstrimResult).toBeUndefined()
  })

  it('classifies timeout, unsupported and failure without failing cleanup', async () => {
    fstrimExitCode = 124
    fstrimStdout = ''
    let result = await blacksmithCache.cleanup(base)
    expect(result.fstrimResult).toMatchObject({
      outcome: 'timeout',
      trimmedBytes: 0
    })

    fstrimExitCode = 1
    fstrimStderr = 'fstrim: /mnt/m: the discard operation is not supported'
    result = await blacksmithCache.cleanup(base)
    expect(result.fstrimResult?.outcome).toBe('unsupported')

    fstrimStderr = 'fstrim: /mnt/m: FITRIM ioctl failed: Input/output error'
    result = await blacksmithCache.cleanup(base)
    expect(result.fstrimResult?.outcome).toBe('failed')
    expect(mockCommitStickyDisk).toHaveBeenCalledTimes(3)
  })
})

describe('maintenanceRunFromTrim', () => {
  it('folds the trim outcome into the maintenance vocabulary', () => {
    expect(
      maintenanceRunFromTrim('key-1', {
        outcome: 'ok',
        durationMs: 40,
        trimmedBytes: 1073741824
      })
    ).toEqual({
      op: 'fstrim',
      sticky_disk_key: 'key-1',
      duration_ms: 40,
      bytes: 1073741824,
      outcome: 'success',
      mirror_size_bytes: 0
    })
    expect(
      maintenanceRunFromTrim('key-1', {
        outcome: 'timeout',
        durationMs: 5000,
        trimmedBytes: 0
      })
    ).toMatchObject({outcome: 'timeout', error_class: 'timeout'})
    expect(
      maintenanceRunFromTrim('key-1', {
        outcome: 'unsupported',
        durationMs: 3,
        trimmedBytes: 0
      })
    ).toMatchObject({outcome: 'failure', error_class: 'unsupported'})
    expect(
      maintenanceRunFromTrim('key-1', {
        outcome: 'failed',
        durationMs: 3,
        trimmedBytes: 0
      })
    ).toMatchObject({outcome: 'failure', error_class: 'error'})
  })
})
