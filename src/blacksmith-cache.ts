import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as fs from 'fs'
import * as path from 'path'
import {createClient, ConnectError, Code} from '@connectrpc/connect'
import {createGrpcTransport} from '@connectrpc/connect-node'
import {StickyDiskService} from '@buf/blacksmith_vm-agent.connectrpc_es/stickydisk/v1/stickydisk_connect'
import * as retryHelper from './retry-helper'

const GRPC_PORT = process.env.BLACKSMITH_STICKY_DISK_GRPC_PORT || '5557'
const MOUNT_BASE = '/blacksmith-git-mirror'
const MIRROR_VERSION = 'v1'

const REFRESH_TIMEOUT_SECS = 120 // 2 minutes
const GC_TIMEOUT_SECS = 60 // 60 seconds
const FSCK_TIMEOUT_SECS = 30 // 30 seconds

// Exit code returned by the `timeout` command when the child is killed.
const TIMEOUT_EXIT_CODE = 124

/**
 * Result of a git mirror operation that may fail or time out.
 */
export interface OperationResult {
  success: boolean
  timedOut: boolean
  error?: string
}

/**
 * Result of the cleanup phase, used for metric reporting.
 */
export interface CleanupResult {
  gcResult: OperationResult
  fsckResult: OperationResult
}

/**
 * Get the mount point for a specific repository.
 * Each repository gets its own mount point to support multiple checkouts.
 * Uses directory structure (owner/repo) to avoid collisions from hyphenated names
 * (e.g., foo-bar/baz vs foo/bar-baz would collide with a flat naming scheme).
 */
export function getMountPoint(owner: string, repo: string): string {
  return path.join(MOUNT_BASE, owner, repo)
}

export interface CacheInfo {
  exposeId: string
  stickyDiskKey: string
  repoName: string
  device: string
  mountPoint: string
  mirrorPath: string
  // hydrationInProgress indicates that another job is currently hydrating the git mirror.
  // When true, the caller should fall back to regular checkout without using the cache.
  hydrationInProgress: boolean
  hydrationMessage?: string
  // performedHydration indicates that this job performed the initial git mirror clone.
  // Used to notify the backend on commit so it can mark hydration as complete.
  performedHydration: boolean
}

/**
 * Check if running in a Blacksmith environment by detecting BLACKSMITH_VM_ID
 */
export function isBlacksmithEnvironment(): boolean {
  return !!process.env.BLACKSMITH_VM_ID
}

/**
 * Get the path where the bare git mirror will be stored.
 * Uses owner-repo.git filename to maintain backward compatibility with existing sticky disks.
 */
export function getMirrorPath(owner: string, repo: string): string {
  const mountPoint = getMountPoint(owner, repo)
  return path.join(mountPoint, MIRROR_VERSION, `${owner}-${repo}.git`)
}

/**
 * Create a gRPC client for communicating with the Blacksmith VM agent
 */
function createBlacksmithClient() {
  core.debug(`Creating Blacksmith agent client with port: ${GRPC_PORT}`)
  const transport = createGrpcTransport({
    baseUrl: `http://192.168.127.1:${GRPC_PORT}`,
    httpVersion: '2'
  })

  return createClient(StickyDiskService, transport)
}

/**
 * Format the block device with ext4 if not already formatted
 */
async function maybeFormatDevice(device: string): Promise<void> {
  // Check if already formatted
  const result = await exec.getExecOutput('sudo', ['blkid', device], {
    ignoreReturnCode: true
  })

  if (result.exitCode === 0 && result.stdout.includes('TYPE=')) {
    core.debug(`Device ${device} is already formatted`)
    // Resize to use full block device
    try {
      await exec.exec('sudo', ['resize2fs', '-f', device])
      core.debug(`Resized filesystem on ${device}`)
    } catch {
      core.warning(`Error resizing filesystem on ${device}`)
    }
    return
  }

  // Format with ext4
  core.info(`Formatting device ${device} with ext4`)
  await exec.exec('sudo', [
    'mkfs.ext4',
    '-m0',
    '-Enodiscard,lazy_itable_init=1,lazy_journal_init=1',
    '-F',
    device
  ])
  core.debug(`Successfully formatted ${device} with ext4`)
}

/**
 * Request a sticky disk from the VM agent, format if needed, and mount it.
 * Returns CacheInfo with hydrationInProgress=true if another job is hydrating,
 * allowing the caller to fall back to regular checkout.
 */
