import * as core from '@actions/core'

/**
 * Indicates whether the POST action is running
 */
export const IsPost = !!core.getState('isPost')

/**
 * The repository path for the POST action. The value is empty during the MAIN action.
 */
export const RepositoryPath = core.getState('repositoryPath')

/**
 * The set-safe-directory for the POST action. The value is set if input: 'safe-directory' is set during the MAIN action.
 */
export const PostSetSafeDirectory = core.getState('setSafeDirectory') === 'true'

/**
 * The SSH key path for the POST action. The value is empty during the MAIN action.
 */
export const SshKeyPath = core.getState('sshKeyPath')

/**
 * The SSH known hosts path for the POST action. The value is empty during the MAIN action.
 */
export const SshKnownHostsPath = core.getState('sshKnownHostsPath')

/**
 * The Blacksmith cache expose ID for the POST action. The value is empty during the MAIN action.
 */
export const BlacksmithCacheExposeId = core.getState('blacksmithCacheExposeId')

/**
 * The Blacksmith cache mirror path for the POST action. The value is empty during the MAIN action.
 */
export const BlacksmithCacheMirrorPath = core.getState(
  'blacksmithCacheMirrorPath'
)

/**
 * The Blacksmith cache mount point for the POST action. The value is empty during the MAIN action.
 */
export const BlacksmithCacheMountPoint = core.getState(
  'blacksmithCacheMountPoint'
)

/**
 * The repository name (owner/repo) for the Blacksmith cache. The value is empty during the MAIN action.
 */
export const BlacksmithCacheRepoName = core.getState('blacksmithCacheRepoName')

/**
 * The Blacksmith cache sticky disk key for the POST action. The value is empty during the MAIN action.
 */
export const BlacksmithCacheStickyDiskKey = core.getState(
  'blacksmithCacheStickyDiskKey'
)

/**
 * Indicates whether this job performed initial git mirror hydration.
 * Used to notify the backend on commit so it can mark hydration as complete.
 */
export const BlacksmithCachePerformedHydration =
  core.getState('blacksmithCachePerformedHydration') === 'true'

/**
 * Whether the main step's mirror sync changed the mirror. Used by the POST
 * action to decide whether the sticky disk needs to be committed.
 */
export const BlacksmithCacheMirrorChanged =
  core.getState('blacksmithCacheMirrorChanged') === 'true'

/**
 * Whether the main step's mirror sync failed or timed out. Used by the POST
 * action to skip committing a potentially inconsistent mirror.
 */
export const BlacksmithCacheMirrorSyncFailed =
  core.getState('blacksmithCacheMirrorSyncFailed') === 'true'

export const BlacksmithCacheMirrorSyncTimedOut =
  core.getState('blacksmithCacheMirrorSyncTimedOut') === 'true'

/**
 * Whether the mirror sync was deferred to the POST action (shallow
 * checkouts, which never populate the workspace from mirror refs).
 */
export const BlacksmithCacheMirrorSyncDeferred =
  core.getState('blacksmithCacheMirrorSyncDeferred') === 'true'

/**
 * The repository URL for a deferred mirror sync in the POST action.
 */
export const BlacksmithCacheRepoUrl = core.getState('blacksmithCacheRepoUrl')

/**
 * Whether verbose output is enabled for git mirror operations in the POST action.
 */
export const BlacksmithCacheVerbose =
  core.getState('blacksmithCacheVerbose') === 'true'

/**
 * Reason the host gave at mount time for denying this job's sticky disk commit
 * (e.g. branch protection). Empty when no denial was reported.
 */
export const BlacksmithCacheCommitEarlyDenyReason = core.getState(
  'blacksmithCacheCommitEarlyDenyReason'
)

/**
 * Save the repository path so the POST action can retrieve the value.
 */
export function setRepositoryPath(repositoryPath: string) {
  core.saveState('repositoryPath', repositoryPath)
}

/**
 * Save the SSH key path so the POST action can retrieve the value.
 */
