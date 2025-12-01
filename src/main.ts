import * as core from '@actions/core'
import * as coreCommand from '@actions/core/lib/command'
import * as cacheHelper from './cache-helper'
import * as gitSourceProvider from './git-source-provider'
import * as inputHelper from './input-helper'
import * as path from 'path'
import * as stateHelper from './state-helper'

async function run(): Promise<void> {
  try {
    const sourceSettings = await inputHelper.getInputs()

    try {
      // Register problem matcher
      coreCommand.issueCommand(
        'add-matcher',
        {},
        path.join(__dirname, 'problem-matcher.json')
      )

      // Restore cache if enabled
      let cacheKey: string | undefined
      if (sourceSettings.cache) {
        cacheKey = cacheHelper.getCacheKey(
          sourceSettings.repositoryOwner,
          sourceSettings.repositoryName,
          sourceSettings.githubServerUrl
        )
        stateHelper.setCacheKey(cacheKey)
        stateHelper.setCacheEnabled(true)

        await cacheHelper.restoreCache(
          sourceSettings.repositoryPath,
          cacheKey
        )
      } else {
        stateHelper.setCacheEnabled(false)
      }

      // Get sources
      await gitSourceProvider.getSource(sourceSettings)
      core.setOutput('ref', sourceSettings.ref)

      // Determine if we should save cache
      if (sourceSettings.cache && cacheKey) {
        const shouldSave = await cacheHelper.shouldSaveCache(
          sourceSettings.cacheSave,
          sourceSettings.repositoryOwner,
          sourceSettings.repositoryName,
          sourceSettings.authToken,
          sourceSettings.githubServerUrl
        )
        stateHelper.setShouldSaveCache(shouldSave)
      }
    } finally {
      // Unregister problem matcher
      coreCommand.issueCommand('remove-matcher', {owner: 'checkout-git'}, '')
    }
  } catch (error) {
    core.setFailed(`${(error as any)?.message ?? error}`)
  }
}

async function cleanup(): Promise<void> {
  try {
    await gitSourceProvider.cleanup(stateHelper.RepositoryPath)

    // Save cache if enabled and should save
    if (
      stateHelper.CacheEnabled &&
      stateHelper.ShouldSaveCache &&
      stateHelper.CacheKey &&
      stateHelper.RepositoryPath
    ) {
      await cacheHelper.saveCache(
        stateHelper.RepositoryPath,
        stateHelper.CacheKey
      )
    }
  } catch (error) {
    core.warning(`${(error as any)?.message ?? error}`)
  }
}

// Main
if (!stateHelper.IsPost) {
  run()
}
// Post
else {
  cleanup()
}
