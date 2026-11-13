import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as fs from 'fs'
import * as io from '@actions/io'
import * as path from 'path'
import {isRunningInContainer} from './container-detector'
import {getAuthConfigArgs} from './blacksmith-cache'

/**
 * gitfs serves the workspace from the git mirror sticky disk instead of
 * checking it out: `gitfs mount <mirror> --ref <sha> <workspace> --daemon`
 * returns as soon as the tree is mounted (milliseconds), writes the real
 * checkout out in the background and swaps it in for the mount once it is
 * complete. Writes made through the mount in the meantime (`.git`, npm's
 * node_modules, ...) land in that same tree. The agent enables it per job via
 * BLACKSMITH_USE_GITFS=true, driven by the installation's use_gitfs_checkout
 * flag; anything gitfs cannot serve falls through to the regular checkout.
 */
export const GITFS_ENV = 'BLACKSMITH_USE_GITFS'
const GITFS_BINARY = 'gitfs'
const DAEMON_EXIT_TIMEOUT_MS = 10_000
const DAEMON_KILL_TIMEOUT_MS = 5_000

export function isGitfsRequested(
  env: {[key: string]: string | undefined} = process.env
): boolean {
  return env[GITFS_ENV] === 'true'
}

export interface EligibilitySettings {
  ref: string
  commit: string
  submodules: boolean
  lfs: boolean
  sparseCheckout: string[] | null | undefined
  filter: string | undefined
  dissociate: boolean
  repositoryPath: string
}

export interface EligibilityContext {
  mirrorPath: string | null
  platform?: string
  inContainer?: boolean
}

/**
 * Why gitfs cannot serve this checkout, or null when it can. The v1 cohort is
 * the plain case: a Linux runner VM with the mirror mounted, a branch, tag,
 * pull ref or commit to serve, and none of the features that need the
 * workspace to be a real fetch (submodules, LFS, sparse/partial clones,
 * dissociate).
 */
export function gitfsIneligibilityReason(
  settings: EligibilitySettings,
  ctx: EligibilityContext
): string | null {
  const platform = ctx.platform ?? process.platform
  if (platform !== 'linux') {
    return `platform ${platform} is not linux`
  }
  if (!ctx.mirrorPath) {
    return 'git mirror is not available'
  }
  const inContainer = ctx.inContainer ?? isRunningInContainer()
  if (inContainer) {
    return 'running inside a container'
  }
  if (!settings.ref && !settings.commit) {
    return 'no ref or commit requested'
  }
  if (settings.submodules) {
    return 'submodules are enabled'
  }
  if (settings.lfs) {
    return 'lfs is enabled'
  }
  if (settings.sparseCheckout && settings.sparseCheckout.length > 0) {
    return 'sparse checkout is enabled'
  }
  if (settings.filter) {
    return `filter ${settings.filter} is set`
  }
  if (settings.dissociate) {
    return 'dissociate is enabled'
  }
  if (fs.existsSync(path.join(settings.repositoryPath, '.git'))) {
    return 'workspace already contains a repository'
  }
  return null
}

export async function findBinary(): Promise<string | null> {
  const found = await io.which(GITFS_BINARY, false)
  return found || null
}

export type RefKind = 'branch' | 'tag' | 'pull' | 'other' | 'commit'

export interface MirrorRevision {
  sha: string
  /** The mirror ref the revision came from, '' when only a commit matched. */
  mirrorRef: string
  kind: RefKind
}

interface Candidate {
  rev: string
  mirrorRef: string
  kind: RefKind
}

function classify(ref: string): RefKind {
  const upper = ref.toUpperCase()
  if (upper.startsWith('REFS/HEADS/')) return 'branch'
  if (upper.startsWith('REFS/TAGS/')) return 'tag'
  if (upper.startsWith('REFS/PULL/')) return 'pull'
  return 'other'
}

/**
 * Revisions to try in the mirror for the requested ref/commit, in order. A
 * commit wins over the ref (that is what the checkout would end up at); an
 * unqualified ref is a branch first, then a tag, as in getCheckoutInfo.
 */