export async function setupCache(
  owner: string,
  repo: string
): Promise<CacheInfo> {
  const client = createBlacksmithClient()
  const stickyDiskKey = `${owner}-${repo}`

  // Test connection
  core.info(`[git-mirror] Connecting to Blacksmith agent for ${stickyDiskKey}`)
  try {
    await client.up({})
    core.debug('[git-mirror] Successfully connected to Blacksmith agent')
  } catch (error) {
    throw new Error(`gRPC connection test failed: ${(error as Error).message}`)
  }

  core.info(`[git-mirror] Requesting sticky disk for ${stickyDiskKey}`)

  // Request sticky disk from VM agent
  // Use the actual repo being checked out (owner/repo), not GITHUB_REPO_NAME
  // This ensures each repo gets its own isolated sticky disk
  const repoName = `${owner}/${repo}`
  let response
  try {
    response = await client.getStickyDisk({
      stickyDiskKey: stickyDiskKey,
      stickyDiskType: 'git_mirror',
      region: process.env.BLACKSMITH_REGION || '',
      installationModelId: process.env.BLACKSMITH_INSTALLATION_MODEL_ID || '',
      vmId: process.env.BLACKSMITH_VM_ID || '',
      repoName: repoName,
      stickyDiskToken: process.env.BLACKSMITH_STICKYDISK_TOKEN || ''
    })
  } catch (error) {
    // Check if this is a gRPC Aborted error indicating hydration in progress
    if (error instanceof ConnectError && error.code === Code.Aborted) {
      const hydrationMessage =
        error.message || 'Initial mirror clone is running'
      core.warning(
        `[git-mirror] Another job is hydrating the git mirror cache: ${hydrationMessage}`
      )
      core.warning(
        '[git-mirror] Falling back to standard checkout. Cache will be available once hydration completes.'
      )
      return {
        exposeId: '',
        stickyDiskKey,
        repoName,
        device: '',
        mountPoint: '',
        mirrorPath: '',
        hydrationInProgress: true,
        hydrationMessage,
        performedHydration: false
      }
    }
    // Re-throw other errors
    throw error
  }

  const exposeId = (response as {exposeId?: string}).exposeId || ''
  const device = (response as {diskIdentifier?: string}).diskIdentifier || ''

  if (!device) {
    throw new Error('No device found in sticky disk response')
  }

  if (!exposeId) {
    throw new Error('No exposeId found in sticky disk response')
  }

  core.info(
    `[git-mirror] Got sticky disk device: ${device}, exposeId: ${exposeId}`
  )

  // Format if needed
  await maybeFormatDevice(device)

  // Mount the device at a unique path for this repository
  const mountPoint = getMountPoint(owner, repo)
  await exec.exec('sudo', ['mkdir', '-p', mountPoint])
  await exec.exec('sudo', ['mount', device, mountPoint])
  core.info(`[git-mirror] Mounted ${device} at ${mountPoint}`)

  return {
    exposeId,
    stickyDiskKey,
    repoName,
    device,
    mountPoint,
    mirrorPath: getMirrorPath(owner, repo),
    hydrationInProgress: false,
    performedHydration: false // Will be set by ensureMirror if we do initial clone
  }
}

/**
 * Get the extraheader config value for git authentication.
 * Uses the same format as upstream actions/checkout:
 * http.<origin>/.extraheader = AUTHORIZATION: basic <base64(x-access-token:TOKEN)>
 *
 * This is more secure than embedding credentials in the URL because:
 * 1. The header value is not visible in process arguments
 * 2. It follows the same pattern used by the upstream checkout action
 */
function getAuthConfigArgs(
  repoUrl: string,
  authToken: string
): {configKey: string; configValue: string} {
  const url = new URL(repoUrl)
  const origin = url.origin // SCHEME://HOSTNAME[:PORT]
  const basicCredential = Buffer.from(
    `x-access-token:${authToken}`,
    'utf8'
  ).toString('base64')
  core.setSecret(basicCredential)

  return {
    configKey: `http.${origin}/.extraheader`,
    configValue: `AUTHORIZATION: basic ${basicCredential}`
  }
}

/**
 * Build git environment with optional verbose flags
 */
function buildGitEnv(verbose: boolean): {[key: string]: string} {
  const gitEnv: {[key: string]: string} = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      gitEnv[key] = value
    }
  }
  if (verbose) {
    gitEnv['GIT_TRACE'] = '1'
    gitEnv['GIT_CURL_VERBOSE'] = '1'
  }
  return gitEnv
}

