import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as fs from 'fs'
import * as path from 'path'
import {createClient} from '@connectrpc/connect'
import {createGrpcTransport} from '@connectrpc/connect-node'
import {StickyDiskService} from '@buf/blacksmith_vm-agent.connectrpc_es/stickydisk/v1/stickydisk_connect'

const GRPC_PORT = process.env.BLACKSMITH_STICKY_DISK_GRPC_PORT || '5557'
const MOUNT_POINT = '/blacksmith-git-mirror'
const MIRROR_VERSION = 'v1'

export interface CacheInfo {
  exposeId: string
  stickyDiskKey: string
  device: string
  mirrorPath: string
}

/**
 * Check if running in a Blacksmith environment by detecting BLACKSMITH_VM_ID
 */
export function isBlacksmithEnvironment(): boolean {
  return !!process.env.BLACKSMITH_VM_ID
}

/**
 * Get the path where the bare git mirror will be stored
 */
export function getMirrorPath(owner: string, repo: string): string {
  return path.join(MOUNT_POINT, MIRROR_VERSION, `${owner}-${repo}.git`)
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
 * Request a sticky disk from the VM agent, format if needed, and mount it
 */
export async function setupCache(
  owner: string,
  repo: string
): Promise<CacheInfo> {
  const client = createBlacksmithClient()

  // Test connection
  try {
    await client.up({})
    core.debug('Successfully connected to Blacksmith agent')
  } catch (error) {
    throw new Error(`gRPC connection test failed: ${(error as Error).message}`)
  }

  const stickyDiskKey = `${owner}-${repo}`
  core.info(`Requesting sticky disk for ${stickyDiskKey}`)

  // Request sticky disk from VM agent
  const response = await client.getStickyDisk({
    stickyDiskKey: stickyDiskKey,
    stickyDiskType: 'git-mirror',
    region: process.env.BLACKSMITH_REGION || '',
    installationModelId: process.env.BLACKSMITH_INSTALLATION_MODEL_ID || '',
    vmId: process.env.BLACKSMITH_VM_ID || '',
    repoName: process.env.GITHUB_REPO_NAME || '',
    stickyDiskToken: process.env.BLACKSMITH_STICKYDISK_TOKEN || ''
  })

  const exposeId = (response as {exposeId?: string}).exposeId || ''
  const device = (response as {diskIdentifier?: string}).diskIdentifier || ''

  if (!device) {
    throw new Error('No device found in sticky disk response')
  }

  core.info(`Got sticky disk device: ${device}`)

  // Format if needed
  await maybeFormatDevice(device)

  // Mount the device
  await exec.exec('sudo', ['mkdir', '-p', MOUNT_POINT])
  await exec.exec('sudo', ['mount', device, MOUNT_POINT])
  core.debug(`Mounted ${device} at ${MOUNT_POINT}`)

  return {
    exposeId,
    stickyDiskKey,
    device,
    mirrorPath: getMirrorPath(owner, repo)
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
 * Ensure a bare git mirror exists and is up to date
 * If the mirror exists, fetch updates; otherwise clone a new mirror
 *
 * Uses http.extraheader for authentication (same as upstream checkout action)
 */
export async function ensureMirror(
  mirrorPath: string,
  repoUrl: string,
  authToken: string
): Promise<void> {
  const {configKey, configValue} = getAuthConfigArgs(repoUrl, authToken)

  if (fs.existsSync(mirrorPath)) {
    // Incremental update - fetch new refs and prune deleted ones
    core.info(`Updating existing mirror at ${mirrorPath}`)
    await exec.exec('git', [
      '-c',
      `${configKey}=${configValue}`,
      '-C',
      mirrorPath,
      'fetch',
      '--prune',
      'origin'
    ])
  } else {
    // First time - create a bare mirror clone
    core.info(`Creating new mirror at ${mirrorPath}`)
    const mirrorDir = path.dirname(mirrorPath)
    await exec.exec('sudo', ['mkdir', '-p', mirrorDir])
    // Change ownership so git can write to it
    const uid = process.getuid?.() ?? 1000
    const gid = process.getgid?.() ?? 1000
    await exec.exec('sudo', ['chown', '-R', `${uid}:${gid}`, mirrorDir])
    await exec.exec('git', [
      '-c',
      `${configKey}=${configValue}`,
      'clone',
      '--mirror',
      '--progress',
      '--verbose',
      repoUrl,
      mirrorPath
    ])
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
 * Run garbage collection on the mirror to consolidate pack files and remove unreachable objects.
 * This runs in the post-job phase to avoid impacting checkout performance.
 *
 * Using `git gc --prune=now` is safe here because:
 * 1. Post-job runs after all user workflow steps complete
 * 2. No concurrent processes are writing to the mirror
 * 3. The mirror is only used by the checkout action
 */
async function runMirrorGC(mirrorPath: string): Promise<void> {
  core.info('Running garbage collection on git mirror')

  try {
    // git gc handles everything: repack, prune, pack-refs, reflog expire
    // --prune=now is safe because no concurrent writes during post-job
    await exec.exec('git', ['-C', mirrorPath, 'gc', '--prune=now'], {
      ignoreReturnCode: true // Don't fail cleanup if gc fails
    })
    core.debug('Completed git gc')
  } catch {
    core.warning('Failed to run git gc on mirror')
  }
}

/**
 * Cleanup: run GC on mirror, sync, unmount, and commit the sticky disk.
 * GC runs here (post-job) to avoid impacting VM boot or checkout performance.
 */
export async function cleanup(
  exposeId: string,
  stickyDiskKey: string,
  mirrorPath?: string
): Promise<void> {
  // Run GC on the mirror before unmount to reduce disk size
  if (mirrorPath) {
    try {
      await runMirrorGC(mirrorPath)
    } catch {
      core.warning('Mirror GC failed, continuing with cleanup')
    }
  }

  // Sync filesystem before unmount to ensure all writes are flushed
  core.debug('Syncing filesystem before unmount')
  try {
    await exec.exec('sync')
  } catch {
    core.warning('Failed to sync filesystem')
  }

  // Unmount the sticky disk
  core.debug(`Unmounting ${MOUNT_POINT}`)
  try {
    await exec.exec('sudo', ['umount', MOUNT_POINT])
  } catch {
    core.warning(`Failed to unmount ${MOUNT_POINT}`)
  }

  // Commit the sticky disk to persist changes
  core.info('Committing sticky disk')
  const client = createBlacksmithClient()

  await client.commitStickyDisk({
    exposeId: exposeId,
    stickyDiskKey: stickyDiskKey,
    vmId: process.env.BLACKSMITH_VM_ID || '',
    shouldCommit: true,
    repoName: process.env.GITHUB_REPO_NAME || '',
    stickyDiskToken: process.env.BLACKSMITH_STICKYDISK_TOKEN || ''
  })

  core.info('Successfully committed sticky disk')
}