export function setSshKeyPath(sshKeyPath: string) {
  core.saveState('sshKeyPath', sshKeyPath)
}

/**
 * Save the SSH known hosts path so the POST action can retrieve the value.
 */
export function setSshKnownHostsPath(sshKnownHostsPath: string) {
  core.saveState('sshKnownHostsPath', sshKnownHostsPath)
}

/**
 * Save the set-safe-directory input so the POST action can retrieve the value.
 */
export function setSafeDirectory() {
  core.saveState('setSafeDirectory', 'true')
}

/**
 * Save the Blacksmith cache expose ID so the POST action can commit the sticky disk.
 */
export function setBlacksmithCacheExposeId(exposeId: string) {
  core.saveState('blacksmithCacheExposeId', exposeId)
}

/**
 * Save the Blacksmith cache mirror path so the POST action can run GC before commit.
 */
export function setBlacksmithCacheMirrorPath(mirrorPath: string) {
  core.saveState('blacksmithCacheMirrorPath', mirrorPath)
}

/**
 * Save the Blacksmith cache mount point so the POST action can unmount.
 */
export function setBlacksmithCacheMountPoint(mountPoint: string) {
  core.saveState('blacksmithCacheMountPoint', mountPoint)
}

/**
 * Save the repository name (owner/repo) so the POST action can use it for cleanup.
 */
export function setBlacksmithCacheRepoName(repoName: string) {
  core.saveState('blacksmithCacheRepoName', repoName)
}

/**
 * Save the Blacksmith cache sticky disk key so the POST action can commit the sticky disk.
 */
export function setBlacksmithCacheStickyDiskKey(stickyDiskKey: string) {
  core.saveState('blacksmithCacheStickyDiskKey', stickyDiskKey)
}

/**
 * Save whether this job performed initial git mirror hydration.
 * Used by POST action to notify backend so it can mark hydration as complete.
 */
export function setBlacksmithCachePerformedHydration(performed: boolean) {
  core.saveState(
    'blacksmithCachePerformedHydration',
    performed ? 'true' : 'false'
  )
}

/**
 * Save whether the main step's mirror sync changed the mirror.
 */
export function setBlacksmithCacheMirrorChanged(changed: boolean) {
  core.saveState('blacksmithCacheMirrorChanged', changed ? 'true' : 'false')
}

/**
 * Save the outcome of the main step's mirror sync.
 */
export function setBlacksmithCacheMirrorSyncFailed(failed: boolean) {
  core.saveState('blacksmithCacheMirrorSyncFailed', failed ? 'true' : 'false')
}

export function setBlacksmithCacheMirrorSyncTimedOut(timedOut: boolean) {
  core.saveState(
    'blacksmithCacheMirrorSyncTimedOut',
    timedOut ? 'true' : 'false'
  )
}

/**
 * Save whether the mirror sync was deferred to the POST action.
 */
export function setBlacksmithCacheMirrorSyncDeferred(deferred: boolean) {
  core.saveState(
    'blacksmithCacheMirrorSyncDeferred',
    deferred ? 'true' : 'false'
  )
}

/**
 * Save the repository URL so the POST action can sync the git mirror.
 */
export function setBlacksmithCacheRepoUrl(repoUrl: string) {
  core.saveState('blacksmithCacheRepoUrl', repoUrl)
}

/**
 * Save whether verbose output is enabled for git mirror operations.
 */
export function setBlacksmithCacheVerbose(verbose: boolean) {
  core.saveState('blacksmithCacheVerbose', verbose ? 'true' : 'false')
}

/**
 * Save the host's early commit denial reason so the POST action can skip the
 * commit and explain why.
 */
export function setBlacksmithCacheCommitEarlyDenyReason(reason: string) {
  core.saveState('blacksmithCacheCommitEarlyDenyReason', reason)
}

// Publish a variable so that when the POST action runs, it can determine it should run the cleanup logic.
// This is necessary since we don't have a separate entry point.
if (!IsPost) {
  core.saveState('isPost', 'true')
}