/**
 * Ensure a bare git mirror exists. If the mirror doesn't exist, clone it.
 * If the mirror already exists, skip the fetch (it will be updated in the post step).
 *
 * This approach moves the mirror refresh to the post step to avoid step-level timeouts
 * affecting checkout performance. The alternates mechanism allows checkout to work
 * with a stale mirror - missing objects will be fetched from the network.
 *
 * Uses http.extraheader for authentication (same as upstream checkout action).
 *
 * @param mirrorPath - Path to the bare git mirror
 * @param repoUrl - URL of the repository to mirror
 * @param authToken - Authentication token for the repository
 * @param verbose - Enable verbose output with GIT_TRACE and GIT_CURL_VERBOSE
 * @returns true if a new mirror was created (initial hydration), false if mirror already existed
 */
export async function ensureMirror(
  mirrorPath: string,
  repoUrl: string,
  authToken: string,
  verbose: boolean = false
): Promise<boolean> {
  if (fs.existsSync(mirrorPath)) {
    // Mirror exists - skip fetch here, it will be done in the post step
    core.info(
      `[git-mirror] Found existing mirror at ${mirrorPath}, deferring refresh to post step`
    )
    return false // Not initial hydration
  }

  // First time - create a bare mirror clone (initial hydration)
  core.info(
    `[git-mirror] Creating new mirror at ${mirrorPath} (initial hydration)`
  )
  const {configKey, configValue} = getAuthConfigArgs(repoUrl, authToken)
  const gitEnv = buildGitEnv(verbose)

  const mirrorDir = path.dirname(mirrorPath)
  await exec.exec('sudo', ['mkdir', '-p', mirrorDir])
  // Change ownership so git can write to it
  const uid = process.getuid?.() ?? 1000
  const gid = process.getgid?.() ?? 1000
  await exec.exec('sudo', ['chown', '-R', `${uid}:${gid}`, mirrorDir])
  await retryHelper.execute(async () => {
    // Clean up any partial clone from a previous failed attempt
    if (fs.existsSync(mirrorPath)) {
      core.info(
        `[git-mirror] Removing partial mirror directory from failed attempt`
      )
      await fs.promises.rm(mirrorPath, {recursive: true, force: true})
    }
    const cloneArgs = [
      '-c',
      `${configKey}=${configValue}`,
      'clone',
      '--mirror',
      '--progress',
      repoUrl,
      mirrorPath
    ]
    if (verbose) {
      cloneArgs.splice(cloneArgs.indexOf('--progress') + 1, 0, '--verbose')
    }
    await exec.exec('git', cloneArgs, {env: gitEnv})
  })
  core.info('[git-mirror] Initial mirror clone complete')
  return true // Initial hydration performed
}

/**
 * Refresh an existing git mirror by fetching updates from the remote.
 * This is called in the post step to update the mirror for future runs,
 * outside of the critical checkout path.
 *
 * @param mirrorPath - Path to the bare git mirror
 * @param repoUrl - URL of the repository to mirror
 * @param authToken - Authentication token for the repository
 * @param verbose - Enable verbose output with GIT_TRACE and GIT_CURL_VERBOSE
 */
export async function refreshMirror(
  mirrorPath: string,
  repoUrl: string,
  authToken: string,
  verbose: boolean = false,
  timeoutSecs: number = REFRESH_TIMEOUT_SECS
): Promise<OperationResult> {
  if (!fs.existsSync(mirrorPath)) {
    core.debug(
      `[git-mirror] Mirror does not exist at ${mirrorPath}, skipping refresh`
    )
    return {success: true, timedOut: false}
  }

  core.info(
    `[git-mirror] Refreshing mirror at ${mirrorPath} (timeout: ${timeoutSecs}s per attempt)`
  )

  try {
    const {configKey, configValue} = getAuthConfigArgs(repoUrl, authToken)
    const gitEnv = buildGitEnv(verbose)
    await retryHelper.execute(async () => {
      const fetchArgs = [
        '-c',
        `${configKey}=${configValue}`,
        '-C',
        mirrorPath,
        'fetch',
        '--prune',
        '--progress',
        'origin'
      ]
      if (verbose) {
        fetchArgs.splice(fetchArgs.indexOf('origin'), 0, '--verbose')
      }
      const result = await exec.getExecOutput(
        'timeout',
        [String(timeoutSecs), 'git', ...fetchArgs],
        {env: gitEnv, ignoreReturnCode: true}
      )
      if (result.exitCode === TIMEOUT_EXIT_CODE) {
        throw new Error(`git fetch timed out after ${timeoutSecs}s`)
      }
      if (result.exitCode !== 0) {
        throw new Error(`git fetch failed with exit code ${result.exitCode}`)
      }
    })
    core.info('[git-mirror] Mirror refresh complete')
    return {success: true, timedOut: false}
  } catch (error) {
    const msg = (error as Error).message || String(error)
    const timedOut = msg.includes('timed out')
    if (timedOut) {
      core.warning(`[git-mirror] Mirror refresh timed out: ${msg}`)
    } else {
      core.warning(`[git-mirror] Mirror refresh failed: ${msg}`)
    }
    return {success: false, timedOut, error: msg}
  }
}

