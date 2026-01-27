import * as core from '@actions/core'
import * as coreCommand from '@actions/core/lib/command'
import * as gitSourceProvider from './git-source-provider'
import * as inputHelper from './input-helper'
import * as path from 'path'
import * as stateHelper from './state-helper'
import * as blacksmithCache from './blacksmith-cache'
import {checkPreviousStepFailures} from './step-checker'

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

      // Get sources
      await gitSourceProvider.getSource(sourceSettings)
      core.setOutput('ref', sourceSettings.ref)
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
  } catch (error) {
    core.warning(`${(error as any)?.message ?? error}`)
  }

  // Cleanup Blacksmith git mirror cache (refresh mirror, run GC, unmount, and commit sticky disk)
  const exposeId = stateHelper.BlacksmithCacheExposeId
  const stickyDiskKey = stateHelper.BlacksmithCacheStickyDiskKey
  const mirrorPath = stateHelper.BlacksmithCacheMirrorPath
  const performedHydration = stateHelper.BlacksmithCachePerformedHydration
  const repoUrl = stateHelper.BlacksmithCacheRepoUrl
  const verbose = stateHelper.BlacksmithCacheVerbose
  if (exposeId && stickyDiskKey) {
    // Refresh the git mirror in the post step (outside the critical checkout path)
    // This updates the mirror for future runs without blocking the workflow
    if (mirrorPath && repoUrl && !performedHydration) {
      try {
        core.startGroup('Refreshing Blacksmith git mirror')
        // Re-read auth token from input (don't store sensitive data in state)
        const authToken = core.getInput('token', {required: false})
        if (authToken) {
          await blacksmithCache.refreshMirror(
            mirrorPath,
            repoUrl,
            authToken,
            verbose
          )
        } else {
          core.warning(
            '[git-mirror] No auth token available, skipping mirror refresh'
          )
        }
        core.endGroup()
      } catch (error) {
        core.endGroup()
        core.warning(
          `[git-mirror] Failed to refresh mirror: ${(error as any)?.message ?? error}`
        )
      }
    }

    try {
      // Check for previous step failures by reading runner logs
      // This is the same approach used by setup-docker-builder (BPA)
      core.info(
        '[git-mirror] Checking for previous step failures before committing'
      )
      const failureCheck = await checkPreviousStepFailures()

      let shouldCommit = true
      let skipReason = ''

      if (failureCheck.error) {
        // If we can't determine failure status, skip commit to be safe
        shouldCommit = false
        skipReason = `Unable to check for step failures: ${failureCheck.error}`
      } else if (failureCheck.hasFailures) {
        shouldCommit = false
        skipReason = `Found ${failureCheck.failedCount} failed/cancelled steps`
        if (failureCheck.failedSteps) {
          for (const step of failureCheck.failedSteps) {
            core.warning(
              `[git-mirror]   - Step: ${step.stepName || step.action || 'unknown'} (${step.result})`
            )
          }
        }
      }

      // Only set vmHydratedGitMirror to true if we're committing AND we performed hydration
      const vmHydratedGitMirror = shouldCommit && performedHydration

      if (!shouldCommit) {
        core.warning(`[git-mirror] Skipping cache commit: ${skipReason}`)
        if (performedHydration) {
          core.warning(
            '[git-mirror] Initial hydration was in progress but job failed - backend will delete entry for retry'
          )
        }
      } else {
        core.info('[git-mirror] No previous step failures detected')
      }

      await blacksmithCache.cleanup({
        exposeId,
        stickyDiskKey,
        mirrorPath: mirrorPath || undefined,
        shouldCommit,
        vmHydratedGitMirror
      })
    } catch (error) {
      core.warning(
        `Failed to cleanup Blacksmith cache: ${(error as any)?.message ?? error}`
      )
    }
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
