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
 * The repository URL for refreshing the git mirror in the POST action.
 */
export const BlacksmithCacheRepoUrl = core.getState('blacksmithCacheRepoUrl')

/**
 * Whether verbose output is enabled for git mirror operations in the POST action.
 */
export const BlacksmithCacheVerbose =
  core.getState('blacksmithCacheVerbose') === 'true'

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
 * Save the repository URL so the POST action can refresh the git mirror.
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

// Publish a variable so that when the POST action runs, it can determine it should run the cleanup logic.
// This is necessary since we don't have a separate entry point.
if (!IsPost) {
  core.saveState('isPost', 'true')
}
