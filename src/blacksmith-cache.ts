import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {createClient, ConnectError, Code} from '@connectrpc/connect'
import {createGrpcTransport} from '@connectrpc/connect-node'
import {StickyDiskService} from '@buf/blacksmith_vm-agent.connectrpc_es/stickydisk/v1/stickydisk_connect'
import * as retryHelper from './retry-helper'
import {isRunningInContainer} from './container-detector'

// Without a deadline, a black-holed dial stalls the checkout until the OS
// gives up on the TCP handshake.
const AGENT_RPC_TIMEOUT_MS = 45000
const MOUNT_BASE = '/blacksmith-git-mirror'
const MIRROR_VERSION = 'v1'

// A sync that doesn't finish within this window is abandoned (single
// attempt, no retries): sync failure is soft - the workspace is populated
// from the mirror's last good state plus a targeted fetch of the job's own
// ref - and the next job on the mirror picks the refs up. Healthy syncs
// finish in seconds even on large repositories, so waiting longer mostly
// burns checkout time on a mirror disk that is having a bad day. The
// window is kept generous so slow-but-healthy syncs still complete.
const REFRESH_TIMEOUT_SECS = 120 // 2 minutes, single attempt
const GC_TIMEOUT_SECS = 120 // 2 minutes
const FLUSH_TIMEOUT_SECS = 10 // 10 seconds for durability flush
const UMOUNT_TIMEOUT_SECS = 10 // 10 seconds for unmount
const UMOUNT_MAX_RETRIES = 3 // Number of unmount retry attempts
const UMOUNT_INITIAL_DELAY_MS = 1000 // Initial delay between retries (1 second)
const UMOUNT_BACKOFF_MULTIPLIER = 2 // Exponential backoff multiplier

// Exit code returned by the `timeout` command when the child is killed.
const TIMEOUT_EXIT_CODE = 124

// Cap on --negotiation-tip arguments passed to the mirror sync fetch, to
// bound the command line length when many refs changed at once.
const MAX_NEGOTIATION_TIPS = 1000

// Maximum number of times a mirror sync fetch is re-run after pruning refs
// that were deleted on the remote between ls-remote and fetch.
const MAX_VANISHED_REF_RETRIES = 5

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

export function getAgentAddr(): string | undefined {
  return process.env.BLACKSMITH_AGENT_ADDR || undefined
}

export function getGrpcPort(): string | undefined {
  return process.env.BLACKSMITH_STICKY_DISK_GRPC_PORT || undefined
}

/**
 * Escape hatch for container jobs that deliberately pass the runner's
 * block devices through to the container (e.g. `options:
 * --privileged -v /dev:/dev`). Enabled via the `allow-inside-container`
 * action input or the BLACKSMITH_ALLOW_INSIDE_CONTAINER environment
 * variable. When enabled, the container guard in shouldUseBlacksmithCache()
 * is skipped and the action attempts normal sticky-disk device detection; if
 * the device is unavailable, setup fails and the checkout falls back to
 * standard behavior.
 */
export function isAllowedInsideContainer(): boolean {
  return (
    (core.getInput('allow-inside-container') || '').toUpperCase() === 'TRUE' ||
    (process.env.BLACKSMITH_ALLOW_INSIDE_CONTAINER || '').toUpperCase() ===
      'TRUE'
  )
}

/**
 * Control plane short circuit: when an installation has the
 * `bypass_blacksmith_checkout` flag flipped on, the agent exports
 * BLACKSMITH_BYPASS_CHECKOUT=true into the runner environment. We
 * use that as a kill switch to skip every Blacksmith-specific code path
 * (mirror cache setup, alternates, dissociate, post-step commit). The
 * action then behaves identically to upstream actions/checkout.
 */
export function shouldUseBlacksmithCache(): boolean {
  if (!isBlacksmithEnvironment()) {
    return false
  }
  if (!getAgentAddr() || !getGrpcPort()) {
    core.info(
      '[blacksmith] BLACKSMITH_AGENT_ADDR or BLACKSMITH_STICKY_DISK_GRPC_PORT is not set; the Blacksmith agent is not reachable from this runner, falling back to actions/checkout behavior'
    )
    return false
  }
  if (process.env.BLACKSMITH_BYPASS_CHECKOUT === 'true') {
    core.info(
      '[blacksmith] BLACKSMITH_BYPASS_CHECKOUT=true — skipping Blacksmith git mirror cache and falling back to actions/checkout behavior'
    )
    return false
  }
  // Container jobs cannot mount the sticky disk block device (it is only
  // visible to the runner VM, not inside the container), so skip the git
  // mirror cache entirely before requesting a sticky disk. Requesting one
  // and failing would leave the git mirror hydration lock held, causing
  // spurious 409s for concurrent jobs on the same repository.
  if (isRunningInContainer()) {
    if (isAllowedInsideContainer()) {
      core.info(
        '[blacksmith] Running inside a container but allow-inside-container is enabled — attempting git mirror sticky disk setup'
      )
    } else {
      core.info(
        '[blacksmith] Running inside a container — the git mirror sticky disk cannot be mounted here, falling back to actions/checkout behavior. Set allow-inside-container: true to opt in if the container has the runner devices passed through (e.g. --privileged -v /dev:/dev).'
      )
      return false
    }
  }
  return true
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
  const addr = getAgentAddr()
  const grpcPort = getGrpcPort()
  if (!addr || !grpcPort) {
    throw new Error(
      'BLACKSMITH_AGENT_ADDR or BLACKSMITH_STICKY_DISK_GRPC_PORT is not set; cannot dial the Blacksmith agent'
    )
  }
  core.debug(`Creating Blacksmith agent client for ${addr}:${grpcPort}`)
  const transport = createGrpcTransport({
    baseUrl: `http://${addr}:${grpcPort}`,
    httpVersion: '2'
  })

  return createClient(StickyDiskService, transport)
}

/**
 * The VM agent's sticky-disk response can arrive before the guest kernel has
 * processed the virtio config-change interrupt that publishes the drive's real
 * capacity (the drive is hot-attached/hydrated in place), so the device can
 * transiently report a size of zero. Wait for a non-zero size before touching
 * the device.
 */
