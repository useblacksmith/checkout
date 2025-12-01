import * as cache from '@actions/cache'
import * as core from '@actions/core'
import * as github from '@actions/github'
import * as path from 'path'
import * as githubApiHelper from './github-api-helper'

/**
 * Generate a cache key for the git repository
 */
export function getCacheKey(
  owner: string,
  repo: string,
  githubServerUrl?: string
): string {
  const os = process.platform
  return `git-${os}-${owner}-${repo}`
}

/**
 * Restore the git directory from cache
 */
export async function restoreCache(
  repositoryPath: string,
  cacheKey: string
): Promise<string | undefined> {
  try {
    const gitDir = path.join(repositoryPath, '.git')
    core.info(`Attempting to restore git cache with key: ${cacheKey}`)

    // No fallback keys - we want exact match only to avoid cross-repo cache pollution
    const cacheKeyRestored = await cache.restoreCache([gitDir], cacheKey)

    if (cacheKeyRestored) {
      core.info(`Cache restored from key: ${cacheKeyRestored}`)
      return cacheKeyRestored
    } else {
      core.info('Cache not found')
      return undefined
    }
  } catch (error) {
    core.warning(`Failed to restore cache: ${(error as any)?.message ?? error}`)
    return undefined
  }
}

/**
 * Save the git directory to cache
 */
export async function saveCache(
  repositoryPath: string,
  cacheKey: string
): Promise<void> {
  try {
    const gitDir = path.join(repositoryPath, '.git')
    core.info(`Saving git cache with key: ${cacheKey}`)

    await cache.saveCache([gitDir], cacheKey)
    core.info(`Cache saved with key: ${cacheKey}`)
  } catch (error) {
    core.warning(`Failed to save cache: ${(error as any)?.message ?? error}`)
  }
}

/**
 * Determine if we should save the cache based on the current context
 */
export async function shouldSaveCache(
  cacheSaveMode: string,
  owner: string,
  repo: string,
  authToken: string,
  githubServerUrl?: string
): Promise<boolean> {
  const mode = cacheSaveMode.toLowerCase()

  if (mode === 'never') {
    return false
  }

  if (mode === 'always') {
    return true
  }

  // mode === 'auto' - only save on default branch pushes
  if (mode === 'auto') {
    const eventName = process.env['GITHUB_EVENT_NAME']
    const ref = process.env['GITHUB_REF']

    // Only save on push events
    if (eventName !== 'push') {
      core.debug(`Not saving cache: event is ${eventName}, not push`)
      return false
    }

    // Get the default branch
    try {
      const defaultBranch = await githubApiHelper.getDefaultBranch(
        authToken,
        owner,
        repo,
        githubServerUrl
      )

      // Check if we're on the default branch
      const isDefaultBranch = ref === defaultBranch
      core.debug(
        `Cache save check: ref=${ref}, defaultBranch=${defaultBranch}, shouldSave=${isDefaultBranch}`
      )

      return isDefaultBranch
    } catch (error) {
      core.warning(
        `Failed to determine default branch, not saving cache: ${(error as any)?.message ?? error}`
      )
      return false
    }
  }

  // Unknown mode, default to false
  core.warning(`Unknown cache-save mode: ${cacheSaveMode}, not saving cache`)
  return false
}