/**
 * Write the alternates file to enable object sharing from the mirror
 * This allows the workspace git repo to use objects from the mirror
 * without copying them
 */
export async function writeAlternates(
  workspacePath: string,
  mirrorPath: string
): Promise<void> {
  const alternatesDir = path.join(workspacePath, '.git', 'objects', 'info')
  const alternatesFile = path.join(alternatesDir, 'alternates')

  await fs.promises.mkdir(alternatesDir, {recursive: true})
  await fs.promises.writeFile(alternatesFile, `${mirrorPath}/objects\n`)
  core.debug(`Wrote alternates file pointing to ${mirrorPath}/objects`)
}

/**
 * Dissociate the repository from the mirror by copying all objects locally
 * This is needed for Docker-based actions that may not have access to the mirror mount
 */
export async function dissociate(workspacePath: string): Promise<void> {
  core.info('Dissociating repository from mirror')

  // Copy all objects from alternates into local repo
  await exec.exec('git', ['-C', workspacePath, 'repack', '-a', '-d'])

  // Remove alternates file
  const alternatesFile = path.join(
    workspacePath,
    '.git',
    'objects',
    'info',
    'alternates'
  )
  try {
    await fs.promises.unlink(alternatesFile)
    core.debug('Removed alternates file')
  } catch {
    // File may not exist, that's fine
  }
}

/**
 * Run lightweight garbage collection on the mirror.
 * Uses --auto to only run GC when git determines it's needed (based on loose object count).
 * This avoids expensive full repacks on every run while still keeping the repo tidy over time.
 */
async function runMirrorGC(
  mirrorPath: string,
  timeoutSecs: number = GC_TIMEOUT_SECS
): Promise<OperationResult> {
  core.info(
    `[git-mirror] Running auto garbage collection (timeout: ${timeoutSecs}s)`
  )

  try {
    // --auto: only run if thresholds exceeded (default: 6700 loose objects or 50 packs)
    // This is much faster than a full gc when not needed
    const result = await exec.getExecOutput(
      'timeout',
      [String(timeoutSecs), 'git', '-C', mirrorPath, 'gc', '--auto'],
      {ignoreReturnCode: true}
    )
    if (result.exitCode === TIMEOUT_EXIT_CODE) {
      core.warning(`[git-mirror] GC timed out after ${timeoutSecs}s`)
      return {
        success: false,
        timedOut: true,
        error: `git gc timed out after ${timeoutSecs}s`
      }
    }
    if (result.exitCode !== 0) {
      core.warning(`[git-mirror] GC failed with exit code ${result.exitCode}`)
      return {
        success: false,
        timedOut: false,
        error: `git gc failed with exit code ${result.exitCode}`
      }
    }
    core.debug('[git-mirror] Completed git gc --auto')
    return {success: true, timedOut: false}
  } catch (error) {
    const msg = (error as Error).message || String(error)
    core.warning(`[git-mirror] GC failed: ${msg}`)
    return {success: false, timedOut: false, error: msg}
  }
}

/**
 * Run git fsck on the mirror to verify object integrity.
 * This is the final integrity gate before committing the sticky disk.
 * --no-dangling: skip reporting dangling objects (expected in a mirror with pruned refs)
 * --no-progress: suppress progress output for cleaner logs
 */
async function runMirrorFsck(
  mirrorPath: string,
  timeoutSecs: number = FSCK_TIMEOUT_SECS
): Promise<OperationResult> {
  core.info(
    `[git-mirror] Running fsck integrity check (timeout: ${timeoutSecs}s)`
  )

  try {
    const result = await exec.getExecOutput(
      'timeout',
      [
        String(timeoutSecs),
        'git',
        '-C',
        mirrorPath,
        'fsck',
        '--no-dangling',
        '--no-progress'
      ],
      {ignoreReturnCode: true}
    )
    if (result.exitCode === TIMEOUT_EXIT_CODE) {
      core.warning(`[git-mirror] Fsck timed out after ${timeoutSecs}s`)
      return {
        success: false,
        timedOut: true,
        error: `git fsck timed out after ${timeoutSecs}s`
      }
    }
    if (result.exitCode !== 0) {
      core.warning(`[git-mirror] Fsck failed with exit code ${result.exitCode}`)
      return {
        success: false,
        timedOut: false,
        error: `git fsck failed with exit code ${result.exitCode}`
      }
    }
    core.info('[git-mirror] Fsck passed — mirror integrity verified')
    return {success: true, timedOut: false}
  } catch (error) {
    const msg = (error as Error).message || String(error)
    core.warning(`[git-mirror] Fsck failed: ${msg}`)
    return {success: false, timedOut: false, error: msg}
  }
}

