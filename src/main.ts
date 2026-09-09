import * as core from '@actions/core'
import * as coreCommand from '@actions/core/lib/command'
import * as gitSourceProvider from './git-source-provider'
import * as inputHelper from './input-helper'
import * as path from 'path'
import * as stateHelper from './state-helper'
import * as blacksmithCache from './blacksmith-cache'
import {checkPreviousStepFailures} from './step-checker'
import {reportInternalMetric} from './internal-metrics'

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
  const repoName = stateHelper.BlacksmithCacheRepoName
  const mountPoint = stateHelper.BlacksmithCacheMountPoint
  const mirrorPath = stateHelper.BlacksmithCacheMirrorPath
  const performedHydration = stateHelper.BlacksmithCachePerformedHydration
  let mirrorChanged = stateHelper.BlacksmithCacheMirrorChanged
  let mirrorSyncFailed = stateHelper.BlacksmithCacheMirrorSyncFailed
  let mirrorSyncTimedOut = stateHelper.BlacksmithCacheMirrorSyncTimedOut
  if (exposeId && stickyDiskKey) {
    // For shallow checkouts the checkout step never populates the workspace
    // from mirror refs, so the mirror sync is deferred here to keep the
    // checkout step fast.
    if (stateHelper.BlacksmithCacheMirrorSyncDeferred && mirrorPath) {
      const repoUrl = stateHelper.BlacksmithCacheRepoUrl
      // Re-read auth token from input (don't store sensitive data in state)
      const authToken = core.getInput('token', {required: false})
      if (repoUrl && authToken) {
        core.startGroup('Syncing Blacksmith git mirror')
        const syncResult = await blacksmithCache.syncMirrorFromRemote(
          mirrorPath,
          repoUrl,
          authToken,
          stateHelper.BlacksmithCacheVerbose
        )
        mirrorChanged = syncResult.changed
        mirrorSyncFailed = !syncResult.success && !syncResult.timedOut
        mirrorSyncTimedOut = syncResult.timedOut
        core.endGroup()
      } else {
        core.warning(
          '[git-mirror] No auth token available, skipping mirror sync'
        )
      }
    }

    let cleanupResult: blacksmithCache.CleanupResult | undefined

    try {
      let shouldCommit = true
      let skipReason = ''

      const commitEarlyDenyReason =
        stateHelper.BlacksmithCacheCommitEarlyDenyReason
      if (commitEarlyDenyReason) {
        // The host already told us at mount time that this job's writes are
        // discarded, so there is nothing to persist and no need to inspect
        // step results.
        shouldCommit = false
        skipReason = `commit denied for this job (${commitEarlyDenyReason}); mirror changes are discarded`
      } else {
        // Check for previous step failures by reading runner logs
        // This is the same approach used by setup-docker-builder (BPA)
        core.info(
          '[git-mirror] Checking for previous step failures before committing'
        )
        const failureCheck = await checkPreviousStepFailures()

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
      }

      if (!shouldCommit) {
        core.warning(`[git-mirror] Skipping cache commit: ${skipReason}`)
        if (performedHydration) {
          core.warning(
            '[git-mirror] Initial hydration was performed but is not being committed - backend will delete entry for retry'
          )
        }
      } else {
        core.info('[git-mirror] No previous step failures detected')
      }

      // The mirror was synchronized with the remote in the main step. If it
      // was already up to date (no refs changed and no hydration), there is
      // nothing to persist - release the sticky disk without committing and
      // skip GC.
      if (shouldCommit && !mirrorChanged) {
        shouldCommit = false
        core.info(
          '[git-mirror] Mirror unchanged since last commit, releasing sticky disk without commit'
        )
      }

      // Only set vmHydratedGitMirror to true if we're committing AND we performed hydration
      const vmHydratedGitMirror = shouldCommit && performedHydration

      cleanupResult = await blacksmithCache.cleanup({
        exposeId,
        stickyDiskKey,
        repoName: repoName || undefined,
        mountPoint: mountPoint || undefined,
        mirrorPath: mirrorChanged ? mirrorPath || undefined : undefined,
        shouldCommit,
        vmHydratedGitMirror,
        mirrorSyncFailed,
        mirrorSyncTimedOut
      })
    } catch (error) {
      core.warning(
        `Failed to cleanup Blacksmith cache: ${(error as any)?.message ?? error}`
      )
    }

    // Report metrics for any failures/timeouts (fire-and-forget)
    if (mirrorSyncFailed || mirrorSyncTimedOut) {
      await reportInternalMetric('git_mirror_sync_failure', 1, {
        reason: mirrorSyncTimedOut ? 'timeout' : 'failure'
      })
    }
    if (cleanupResult) {
      if (!cleanupResult.gcResult.success) {
        await reportInternalMetric('git_mirror_gc_failure', 1, {
          reason: cleanupResult.gcResult.timedOut ? 'timeout' : 'failure'
        })
      }
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