export function mirrorRevisionCandidates(
  ref: string,
  commit: string
): Candidate[] {
  if (commit) {
    const kind = ref ? classify(ref) : 'commit'
    const mirrorRef = ref && ref.toUpperCase().startsWith('REFS/') ? ref : ''
    return [{rev: `${commit}^{commit}`, mirrorRef, kind}]
  }
  if (!ref) {
    return []
  }
  if (ref.toUpperCase().startsWith('REFS/')) {
    return [{rev: `${ref}^{commit}`, mirrorRef: ref, kind: classify(ref)}]
  }
  return [
    {
      rev: `refs/heads/${ref}^{commit}`,
      mirrorRef: `refs/heads/${ref}`,
      kind: 'branch'
    },
    {
      rev: `refs/tags/${ref}^{commit}`,
      mirrorRef: `refs/tags/${ref}`,
      kind: 'tag'
    }
  ]
}

/**
 * What `gitfs mount --url` fetches for a revision the mirror lacks: a commit
 * by sha, a qualified ref by name, an unqualified ref as a branch.
 */
export function coldRevision(ref: string, commit: string): string {
  if (commit) {
    return commit
  }
  if (ref.toUpperCase().startsWith('REFS/')) {
    return ref
  }
  return `refs/heads/${ref}`
}

export async function resolveInMirror(
  mirrorPath: string,
  candidates: Candidate[]
): Promise<MirrorRevision | null> {
  for (const candidate of candidates) {
    const result = await exec.getExecOutput(
      'git',
      ['-C', mirrorPath, 'rev-parse', '--verify', '--quiet', candidate.rev],
      {silent: true, ignoreReturnCode: true}
    )
    const sha = result.stdout.trim()
    if (result.exitCode === 0 && /^[0-9a-f]{40}$/.test(sha)) {
      return {sha, mirrorRef: candidate.mirrorRef, kind: candidate.kind}
    }
  }
  return null
}

export async function fetchIntoMirror(
  mirrorPath: string,
  repositoryUrl: string,
  authToken: string,
  refspecs: string[]
): Promise<void> {
  const auth = getAuthConfigArgs(repositoryUrl, authToken)
  await exec.exec('git', [
    '-C',
    mirrorPath,
    '-c',
    `${auth.configKey}=${auth.configValue}`,
    '-c',
    'gc.auto=0',
    'fetch',
    '--no-tags',
    '--no-recurse-submodules',
    '--no-write-fetch-head',
    repositoryUrl,
    ...refspecs
  ])
}

export async function mount(
  binary: string,
  mirrorPath: string,
  sha: string,
  mountpoint: string
): Promise<void> {
  if (fs.existsSync(mountpoint) && fs.readdirSync(mountpoint).length > 0) {
    throw new Error(`${mountpoint} is not empty`)
  }
  await exec.exec(binary, [
    'mount',
    mirrorPath,
    '--ref',
    sha,
    mountpoint,
    '--daemon'
  ])
}

/**
 * Mount a revision the mirror does not have: gitfs fetches it from the
 * remote into the mirror (`--depth 1`, serving the pack as it arrives) and
 * completes the mirror in the background. Returns the commit sha, which
 * gitfs prints once the commit is in, before git has written the ref.
 */
export async function mountCold(
  binary: string,
  mirrorPath: string,
  rev: string,
  mountpoint: string,
  repositoryUrl: string,
  authToken: string
): Promise<string> {
  if (fs.existsSync(mountpoint) && fs.readdirSync(mountpoint).length > 0) {
    throw new Error(`${mountpoint} is not empty`)
  }
  const env: {[key: string]: string} = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value
    }
  }
  env.GITFS_TOKEN = authToken
  const result = await exec.getExecOutput(
    binary,
    [
      'mount',
      mirrorPath,
      '--ref',
      rev,
      mountpoint,
      '--daemon',
      '--url',
      repositoryUrl
    ],
    {env}
  )
  const sha = result.stdout.trim().split('\n').pop()?.trim() ?? ''
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(
      `gitfs did not report the mounted commit: ${result.stdout.trim()}`
    )
  }
  return sha
}