export interface CleanupOptions {
  exposeId: string
  stickyDiskKey: string
  repoName?: string
  mountPoint?: string
  mirrorPath?: string
  // shouldCommit indicates whether changes should be persisted.
  // Set to false if the job failed/was cancelled to avoid committing bad state.
  shouldCommit: boolean
  // vmHydratedGitMirror indicates this job performed initial git mirror clone.
  // Used by backend to mark hydration as complete.
  vmHydratedGitMirror: boolean
  // Mirror refresh outcome from the post step (run before cleanup is called).
  mirrorRefreshFailed?: boolean
  mirrorRefreshTimedOut?: boolean
}

/**
 * Cleanup: run GC, fsck, sync, unmount, and commit the sticky disk.
 *
 * Execution order: GC → fsck → sync → unmount → commit
 * Fsck runs last (before unmount) as the final integrity gate.
 * If any of mirror refresh / GC / fsck fail or time out, shouldCommit is set to false.
 */
export async function cleanup(options: CleanupOptions): Promise<CleanupResult> {
  const {
    exposeId,
    stickyDiskKey,
    repoName,
    mountPoint,
    mirrorPath,
    vmHydratedGitMirror,
    mirrorRefreshFailed,
    mirrorRefreshTimedOut
  } = options
  let {shouldCommit} = options

  const result: CleanupResult = {
    gcResult: {success: true, timedOut: false},
    fsckResult: {success: true, timedOut: false}
  }

  core.info(
    `[git-mirror] Starting cleanup: exposeId=${exposeId}, stickyDiskKey=${stickyDiskKey}, shouldCommit=${shouldCommit}, vmHydratedGitMirror=${vmHydratedGitMirror}`
  )

  // If mirror refresh failed or timed out, don't commit
  if (mirrorRefreshFailed || mirrorRefreshTimedOut) {
    const reason = mirrorRefreshTimedOut ? 'timed out' : 'failed'
    core.warning(
      `[git-mirror] Mirror refresh ${reason}, will not commit sticky disk`
    )
    shouldCommit = false
  }

  if (mirrorPath) {
    // Run GC on the mirror before fsck
    result.gcResult = await runMirrorGC(mirrorPath)
    if (!result.gcResult.success) {
      core.warning(
        '[git-mirror] GC failed or timed out, will not commit sticky disk'
      )
      shouldCommit = false
    }

    // Run fsck as final integrity gate
    result.fsckResult = await runMirrorFsck(mirrorPath)
    if (!result.fsckResult.success) {
      core.warning(
        '[git-mirror] Fsck failed or timed out, will not commit sticky disk'
      )
      shouldCommit = false
    }
  }

  // Sync filesystem before unmount to ensure all writes are flushed
  core.debug('[git-mirror] Syncing filesystem before unmount')
  try {
    await exec.exec('sync')
  } catch {
    core.warning('[git-mirror] Failed to sync filesystem')
  }

  // Unmount the sticky disk
  if (mountPoint) {
    core.debug(`[git-mirror] Unmounting ${mountPoint}`)
    try {
      await exec.exec('sudo', ['umount', mountPoint])
    } catch {
      core.warning(`[git-mirror] Failed to unmount ${mountPoint}`)
    }
  }

  // Commit the sticky disk to persist changes
  core.info(
    `[git-mirror] Committing sticky disk: shouldCommit=${shouldCommit}, vmHydratedGitMirror=${vmHydratedGitMirror}`
  )
  const client = createBlacksmithClient()

  await client.commitStickyDisk({
    exposeId: exposeId,
    stickyDiskKey: stickyDiskKey,
    vmId: process.env.BLACKSMITH_VM_ID || '',
    shouldCommit: shouldCommit,
    repoName: repoName || process.env.GITHUB_REPO_NAME || '',
    stickyDiskToken: process.env.BLACKSMITH_STICKYDISK_TOKEN || '',
    vmHydratedGitMirror: vmHydratedGitMirror
  })

  core.info('[git-mirror] Successfully committed sticky disk')
  return result
}