async function waitForNonZeroDeviceSize(
  device: string,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const result = await exec.getExecOutput(
      'sudo',
      ['blockdev', '--getsize64', device],
      {ignoreReturnCode: true, silent: true}
    )
    if (result.exitCode === 0) {
      const size = parseInt(result.stdout.trim(), 10)
      if (!isNaN(size) && size > 0) {
        return
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Device ${device} still reports zero size after ${timeoutMs}ms`
      )
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
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

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), AGENT_RPC_TIMEOUT_MS)

  // Rethrow the original error so callers can classify it from the gRPC code.
  core.info(`[git-mirror] Connecting to Blacksmith agent for ${stickyDiskKey}`)
  try {
    await client.up({}, {signal: controller.signal})
    core.debug('[git-mirror] Successfully connected to Blacksmith agent')
  } catch (error) {
    clearTimeout(timeoutId)
    core.warning(
      `[git-mirror] gRPC connection test failed: ${(error as Error).message}`
    )
    throw error
  }

  core.info(`[git-mirror] Requesting sticky disk for ${stickyDiskKey}`)

  // Request sticky disk from VM agent
  // Use the actual repo being checked out (owner/repo), not GITHUB_REPO_NAME
  // This ensures each repo gets its own isolated sticky disk
  const repoName = `${owner}/${repo}`
  let response
  try {
    response = await client.getStickyDisk(
      {
        stickyDiskKey: stickyDiskKey,
        stickyDiskType: 'git_mirror',
        region: process.env.BLACKSMITH_REGION || '',
        installationModelId: process.env.BLACKSMITH_INSTALLATION_MODEL_ID || '',
        vmId: process.env.BLACKSMITH_VM_ID || '',
        repoName: repoName,
        stickyDiskToken: process.env.BLACKSMITH_STICKYDISK_TOKEN || ''
      },
      {signal: controller.signal}
    )
  } catch (error) {
    // Check if this is a gRPC Aborted error indicating hydration in progress
    if (error instanceof ConnectError && error.code === Code.Aborted) {
      const hydrationMessage =
        error.message || 'Initial mirror clone is running'
      core.warning(
        `[git-mirror] Another job is hydrating the git mirror cache: ${hydrationMessage}`
      )
      core.warning(
        '[git-mirror] No sticky disk will be mounted for this run; checkout will clone directly from GitHub onto the runner disk (no mirror cache). The mirror cache will be available on subsequent runs once hydration completes.'
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
  } finally {
    clearTimeout(timeoutId)
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
  await waitForNonZeroDeviceSize(device, 10000)
  await maybeFormatDevice(device)

  // Mount the device at a unique path for this repository
  const mountPoint = getMountPoint(owner, repo)
  await exec.exec('sudo', ['mkdir', '-p', mountPoint])
  // noinit_itable stops the background zeroing of a non-trivial portion of
  // the device (uninitialized inode tables), which is unnecessary here.
  await exec.exec('sudo', ['mount', '-o', 'noinit_itable', device, mountPoint])
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
function buildGitEnv(
  verbose: boolean,
  trace2PerfPath?: string
): {[key: string]: string} {
  const gitEnv: {[key: string]: string} = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      gitEnv[key] = value
    }
  }
  if (verbose) {
    gitEnv['GIT_TRACE'] = '1'
    gitEnv['GIT_CURL_VERBOSE'] = '1'
    if (trace2PerfPath) {
      gitEnv['GIT_TRACE2_PERF'] = trace2PerfPath
    }
  }
  return gitEnv
}

function newTrace2PerfPath(label: string): string {
  return path.join(
    os.tmpdir(),
    `blacksmith-git-trace2-${label}-${Date.now()}-${process.pid}`
  )
}

/**
 * Print the slowest trace2 perf regions recorded at trace2PerfPath, so
 * verbose runs show where time went inside a git command (ref advertisement,
 * negotiation, pack transfer, ...) without users having to parse raw trace2
 * output.
 */
function summarizeTrace2Perf(trace2PerfPath: string, title: string): void {
  try {
    if (!fs.existsSync(trace2PerfPath)) {
      return
    }
    const regions: {duration: number; label: string}[] = []
    for (const line of fs.readFileSync(trace2PerfPath, 'utf8').split('\n')) {
      if (!line.includes('region_leave')) {
        continue
      }
      const cols = line.split('|').map(col => col.trim())
      if (cols.length < 3) {
        continue
      }
      const duration = parseFloat(cols[cols.length - 3])
      const label = cols[cols.length - 1]
      if (!isNaN(duration) && label) {
        regions.push({duration, label})
      }
    }
    regions.sort((a, b) => b.duration - a.duration)
    core.info(`[git-mirror] trace2 slowest regions (${title}):`)
    for (const region of regions.slice(0, 12)) {
      core.info(`[git-mirror]   ${region.duration.toFixed(6)}  ${region.label}`)
    }
  } catch (error) {
    core.debug(
      `[git-mirror] Failed to summarize trace2 output: ${(error as Error).message}`
    )
  } finally {
    fs.rmSync(trace2PerfPath, {force: true})
  }
}

/**
 * Ensure a bare git mirror exists. If the mirror doesn't exist, clone it.
 * If the mirror already exists, it is left as-is; the caller brings it up to
 * date with syncMirrorFromRemote(), which only pays for refs that actually
 * changed. The alternates mechanism allows checkout to work with the mirror
 * - any objects it lacks are fetched from the network.
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
    // Mirror exists - the caller synchronizes it with the remote via
    // syncMirrorFromRemote() before populating the workspace from it
    core.info(`[git-mirror] Found existing mirror at ${mirrorPath}`)
    return false // Not initial hydration
  }

  // First time - create a bare mirror clone (initial hydration)
  core.info(
    `[git-mirror] Creating new mirror at ${mirrorPath} (initial hydration)`
  )
  const {configKey, configValue} = getAuthConfigArgs(repoUrl, authToken)
  const trace2PerfPath = verbose ? newTrace2PerfPath('clone') : undefined
  const gitEnv = buildGitEnv(verbose, trace2PerfPath)

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
    // gc.auto=0: disable auto-gc during clone (see comment in syncMirrorFromRemote)
    const cloneArgs = [
      '-c',
      `${configKey}=${configValue}`,
      '-c',
      'gc.auto=0',
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
  // `clone --mirror` brings in every advertised ref, including refs/pull/*,
  // which are never synchronized afterwards. Drop them so the mirror starts
  // with only the refs it maintains.
  await purgePullRefs(mirrorPath)
  await writeCommitGraph(mirrorPath)
  if (trace2PerfPath) {
    summarizeTrace2Perf(trace2PerfPath, 'initial mirror clone')
  }
  return true // Initial hydration performed
}

/**
 * Result of synchronizing the mirror with the remote.
 */
export interface MirrorSyncResult extends OperationResult {
  // changed indicates the mirror's refs/objects were modified by the sync.
  // When false, the mirror was already up to date and the sticky disk does
  // not need to be committed.
  changed: boolean
}

interface RefDiff {
  updatedRefSpecs: string[]
  deletedRefs: string[]
  remoteRefCount: number
  // Old local tips of the refs being updated, used as --negotiation-tip
  // arguments so git only reports commits reachable from these tips instead
  // of walking every local ref (mark_complete_local_refs is O(all refs) in
  // cold-cache pack reads otherwise).
  negotiationTips: string[]
}

/**
 * Compute the difference between the remote's advertised branch/tag tips
 * and the mirror's local refs.
 *
 * @param lsRemoteOutput - stdout of `git ls-remote --heads --tags origin`
 * @param localRefsOutput - stdout of `git for-each-ref --format='%(objectname) %(refname)' refs/heads refs/tags`
 */
export function diffMirrorRefs(
  lsRemoteOutput: string,
  localRefsOutput: string
): RefDiff {
  const remoteRefs = new Map<string, string>()
  for (const line of lsRemoteOutput.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }
    const [sha, refName] = trimmed.split('\t')
    if (!sha || !refName) {
      continue
    }
    // Skip peeled annotated tag entries (refs/tags/v1^{}); the tag ref
    // itself is advertised separately and is what the mirror stores.
    if (refName.endsWith('^{}')) {
      continue
    }
    remoteRefs.set(refName, sha)
  }

  const localRefs = new Map<string, string>()
  for (const line of localRefsOutput.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }
    const spaceIdx = trimmed.indexOf(' ')
    if (spaceIdx <= 0) {
      continue
    }
    const sha = trimmed.substring(0, spaceIdx)
    const refName = trimmed.substring(spaceIdx + 1)
    localRefs.set(refName, sha)
  }

  const updatedRefSpecs: string[] = []
  const negotiationTips: string[] = []
  for (const [refName, sha] of remoteRefs) {
    const localSha = localRefs.get(refName)
    if (localSha !== sha) {
      updatedRefSpecs.push(`+${refName}:${refName}`)
      if (localSha) {
        negotiationTips.push(localSha)
      }
    }
  }
  if (negotiationTips.length === 0) {
    // Every changed ref is new locally; negotiate from the default branch
    // tip so the server still learns about the bulk of shared history.
    const fallback =
      localRefs.get('refs/heads/main') ?? localRefs.get('refs/heads/master')
    if (fallback) {
      negotiationTips.push(fallback)
    }
  }

  const deletedRefs: string[] = []
  for (const refName of localRefs.keys()) {
    if (!remoteRefs.has(refName)) {
      deletedRefs.push(refName)
    }
  }

  return {
    updatedRefSpecs,
    deletedRefs,
    remoteRefCount: remoteRefs.size,
    negotiationTips
  }
}

/**
 * Delete all refs/pull/* from the mirror. Pull refs are no longer
 * synchronized (a job that needs one fetches it directly into its
 * workspace), but mirrors created before that change still carry a ref for
 * every pull request ever opened - often several times more refs than live
 * branches and tags. Every ref in the mirror has a cost: git's fetch
 * machinery walks all local refs (mark_complete_local_refs), and the ref
 * advertisement and packed-refs scans grow with the total count.
 *
 * Deleting only touches the ref database (one packed-refs rewrite plus
 * loose ref unlinks) - no object access - and is a no-op on mirrors that
 * have no pull refs left.
 *
 * @returns the number of refs deleted
 */
export async function purgePullRefs(mirrorPath: string): Promise<number> {
  try {
    const pullRefs = await exec.getExecOutput(
      'git',
      ['-C', mirrorPath, 'for-each-ref', '--format=%(refname)', 'refs/pull'],
      {silent: true}
    )
    const refs = pullRefs.stdout
      .split('\n')
      .map(line => line.trim())
      .filter(ref => ref.length > 0)
    if (refs.length === 0) {
      return 0
    }
    const start = Date.now()
    await exec.exec('git', ['-C', mirrorPath, 'update-ref', '--stdin'], {
      silent: true,
      input: Buffer.from(refs.map(ref => `delete ${ref}\n`).join(''))
    })
    core.info(
      `[git-mirror] Purged ${refs.length} refs/pull/* refs from the mirror in ${Date.now() - start}ms`
    )
    return refs.length
  } catch (error) {
    // The purge is an optimization on an already-valid mirror; never let it
    // fail the operation that invoked it (e.g. discard a completed clone).
    core.warning(`[git-mirror] refs/pull/* purge failed: ${error}`)
    return 0
  }
}

/**
 * Synchronize the mirror with the remote before the workspace is populated
 * from it. Instead of a full `git fetch --prune origin` (whose cost is
 * proportional to the total ref count even when nothing changed), this:
 *
 * 1. Runs `git ls-remote --heads --tags origin` - a single request that
 *    returns the current tip of every branch/tag with no negotiation and no
 *    object transfer.
 * 2. Diffs those tips against the mirror's local refs.
 * 3. Fetches only the changed refs (usually zero or a handful) and deletes
 *    refs that no longer exist on the remote.
 *
 * After a successful sync the mirror's branch/tag refs exactly match the
 * remote at ls-remote time, so the workspace can be populated from the
 * mirror with the same freshness guarantee as a direct network fetch.
 *
 * refs/pull/* are not synchronized: a job that needs a pull ref fetches it
 * directly into its workspace, and pull refs would otherwise dominate the
 * advertisement size on busy repositories. Any refs/pull/* still present in
 * the mirror from before this change are purged (see purgePullRefs).
 *
 * @param mirrorPath - Path to the bare git mirror
 * @param repoUrl - URL of the repository to mirror
 * @param authToken - Authentication token for the repository
 * @param verbose - Enable verbose output with GIT_TRACE and GIT_CURL_VERBOSE
 */
/**
 * Parse the refs git reports as missing from a fetch's stderr. When a ref is
 * deleted on the remote between our ls-remote and the fetch, git fails with
 * `fatal: couldn't find remote ref <ref>`.
 */
export function parseMissingRemoteRefs(stderr: string): string[] {
  const refs: string[] = []
  const re = /couldn't find remote ref (\S+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(stderr)) !== null) {
    refs.push(match[1])
  }
  return refs
}

export async function syncMirrorFromRemote(
  mirrorPath: string,
  repoUrl: string,
  authToken: string,
  verbose: boolean = false,
  timeoutSecs: number = REFRESH_TIMEOUT_SECS
): Promise<MirrorSyncResult> {
  if (!fs.existsSync(mirrorPath)) {
    core.debug(
      `[git-mirror] Mirror does not exist at ${mirrorPath}, skipping sync`
    )
    return {success: true, timedOut: false, changed: false}
  }

  core.info(
    `[git-mirror] Syncing mirror at ${mirrorPath} with remote (budget: ${timeoutSecs}s)`
  )

  // One deadline bounds the whole sync: ls-remote and every fetch
  // invocation (including vanished-ref reruns) draw from the same budget,
  // so the sync's worst case is timeoutSecs regardless of how many
  // subprocesses run.
  const deadline = Date.now() + timeoutSecs * 1000
  const remainingSecs = (): number => {
    const remaining = Math.ceil((deadline - Date.now()) / 1000)
    if (remaining <= 0) {
      throw new Error(`mirror sync timed out after ${timeoutSecs}s`)
    }
    return remaining
  }

  try {
    const {configKey, configValue} = getAuthConfigArgs(repoUrl, authToken)
    const trace2PerfPath = verbose ? newTrace2PerfPath('sync') : undefined
    const gitEnv = buildGitEnv(verbose, trace2PerfPath)

    const lsRemoteStart = Date.now()
    const lsRemoteResult = await exec.getExecOutput(
      'timeout',
      [
        String(remainingSecs()),
        'git',
        '-c',
        `${configKey}=${configValue}`,
        '-C',
        mirrorPath,
        'ls-remote',
        '--heads',
        '--tags',
        'origin'
      ],
      {env: gitEnv, ignoreReturnCode: true, silent: true}
    )
    if (lsRemoteResult.exitCode === TIMEOUT_EXIT_CODE) {
      throw new Error(`git ls-remote timed out (budget ${timeoutSecs}s)`)
    }
    if (lsRemoteResult.exitCode !== 0) {
      const stderr = lsRemoteResult.stderr.trim()
      const details = stderr ? `: ${stderr}` : ''
      throw new Error(
        `git ls-remote failed with exit code ${lsRemoteResult.exitCode}${details}`
      )
    }
    const lsRemoteOutput = lsRemoteResult.stdout

    const localRefsResult = await exec.getExecOutput(
      'git',
      [
        '-C',
        mirrorPath,
        'for-each-ref',
        '--format=%(objectname) %(refname)',
        'refs/heads',
        'refs/tags'
      ],
      {silent: true}
    )

    const diff = diffMirrorRefs(lsRemoteOutput, localRefsResult.stdout)
    core.info(
      `[git-mirror] ls-remote finished in ${Date.now() - lsRemoteStart}ms: ${diff.remoteRefCount} remote refs, ${diff.updatedRefSpecs.length} changed, ${diff.deletedRefs.length} deleted`
    )

    // Purge legacy refs/pull/* before fetching so the fetch's local ref
    // walk no longer covers them. A purge is a real mirror change that
    // must be committed even when the branch/tag refs are already current.
    const purgedRefs = await purgePullRefs(mirrorPath)

    if (diff.updatedRefSpecs.length === 0 && diff.deletedRefs.length === 0) {
      core.info('[git-mirror] Mirror is already up to date with the remote')
      return {success: true, timedOut: false, changed: purgedRefs > 0}
    }

    // Refs deleted on the remote between ls-remote and the fetch make git
    // fail with "couldn't find remote ref". Prune those refs and re-run the
    // fetch so one vanished ref doesn't abort the whole sync.
    let refSpecs = diff.updatedRefSpecs
    const vanishedRefs: string[] = []

    if (refSpecs.length > 0) {
      const fetchStart = Date.now()
      {
        // gc.auto=0: disable git's internal auto-gc that porcelain commands
        // like fetch run after completing. Without this, fetch can spawn a
        // background gc daemon (gc.autoDetach defaults to true) that holds
        // cwd + mmap'd pack files on the mirror mount, causing the
        // subsequent umount to fail with EBUSY. We run gc explicitly in
        // runMirrorGC() with gc.autoDetach=false.
        // --stdin: refspecs are passed on stdin to avoid command line length
        // limits when many refs changed.
        const fetchArgs = [
          '-c',
          `${configKey}=${configValue}`,
          '-c',
          'gc.auto=0',
          '-c',
          'fetch.negotiationAlgorithm=skipping',
          // Keep the commit-graph current so ref-tip commit parsing
          // (mark_complete_local_refs and negotiation walks) reads one
          // compact mmap'd file instead of scattered pack entries. Only
          // enabled when a graph already exists: then the write is
          // incremental (split chains), proportional to the commits just
          // fetched. When no graph exists yet the write would be a full
          // reachable walk that could blow the fetch timeout, so the
          // initial graph is written outside the fetch instead (after the
          // clone, or by the post-step catch-up for pre-existing mirrors).
          ...(hasCommitGraph(mirrorPath)
            ? ['-c', 'fetch.writeCommitGraph=true']
            : []),
          '-C',
          mirrorPath,
          'fetch',
          '--no-tags',
          '--stdin',
          // Restrict negotiation to the changed refs' old tips. Without
          // this, git's mark_complete_local_refs walks every local ref and
          // parses each tip commit out of the pack - tens of seconds of
          // random reads on a large mirror when the sticky disk's pages are
          // cold.
          ...diff.negotiationTips
            .slice(0, MAX_NEGOTIATION_TIPS)
            .map(tip => `--negotiation-tip=${tip}`),
          'origin'
        ]
        if (verbose) {
          fetchArgs.splice(
            fetchArgs.indexOf('origin'),
            0,
            '--progress',
            '--verbose'
          )
        }
        for (
          let vanishedRetry = 0;
          vanishedRetry <= MAX_VANISHED_REF_RETRIES;
          vanishedRetry++
        ) {
          if (refSpecs.length === 0) {
            break
          }
          const result = await exec.getExecOutput(
            'timeout',
            [String(remainingSecs()), 'git', ...fetchArgs],
            {
              env: gitEnv,
              ignoreReturnCode: true,
              silent: !verbose,
              input: Buffer.from(`${refSpecs.join('\n')}\n`)
            }
          )
          if (result.exitCode === TIMEOUT_EXIT_CODE) {
            throw new Error(`git fetch timed out (budget ${timeoutSecs}s)`)
          }
          if (result.exitCode === 0) {
            break
          }
          // Include stderr in error message so failure details are visible even when silent
          const stderr = result.stderr.trim()
          const missingRefs = parseMissingRemoteRefs(stderr)
          if (
            missingRefs.length > 0 &&
            vanishedRetry < MAX_VANISHED_REF_RETRIES
          ) {
            const missingSet = new Set(missingRefs)
            refSpecs = refSpecs.filter(
              spec => !missingSet.has(spec.slice(1).split(':')[0])
            )
            vanishedRefs.push(...missingRefs)
            core.info(
              `[git-mirror] ${missingRefs.length} ref(s) deleted on the remote mid-sync (${missingRefs.join(', ')}), retrying fetch without them`
            )
            continue
          }
          const details = stderr ? `: ${stderr}` : ''
          throw new Error(
            `git fetch failed with exit code ${result.exitCode}${details}`
          )
        }
      }
      core.info(
        `[git-mirror] Fetched ${refSpecs.length} changed refs in ${Date.now() - fetchStart}ms`
      )
      if (trace2PerfPath) {
        summarizeTrace2Perf(trace2PerfPath, 'mirror sync')
      }
    }

    // Refs that vanished mid-sync are deleted locally like any other
    // remotely-deleted ref, but only if they exist in the mirror (a vanished
    // ref may have been brand new and never fetched).
    const localRefNames = new Set(
      localRefsResult.stdout
        .split('\n')
        .map(line => line.trim().split(' ')[1])
        .filter(Boolean)
    )
    const refsToDelete = [
      ...diff.deletedRefs,
      ...vanishedRefs.filter(ref => localRefNames.has(ref))
    ]
    if (refsToDelete.length > 0) {
      await exec.getExecOutput(
        'git',
        ['-C', mirrorPath, 'update-ref', '--stdin'],
        {
          silent: true,
          input: Buffer.from(
            refsToDelete.map(ref => `delete ${ref}\n`).join('')
          )
        }
      )
      core.info(
        `[git-mirror] Deleted ${refsToDelete.length} refs removed on the remote`
      )
    }

    core.info('[git-mirror] Mirror sync complete')
    return {success: true, timedOut: false, changed: true}
  } catch (error) {
    const msg = (error as Error).message || String(error)
    const timedOut = msg.includes('timed out')
    if (timedOut) {
      core.warning(`[git-mirror] Mirror sync timed out: ${msg}`)
    } else {
      core.warning(`[git-mirror] Mirror sync failed: ${msg}`)
    }
    return {success: false, timedOut, error: msg, changed: false}
  }
}

/**
 * Map a mirror ref name to the workspace ref it should be copied to:
 * branches become remote-tracking refs, tags stay tags. Returns null for
 * refs that are not copied into the workspace (e.g. refs/pull).
 */
export function mapMirrorRefToWorkspace(ref: string): string | null {
  if (ref.startsWith('refs/heads/')) {
    return `refs/remotes/origin/${ref.slice('refs/heads/'.length)}`
  }
  if (ref.startsWith('refs/tags/')) {
    return ref
  }
  return null
}

/**
 * Build the `git update-ref --stdin` instructions that make the workspace's
 * refs/remotes/origin/* and refs/tags/* exactly mirror the mirror's
 * refs/heads/* and refs/tags/*. The mirror input is `for-each-ref` output in
 * '<objectname> <refname>' format; the workspace input additionally carries
 * a third '%(symref)' column. Workspace refs not present in the mirror
 * are deleted (the equivalent of `fetch --prune`); refs whose value differs
 * are set unconditionally (the equivalent of a `+` force refspec); refs
 * already at the right value are skipped, because update-ref verifies the
 * object of every ref it writes and those reads are expensive on a cold
 * mirror.
 *
 * Symbolic refs (notably refs/remotes/origin/HEAD) are left untouched:
 * update-ref would dereference a `delete` through the symref and delete the
 * branch it points at instead. `git fetch --prune` also preserves
 * origin/HEAD.
 */
export function buildRefCopyInstructions(
  mirrorRefs: string,
  workspaceRefs: string
): string[] {
  const desired = new Map<string, string>()
  for (const line of mirrorRefs.split('\n')) {
    const [sha, ref] = line.trim().split(' ')
    if (!sha || !ref) {
      continue
    }
    const target = mapMirrorRefToWorkspace(ref)
    if (target) {
      desired.set(target, sha)
    }
  }

  const instructions: string[] = []
  for (const line of workspaceRefs.split('\n')) {
    const [sha, ref, symrefTarget] = line.trim().split(' ')
    if (!sha || !ref) {
      continue
    }
    if (
      !ref.startsWith('refs/remotes/origin/') &&
      !ref.startsWith('refs/tags/')
    ) {
      continue
    }
    if (symrefTarget) {
      // Symbolic ref (e.g. origin/HEAD): never delete or rewrite it, and
      // don't let it consume the desired entry for its target branch.
      continue
    }
    const desiredSha = desired.get(ref)
    if (desiredSha === undefined) {
      instructions.push(`delete ${ref}`)
    } else if (desiredSha === sha) {
      desired.delete(ref)
    }
  }
  for (const [ref, sha] of desired) {
    instructions.push(`update ${ref} ${sha}`)
  }
  return instructions
}

/**
 * Build the contents of a packed-refs file holding the mirror's branch and
 * tag refs mapped into the workspace's namespaces (refs/remotes/origin/*
 * and refs/tags/*). The input is `for-each-ref` output in
 * '<objectname> <refname>' format.
 *
 * The header intentionally omits the peeled traits: emitting peel lines
 * would require dereferencing every annotated tag (one cold object read
 * per tag); without the traits git peels lazily on use instead. Entries
 * are byte-sorted by refname as the 'sorted' trait requires.
 */
export function buildPackedRefsContent(mirrorRefs: string): string {
  const entries: [string, string][] = []
  for (const line of mirrorRefs.split('\n')) {
    const [sha, ref] = line.trim().split(' ')
    if (!sha || !ref) {
      continue
    }
    const target = mapMirrorRefToWorkspace(ref)
    if (target) {
      entries.push([target, sha])
    }
  }
  entries.sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
  const lines = entries.map(([ref, sha]) => `${sha} ${ref}`)
  return `${['# pack-refs with: sorted', ...lines].join('\n')}\n`
}

/**
 * Copy branch and tag refs from the local mirror into the workspace without
 * running the fetch machinery. Because the workspace shares the mirror's
 * object store via alternates, no object data needs to move - only ref
 * name -> sha pairs. Unlike `git fetch <mirrorPath>`, this skips the ref
 * advertisement of the full mirror ref set, the mark_complete walk that
 * parses every local tip out of the cold pack, and the connectivity check -
 * which is minutes of serialized reads on a large cold mirror.
 *
 * The copy is only valid when the workspace actually shares the mirror's
 * object store: the copied refs are bare name -> sha pairs, so without the
 * alternate every one of them would dangle. Eligibility is therefore
 * verified explicitly (the alternates file must reference this mirror's
 * objects directory) rather than inferred, and anything unexpected -
 * missing/foreign alternates, a non-files ref backend, a gitfile worktree -
 * falls back to the local fetch, which moves objects as well as refs.
 *
 * Fresh workspace (no packed-refs file and nothing in the target
 * namespaces - the normal checkout path): the refs are written as the
 * workspace's packed-refs file directly. This touches no objects at all;
 * the only mirror reads are its own ref listing.
 *
 * Reused workspace: the refs are reconciled with `git update-ref --stdin`,
 * updating only refs that changed and pruning ones that disappeared
 * (symbolic refs such as origin/HEAD are preserved). update-ref verifies
 * the object of each ref it writes, so this costs one pack-index lookup
 * per *changed* ref rather than per ref.
 *
 * A successful copy removes any stale FETCH_HEAD left by an earlier
 * checkout in a reused workspace, so scripts never read fetch output that
 * predates this ref state.
 *
 * @returns true on success, false if the caller should fall back
 */
export async function copyRefsFromMirror(
  workspacePath: string,
  mirrorPath: string
): Promise<boolean> {
  try {
    const start = Date.now()

    const gitDir = path.join(workspacePath, '.git')
    if (!fs.existsSync(gitDir) || !fs.statSync(gitDir).isDirectory()) {
      core.info(
        '[git-mirror] Workspace .git is not a directory, using local fetch instead of direct ref copy'
      )
      return false
    }

    const alternatesPath = path.join(gitDir, 'objects', 'info', 'alternates')
    const expectedAlternate = `${mirrorPath}/objects`
    let hasMirrorAlternate = false
    try {
      const alternates = await fs.promises.readFile(alternatesPath, 'utf8')
      hasMirrorAlternate = alternates
        .split('\n')
        .some(line => line.trim() === expectedAlternate)
    } catch {
      hasMirrorAlternate = false
    }
    if (!hasMirrorAlternate) {
      core.info(
        '[git-mirror] Workspace does not share the mirror object store, using local fetch instead of direct ref copy'
      )
      return false
    }

    // Only the files ref backend stores refs in packed-refs / update-ref's
    // default loose format the way this path assumes. A reftable
    // repository ignores a packed-refs file entirely, so writing one would
    // silently produce a repo with no refs.
    const refStorage = await exec.getExecOutput(
      'git',
      ['-C', workspacePath, 'config', '--get', 'extensions.refstorage'],
      {silent: true, ignoreReturnCode: true}
    )
    const refBackend = refStorage.stdout.trim()
    if (refBackend !== '' && refBackend !== 'files') {
      core.info(
        `[git-mirror] Workspace uses ref backend '${refBackend}', using local fetch instead of direct ref copy`
      )
      return false
    }

    const mirrorRefs = await exec.getExecOutput(
      'git',
      [
        '-C',
        mirrorPath,
        'for-each-ref',
        '--format=%(objectname) %(refname)',
        'refs/heads',
        'refs/tags'
      ],
      {silent: true}
    )
    const workspaceRefs = await exec.getExecOutput(
      'git',
      [
        '-C',
        workspacePath,
        'for-each-ref',
        '--format=%(objectname) %(refname) %(symref)',
        'refs/remotes/origin',
        'refs/tags'
      ],
      {silent: true}
    )

    const packedRefsPath = path.join(gitDir, 'packed-refs')
    const freshWorkspace =
      workspaceRefs.stdout.trim() === '' && !fs.existsSync(packedRefsPath)

    if (freshWorkspace) {
      const content = buildPackedRefsContent(mirrorRefs.stdout)
      // Write-then-rename so no reader (or fallback path, if the write
      // fails partway) ever sees a truncated packed-refs file.
      const tmpPath = `${packedRefsPath}.new`
      await fs.promises.writeFile(tmpPath, content)
      await fs.promises.rename(tmpPath, packedRefsPath)
      const refCount = content.trimEnd().split('\n').length - 1
      core.info(
        `[git-mirror] Wrote ${refCount} refs from mirror as packed-refs in ${Date.now() - start}ms`
      )
      await removeStaleFetchHead(gitDir)
      return true
    }

    const instructions = buildRefCopyInstructions(
      mirrorRefs.stdout,
      workspaceRefs.stdout
    )
    if (instructions.length > 0) {
      await exec.exec('git', ['-C', workspacePath, 'update-ref', '--stdin'], {
        silent: true,
        input: Buffer.from(`${instructions.join('\n')}\n`)
      })
      await exec.exec('git', ['-C', workspacePath, 'pack-refs', '--all'], {
        silent: true
      })
    }
    core.info(
      `[git-mirror] Reconciled ${instructions.length} refs from mirror in ${Date.now() - start}ms`
    )
    await removeStaleFetchHead(gitDir)
    return true
  } catch (error) {
    core.warning(
      `[git-mirror] Direct ref copy from mirror failed, falling back to local fetch: ${error}`
    )
    return false
  }
}

/**
 * The direct ref copy does not run the fetch machinery, so it never writes
 * FETCH_HEAD. Remove one left over from an earlier checkout in a reused
 * workspace rather than letting scripts read stale fetch output.
 */
async function removeStaleFetchHead(gitDir: string): Promise<void> {
  try {
    await fs.promises.unlink(path.join(gitDir, 'FETCH_HEAD'))
  } catch {
    // Usually ENOENT (fresh workspace); FETCH_HEAD removal is best-effort.
  }
}

/**
 * Fetch branch and tag refs into the workspace from the local mirror.
 * Because the workspace shares the mirror's object store via alternates,
 * this transfers no object data - it only copies refs. This replaces the
 * full `+refs/heads/*` network fetch against the remote for fetch-depth: 0
 * checkouts. The caller synchronizes the mirror with the remote first (see
 * syncMirrorFromRemote) and still verifies/fetches the specific ref/commit
 * it needs from the network afterwards as a safety net.
 *
 * Refs are copied directly with update-ref (see copyRefsFromMirror); if
 * that fails for any reason, fall back to a local `git fetch` from the
 * mirror, which produces the same end state through the slower fetch
 * machinery.
 *
 * @returns true on success, false if the local fetch failed and the caller
 * should fall back to a network fetch
 */
export async function fetchRefsFromMirror(
  workspacePath: string,
  mirrorPath: string
): Promise<boolean> {
  core.info(`[git-mirror] Fetching refs locally from mirror at ${mirrorPath}`)
  if (await copyRefsFromMirror(workspacePath, mirrorPath)) {
    return true
  }
  try {
    await exec.exec('git', [
      '-C',
      workspacePath,
      '-c',
      'gc.auto=0',
      'fetch',
      '--prune',
      '--no-tags',
      '--no-recurse-submodules',
      mirrorPath,
      '+refs/heads/*:refs/remotes/origin/*',
      '+refs/tags/*:refs/tags/*'
    ])
    return true
  } catch (error) {
    core.warning(
      `[git-mirror] Local ref fetch from mirror failed, falling back to network fetch: ${error}`
    )
    return false
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
 * Write the mirror's commit-graph so subsequent commit parsing (e.g. the
 * per-ref walks inside fetch) is a lookup in one compact file instead of
 * scattered pack reads. Reading commit-graphs is enabled by default in git;
 * writing only happens during a real gc, so a freshly cloned mirror has
 * none until the first threshold-tripping `gc --auto`. Failure is
 * non-fatal - the graph is a pure cache.
 */
async function writeCommitGraph(
  mirrorPath: string,
  timeoutSecs: number = GC_TIMEOUT_SECS
): Promise<void> {
  try {
    const start = Date.now()
    const result = await exec.getExecOutput(
      'timeout',
      [
        String(timeoutSecs),
        'git',
        '-C',
        mirrorPath,
        'commit-graph',
        'write',
        '--reachable'
      ],
      {silent: true, ignoreReturnCode: true}
    )
    if (result.exitCode === TIMEOUT_EXIT_CODE) {
      core.warning(
        `[git-mirror] commit-graph write timed out after ${timeoutSecs}s`
      )
      return
    }
    if (result.exitCode !== 0) {
      core.warning(
        `[git-mirror] commit-graph write failed with exit code ${result.exitCode}`
      )
      return
    }
    core.info(`[git-mirror] Wrote commit-graph in ${Date.now() - start}ms`)
  } catch (error) {
    core.warning(`[git-mirror] commit-graph write failed: ${error}`)
  }
}

/**
 * Whether the mirror has a commit-graph (single file or split chain).
 * Determines if the sync fetch can write incrementally.
 */
export function hasCommitGraph(mirrorPath: string): boolean {
  return (
    fs.existsSync(path.join(mirrorPath, 'objects', 'info', 'commit-graph')) ||
    fs.existsSync(
      path.join(
        mirrorPath,
        'objects',
        'info',
        'commit-graphs',
        'commit-graph-chain'
      )
    )
  )
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
    // gc.autoDetach=false: prevent git from forking a background daemon for GC.
    // Without this, the parent `git gc --auto` returns immediately while the
    // daemonized child keeps running with cwd and mmap'd pack files on the
    // mirror mount, causing the subsequent `umount` to fail with EBUSY.
    const result = await exec.getExecOutput(
      'timeout',
      [
        String(timeoutSecs),
        'git',
        '-c',
        'gc.autoDetach=false',
        '-C',
        mirrorPath,
        'gc',
        '--auto'
      ],
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
 * Get the block device path for a mount point.
 * Tries findmnt first, then falls back to parsing mount output.
 */
async function getDeviceFromMount(mountPoint: string): Promise<string | null> {
  try {
    const result = await exec.getExecOutput(
      'findmnt',
      ['-n', '-o', 'SOURCE', mountPoint],
      {ignoreReturnCode: true, silent: true}
    )
    if (result.exitCode === 0 && result.stdout.trim()) {
      return result.stdout.trim()
    }
  } catch {
    core.info(
      `[git-mirror] findmnt failed for ${mountPoint}, trying mount command`
    )
  }

  try {
    const result = await exec.getExecOutput('mount', [], {
      ignoreReturnCode: true,
      silent: true
    })
    if (result.exitCode === 0) {
      const lines = result.stdout.split('\n')
      for (const line of lines) {
        if (line.includes(` ${mountPoint} `)) {
          const match = line.match(/^(\/dev\/\S+)/)
          if (match) {
            return match[1]
          }
        }
      }
    }
  } catch {
    core.info(`[git-mirror] mount command failed for ${mountPoint}`)
  }

  return null
}

/**
 * Flush block device buffers to ensure data durability before Ceph RBD snapshot.
 * This is a best-effort operation - failures are logged but don't fail the cleanup.
 */
async function flushBlockDevice(devicePath: string): Promise<void> {
  const deviceName = devicePath.replace('/dev/', '')
  if (!deviceName) {
    core.info(`[git-mirror] Could not extract device name from ${devicePath}`)
    return
  }

  const statPath = `/sys/block/${deviceName}/stat`

  let beforeStats = ''
  try {
    beforeStats = fs.readFileSync(statPath, 'utf8').trim()
  } catch {
    core.info(
      `[git-mirror] Could not read block device stats before flush: ${statPath}`
    )
  }

  const startTime = Date.now()
  try {
    const result = await exec.getExecOutput(
      'timeout',
      [
        String(FLUSH_TIMEOUT_SECS),
        'sudo',
        'blockdev',
        '--flushbufs',
        devicePath
      ],
      {ignoreReturnCode: true}
    )

    const duration = Date.now() - startTime

    if (result.exitCode === TIMEOUT_EXIT_CODE) {
      core.warning(
        `[git-mirror] Flush timed out for ${devicePath} after ${FLUSH_TIMEOUT_SECS}s`
      )
      return
    }

    if (result.exitCode !== 0) {
      core.warning(
        `[git-mirror] Flush failed for ${devicePath} after ${duration}ms: exit code ${result.exitCode}`
      )
      return
    }

    let afterStats = ''
    try {
      afterStats = fs.readFileSync(statPath, 'utf8').trim()
    } catch {
      core.info(
        `[git-mirror] Could not read block device stats after flush: ${statPath}`
      )
    }

    core.info(
      `[git-mirror] guest flush duration: ${duration}ms, device: ${devicePath}, before_stats: ${beforeStats}, after_stats: ${afterStats}`
    )
  } catch (error) {
    const duration = Date.now() - startTime
    const msg = (error as Error).message || String(error)
    core.warning(
      `[git-mirror] Flush failed for ${devicePath} after ${duration}ms: ${msg}`
    )
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
  // Mirror sync outcome from the main step.
  mirrorSyncFailed?: boolean
  mirrorSyncTimedOut?: boolean
}

/**
 * Cleanup: run GC, sync, unmount, and commit the sticky disk.
 *
 * Execution order: GC → sync → unmount (with retry) → flush → commit
 * If the mirror sync or GC failed or timed out, shouldCommit is set to false.
 */
export async function cleanup(options: CleanupOptions): Promise<CleanupResult> {
  const {
    exposeId,
    stickyDiskKey,
    repoName,
    mountPoint,
    mirrorPath,
    mirrorSyncFailed,
    mirrorSyncTimedOut
  } = options
  let {shouldCommit} = options
  // vmHydratedGitMirror must track shouldCommit: if we decide not to commit
  // (due to GC/refresh failure), we must not tell the backend that
  // hydration completed, otherwise it marks the entry as ready despite no
  // valid disk being persisted.
  let vmHydratedGitMirror = options.vmHydratedGitMirror

  const result: CleanupResult = {
    gcResult: {success: true, timedOut: false}
  }

  core.info(
    `[git-mirror] Starting cleanup: exposeId=${exposeId}, stickyDiskKey=${stickyDiskKey}, shouldCommit=${shouldCommit}, vmHydratedGitMirror=${vmHydratedGitMirror}`
  )

  // If the mirror sync failed or timed out, don't commit
  if (mirrorSyncFailed || mirrorSyncTimedOut) {
    const reason = mirrorSyncTimedOut ? 'timed out' : 'failed'
    core.warning(
      `[git-mirror] Mirror sync ${reason}, will not commit sticky disk`
    )
    shouldCommit = false
    vmHydratedGitMirror = false
  }

  if (mirrorPath) {
    // Run GC on the mirror
    result.gcResult = await runMirrorGC(mirrorPath)
    if (!result.gcResult.success) {
      core.warning(
        '[git-mirror] GC failed or timed out, will not commit sticky disk'
      )
      shouldCommit = false
      vmHydratedGitMirror = false
    }
    // Catch-up for mirrors that predate commit-graph writing: build the
    // initial graph here in the post step, off the checkout critical path.
    // Once it exists, the sync fetch keeps it current incrementally. Only
    // worth doing when the disk is being committed; failure is non-fatal.
    if (shouldCommit && !hasCommitGraph(mirrorPath)) {
      await writeCommitGraph(mirrorPath)
    }
  }

  // Sync filesystem before unmount to ensure all writes are flushed
  core.debug('[git-mirror] Syncing filesystem before unmount')
  try {
    await exec.exec('sync')
  } catch {
    core.warning('[git-mirror] Failed to sync filesystem')
  }

  // Get device path before unmount for durability flush
  let devicePath: string | null = null
  if (mountPoint) {
    try {
      devicePath = await getDeviceFromMount(mountPoint)
      if (devicePath) {
        core.info(
          `[git-mirror] Found device ${devicePath} for mount point ${mountPoint}`
        )
      }
    } catch {
      core.info(`[git-mirror] Could not determine device for ${mountPoint}`)
    }
  }

  // Unmount the sticky disk with retry and backoff
  if (mountPoint) {
    let unmountSuccess = false
    let delayMs = UMOUNT_INITIAL_DELAY_MS

    for (let attempt = 1; attempt <= UMOUNT_MAX_RETRIES; attempt++) {
      core.info(
        `[git-mirror] Unmounting ${mountPoint} (attempt ${attempt}/${UMOUNT_MAX_RETRIES})`
      )
      try {
        const umountResult = await exec.getExecOutput(
          'timeout',
          [String(UMOUNT_TIMEOUT_SECS), 'sudo', 'umount', mountPoint],
          {ignoreReturnCode: true}
        )
        if (umountResult.exitCode === 0) {
          unmountSuccess = true
          core.info(`[git-mirror] Successfully unmounted ${mountPoint}`)
          break
        }

        if (umountResult.exitCode === TIMEOUT_EXIT_CODE) {
          core.warning(
            `[git-mirror] Unmount attempt ${attempt} timed out after ${UMOUNT_TIMEOUT_SECS}s`
          )
        } else {
          core.warning(
            `[git-mirror] Unmount attempt ${attempt} failed with exit code ${umountResult.exitCode}`
          )
        }

        // Print diagnostic info about what's using the mount point (with 5s timeout to avoid hanging)
        core.info(`[git-mirror] Checking for processes using ${mountPoint}...`)
        try {
          const lsofResult = await exec.getExecOutput(
            'timeout',
            ['5', 'lsof', '+D', mountPoint],
            {ignoreReturnCode: true, silent: true}
          )
          if (lsofResult.exitCode === TIMEOUT_EXIT_CODE) {
            core.info(`[git-mirror] lsof timed out after 5s`)
          } else if (lsofResult.stdout.trim()) {
            core.warning(
              `[git-mirror] Processes using ${mountPoint}:\n${lsofResult.stdout}`
            )
          } else {
            core.info(`[git-mirror] No processes found using ${mountPoint}`)
          }
        } catch {
          // lsof may not be available, try fuser as fallback
          try {
            const fuserResult = await exec.getExecOutput(
              'timeout',
              ['5', 'fuser', '-vm', mountPoint],
              {ignoreReturnCode: true, silent: true}
            )
            if (fuserResult.exitCode === TIMEOUT_EXIT_CODE) {
              core.info(`[git-mirror] fuser timed out after 5s`)
            } else if (fuserResult.stdout.trim() || fuserResult.stderr.trim()) {
              core.warning(
                `[git-mirror] Processes using ${mountPoint}:\n${fuserResult.stdout}${fuserResult.stderr}`
              )
            }
          } catch {
            core.info(
              `[git-mirror] Could not determine processes using ${mountPoint}`
            )
          }
        }

        if (attempt < UMOUNT_MAX_RETRIES) {
          core.info(`[git-mirror] Waiting ${delayMs}ms before retry...`)
          await new Promise(resolve => setTimeout(resolve, delayMs))
          delayMs *= UMOUNT_BACKOFF_MULTIPLIER
        }
      } catch (error) {
        core.warning(
          `[git-mirror] Unmount attempt ${attempt} threw error: ${(error as Error).message}`
        )
        if (attempt < UMOUNT_MAX_RETRIES) {
          core.info(`[git-mirror] Waiting ${delayMs}ms before retry...`)
          await new Promise(resolve => setTimeout(resolve, delayMs))
          delayMs *= UMOUNT_BACKOFF_MULTIPLIER
        }
      }
    }

    if (!unmountSuccess) {
      core.warning(
        `[git-mirror] Failed to unmount ${mountPoint} after ${UMOUNT_MAX_RETRIES} attempts, will not commit sticky disk`
      )
      shouldCommit = false
      vmHydratedGitMirror = false
    }
  }

  // Flush block device buffers after unmount to ensure data durability
  // before the Ceph RBD snapshot is taken. The device is still mapped even though unmounted.
  if (devicePath) {
    await flushBlockDevice(devicePath)
  } else if (mountPoint) {
    core.info(
      '[git-mirror] Skipping durability flush: device path not found for mount point'
    )
  }

  // Commit the sticky disk to persist changes
  core.info(
    `[git-mirror] Committing sticky disk: shouldCommit=${shouldCommit}, vmHydratedGitMirror=${vmHydratedGitMirror}`
  )
  try {
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
  } catch (error) {
    core.warning(
      `[git-mirror] Failed to commit sticky disk: ${(error as any)?.message ?? error}`
    )
  }

  return result
}