/**
 * Point the workspace at the mounted revision without touching the tree:
 * the local branch / tag / pull ref the regular checkout would have created,
 * HEAD on it (or detached, as `git checkout` would leave it), and an index
 * for the tree. The files are already there, served by gitfs.
 */
export async function pointWorkspaceAt(
  repositoryPath: string,
  ref: string,
  revision: MirrorRevision,
  env?: {[key: string]: string}
): Promise<void> {
  const git = async (...args: string[]): Promise<void> => {
    await exec.exec('git', ['-C', repositoryPath, ...args], {env})
  }
  const {sha} = revision
  if (revision.kind === 'branch') {
    const branch = revision.mirrorRef.slice('refs/heads/'.length)
    await git('update-ref', `refs/remotes/origin/${branch}`, sha)
    await git('update-ref', `refs/heads/${branch}`, sha)
    await git('config', `branch.${branch}.remote`, 'origin')
    await git('config', `branch.${branch}.merge`, `refs/heads/${branch}`)
    await git('symbolic-ref', 'HEAD', `refs/heads/${branch}`)
  } else {
    if (revision.kind === 'tag') {
      await git('update-ref', revision.mirrorRef, sha)
    } else if (revision.kind === 'pull') {
      const name = revision.mirrorRef.slice('refs/pull/'.length)
      await git('update-ref', `refs/remotes/pull/${name}`, sha)
    }
    await git('update-ref', '--no-deref', 'HEAD', sha)
  }
  // Index entries without stat data: git re-verifies file contents on the
  // first status/diff instead of touching every file now.
  await git('read-tree', sha)
}

function daemonPids(mirrorPath: string): number[] {
  const pids: number[] = []
  let entries: string[]
  try {
    entries = fs.readdirSync('/proc')
  } catch {
    return pids
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    let cmdline: string
    try {
      cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8')
    } catch {
      continue
    }
    const argv = cmdline.split('\0')
    if (
      path.basename(argv[0] || '') === GITFS_BINARY &&
      argv.includes('mount') &&
      argv.includes(mirrorPath)
    ) {
      pids.push(Number(entry))
    }
  }
  return pids
}

async function waitForDaemons(
  mirrorPath: string,
  timeoutMs: number
): Promise<number[]> {
  const deadline = Date.now() + timeoutMs
  let pids = daemonPids(mirrorPath)
  while (pids.length > 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100))
    pids = daemonPids(mirrorPath)
  }
  return pids
}

/**
 * Take gitfs down before the mirror sticky disk is unmounted: the daemon has
 * the mirror's packs mapped, so the disk cannot be released while it lives.
 * `gitfs unmount` handles both phases — while the tree is still being
 * written the workspace path is a symlink into the mount and unmounting
 * discards the partial tree (the workspace is left empty); after the swap
 * the path is a plain directory and the FUSE view that served it is still up
 * on the hidden sibling path, which unmount takes down.
 */
export async function teardown(
  mountpoint: string,
  mirrorPath: string
): Promise<void> {
  const binary = await findBinary()
  if (binary && fs.existsSync(mountpoint)) {
    core.info(`[gitfs] Unmounting ${mountpoint}`)
    await exec.exec(binary, ['unmount', mountpoint], {ignoreReturnCode: true})
  }
  let pids = await waitForDaemons(mirrorPath, DAEMON_EXIT_TIMEOUT_MS)
  if (pids.length > 0) {
    core.info(
      `[gitfs] Stopping daemon(s) ${pids.join(', ')} still serving ${mirrorPath}`
    )
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        // already gone
      }
    }
    pids = await waitForDaemons(mirrorPath, DAEMON_KILL_TIMEOUT_MS)
    if (pids.length > 0) {
      core.warning(
        `[gitfs] daemon(s) ${pids.join(', ')} did not exit; the mirror unmount may fail`
      )
    }
  }
}
