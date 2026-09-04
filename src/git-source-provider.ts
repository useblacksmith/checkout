import * as core from '@actions/core'
import * as fsHelper from './fs-helper'
import * as gitAuthHelper from './git-auth-helper'
import * as gitCommandManager from './git-command-manager'
import * as gitDirectoryHelper from './git-directory-helper'
import * as githubApiHelper from './github-api-helper'
import * as io from '@actions/io'
import * as path from 'path'
import * as refHelper from './ref-helper'
import * as stateHelper from './state-helper'
import * as urlHelper from './url-helper'
import * as blacksmithCache from './blacksmith-cache'
import * as mirrorTelemetry from './mirror-telemetry'
import {
  FetchOptions,
  MinimumGitAlternateRefsCommandVersion,
  MinimumGitSparseCheckoutVersion,
  IGitCommandManager
} from './git-command-manager'
import {IGitSourceSettings} from './git-source-settings'

export async function getSource(settings: IGitSourceSettings): Promise<void> {
  // Structured checkout telemetry, reported to the Blacksmith agent at the
  // end of the main step. Fail-soft: measurement or reporting problems only
  // degrade the report, never the checkout.
  const report = mirrorTelemetry.newCheckoutReport()
  const totalStart = Date.now()
  let hydrationReport: mirrorTelemetry.HydrationReport | null = null
  try {
    await getSourceInner(settings, report, r => {
      hydrationReport = r
    })
    report.outcome = 'success'
  } catch (error) {
    report.outcome = 'failure'
    // Overwrite any recovered fallback error class: on failure the class must
    // describe the error that actually failed the checkout.
    report.error_class = mirrorTelemetry.classifyError(error)
    throw error
  } finally {
    report.total_ms = Date.now() - totalStart
    if (blacksmithCache.isBlacksmithEnvironment()) {
      if (hydrationReport) {
        await mirrorTelemetry.reportHydration(hydrationReport)
      }
      await mirrorTelemetry.reportCheckout(report)
    }
  }
}

async function getSourceInner(
  settings: IGitSourceSettings,
  report: mirrorTelemetry.CheckoutReport,
  onHydrationReport: (r: mirrorTelemetry.HydrationReport) => void
): Promise<void> {
  // Repository URL
  core.info(
    `Syncing repository: ${settings.repositoryOwner}/${settings.repositoryName}`
  )
  const repositoryUrl = urlHelper.getFetchUrl(settings)

  // Remove conflicting file path
  if (fsHelper.fileExistsSync(settings.repositoryPath)) {
    await io.rmRF(settings.repositoryPath)
  }

  // Create directory
  let isExisting = true
  if (!fsHelper.directoryExistsSync(settings.repositoryPath)) {
    isExisting = false
    await io.mkdirP(settings.repositoryPath)
  }

  // Git command manager
  core.startGroup('Getting Git version info')
  const git = await getGitCommandManager(settings)
  core.endGroup()

  let authHelper: gitAuthHelper.IGitAuthHelper | null = null
  try {
    if (git) {
      authHelper = gitAuthHelper.createAuthHelper(git, settings)
      if (settings.setSafeDirectory) {
        // Setup the repository path as a safe directory, so if we pass this into a container job with a different user it doesn't fail
        // Otherwise all git commands we run in a container fail
        await authHelper.configureTempGlobalConfig()
        core.info(
          `Adding repository directory to the temporary git global config as a safe directory`
        )

        await git
          .config('safe.directory', settings.repositoryPath, true, true)
          .catch(error => {
            core.info(
              `Failed to initialize safe directory with error: ${error}`
            )
          })

        stateHelper.setSafeDirectory()
      }
    }

    // Prepare existing directory, otherwise recreate
    if (isExisting) {
      await gitDirectoryHelper.prepareExistingDirectory(
        git,
        settings.repositoryPath,
        repositoryUrl,
        settings.clean,
        settings.ref
      )
    }

    if (!git) {
      // Downloading using REST API
      core.info(`The repository will be downloaded using the GitHub REST API`)
      core.info(
        `To create a local Git repository instead, add Git ${gitCommandManager.MinimumGitVersion} or higher to the PATH`
      )
      if (settings.submodules) {
        throw new Error(
          `Input 'submodules' not supported when falling back to download using the GitHub REST API. To create a local Git repository instead, add Git ${gitCommandManager.MinimumGitVersion} or higher to the PATH.`
        )
      } else if (settings.sshKey) {
        throw new Error(
          `Input 'ssh-key' not supported when falling back to download using the GitHub REST API. To create a local Git repository instead, add Git ${gitCommandManager.MinimumGitVersion} or higher to the PATH.`
        )
      }

      await githubApiHelper.downloadRepository(
        settings.authToken,
        settings.repositoryOwner,
        settings.repositoryName,
        settings.ref,
        settings.commit,
        settings.repositoryPath,
        settings.githubServerUrl
      )
      return
    }

    // Save state for POST action
    stateHelper.setRepositoryPath(settings.repositoryPath)

    // Setup Blacksmith git mirror cache if in Blacksmith environment.
    // shouldUseBlacksmithCache() honors the BLACKSMITH_BYPASS_CHECKOUT
    // kill switch (driven by the per-installation flag in the control plane),
    // so flipping that flag disables the entire Blacksmith code path here
    // and in the post step.
    let cacheInfo: blacksmithCache.CacheInfo | null = null
    // mirrorFresh indicates the mirror's branch/tag refs match the remote as
    // of this run (hydrated now, or synced via ls-remote diff). Only then can
    // the workspace copy its refs from the mirror instead of the network.
    let mirrorFresh = false
    report.sticky_disk_key = blacksmithCache.stickyDiskKeyFor(
      settings.repositoryOwner,
      settings.repositoryName
    )
    report.shallow = settings.fetchDepth > 0
    report.filter = !!settings.filter || settings.sparseCheckout != null
    report.submodules_enabled = settings.submodules
    report.lfs_enabled = settings.lfs
    if (blacksmithCache.shouldUseBlacksmithCache()) {
      const setupStart = Date.now()
      try {
        core.startGroup('Setting up Blacksmith git mirror cache')
        cacheInfo = await blacksmithCache.setupCache(
          settings.repositoryOwner,
          settings.repositoryName
        )
        report.sticky_disk_setup_ms = Date.now() - setupStart

        // Check if hydration is in progress - another job is doing the initial git clone --mirror
        if (cacheInfo.hydrationInProgress) {
          // Warning already logged by setupCache, just fall back to standard checkout
          report.serving_mode = 'fallback-contention'
          cacheInfo = null
          core.endGroup()
        } else {
          // Save state early so cleanup can call commitStickyDisk even if ensureMirror fails
          stateHelper.setBlacksmithCacheExposeId(cacheInfo.exposeId)
          stateHelper.setBlacksmithCacheStickyDiskKey(cacheInfo.stickyDiskKey)
          stateHelper.setBlacksmithCacheRepoName(cacheInfo.repoName)
          stateHelper.setBlacksmithCacheMirrorPath(cacheInfo.mirrorPath)
          stateHelper.setBlacksmithCacheMountPoint(cacheInfo.mountPoint)

          const mirrorExisted = fsHelper.directoryExistsSync(
            cacheInfo.mirrorPath
          )
          const cloneStart = Date.now()
          let performedHydration = false
          try {
            performedHydration = await blacksmithCache.ensureMirror(
              cacheInfo.mirrorPath,
              repositoryUrl,
              settings.authToken,
              settings.verbose
            )
          } catch (error) {
            if (!mirrorExisted) {
              onHydrationReport({
                sticky_disk_key: cacheInfo.stickyDiskKey,
                clone_ms: Date.now() - cloneStart,
                clone_bytes: 0,
                ref_count: 0,
                outcome: 'failure',
                error_class: mirrorTelemetry.classifyError(error)
              })
            }
            throw error
          }
          if (performedHydration) {
            report.serving_mode = 'hydrating'
            onHydrationReport({
              sticky_disk_key: cacheInfo.stickyDiskKey,
              clone_ms: Date.now() - cloneStart,
              clone_bytes: await mirrorTelemetry.dirSizeBytes(
                cacheInfo.mirrorPath
              ),
              ref_count: await mirrorTelemetry.refCount(cacheInfo.mirrorPath),
              outcome: 'success'
            })
          } else {
            report.serving_mode = 'mirror'
          }
          stateHelper.setBlacksmithCachePerformedHydration(performedHydration)

          if (performedHydration) {
            // A freshly-cloned mirror is exactly the remote's current state
            mirrorFresh = true
            stateHelper.setBlacksmithCacheMirrorChanged(true)
          } else if (settings.fetchDepth <= 0) {
            // Bring the mirror's branch/tag refs up to date with the remote
            // (ls-remote diff + targeted fetch of only the changed refs), so
            // the workspace can be populated from the mirror with the same
            // freshness as a direct network fetch.
            const syncResult = await blacksmithCache.syncMirrorFromRemote(
              cacheInfo.mirrorPath,
              repositoryUrl,
              settings.authToken,
              settings.verbose
            )
            mirrorFresh = syncResult.success
            if (!syncResult.skipped) {
              // Structured refresh row (fire-and-forget; errors swallowed).
              await mirrorTelemetry.reportMaintenance(
                mirrorTelemetry.maintenanceRunFromResult(
                  'refresh',
                  cacheInfo.stickyDiskKey,
                  syncResult
                )
              )
            }
            stateHelper.setBlacksmithCacheMirrorChanged(syncResult.changed)
            stateHelper.setBlacksmithCacheMirrorSyncFailed(
              !syncResult.success && !syncResult.timedOut
            )
            stateHelper.setBlacksmithCacheMirrorSyncTimedOut(
              syncResult.timedOut
            )
          } else {
            // Shallow checkouts never populate the workspace from mirror
            // refs, so the checkout step doesn't need a fresh mirror. Defer
            // the mirror sync to the post step to keep the checkout step
            // fast.
            stateHelper.setBlacksmithCacheMirrorSyncDeferred(true)
            stateHelper.setBlacksmithCacheRepoUrl(repositoryUrl)
            stateHelper.setBlacksmithCacheVerbose(settings.verbose)
          }
          core.endGroup()
        }
      } catch (error) {
        core.endGroup()
        core.warning(
          `Blacksmith cache setup failed, using standard checkout: ${error}`
        )
        // Stamp the setup duration only when setupCache itself failed; later
        // failures (e.g. the hydration clone) are not sticky-disk setup time.
        if (report.sticky_disk_setup_ms === 0) {
          report.sticky_disk_setup_ms = Date.now() - setupStart
        }
        report.serving_mode = 'fallback-error'
        report.error_class = mirrorTelemetry.classifyError(error)
        // Don't clear cacheInfo.exposeId/stickyDiskKey from state - they're already saved
        // so cleanup can still call commitStickyDisk with shouldCommit: false
        cacheInfo = null
      }
    }

    // Initialize the repository
    if (
      !fsHelper.directoryExistsSync(path.join(settings.repositoryPath, '.git'))
    ) {
      core.startGroup('Initializing the repository')
      const initStart = Date.now()
      await git.init()
      // Setup alternates to use objects from Blacksmith mirror if available
      if (cacheInfo) {
        await blacksmithCache.writeAlternates(
          settings.repositoryPath,
          cacheInfo.mirrorPath
        )
      }
      await git.remoteAdd('origin', repositoryUrl)
      if (cacheInfo) {
        report.clone_from_mirror_ms += Date.now() - initStart
      }
      core.endGroup()
    }

    // Disable automatic garbage collection
    core.startGroup('Disabling automatic garbage collection')
    if (!(await git.tryDisableAutomaticGarbageCollection())) {
      core.warning(
        `Unable to turn off git automatic garbage collection. The git fetch operation may trigger garbage collection and cause a delay.`
      )
    }
    core.endGroup()

    // If we didn't initialize it above, do it now
    if (!authHelper) {
      authHelper = gitAuthHelper.createAuthHelper(git, settings)
    }
    // Configure auth
    core.startGroup('Setting up auth')
    await authHelper.configureAuth()
    core.endGroup()

    // Determine the default branch
    if (!settings.ref && !settings.commit) {
      core.startGroup('Determining the default branch')
      if (settings.sshKey) {
        settings.ref = await git.getDefaultBranch(repositoryUrl)
      } else {
        settings.ref = await githubApiHelper.getDefaultBranch(
          settings.authToken,
          settings.repositoryOwner,
          settings.repositoryName,
          settings.githubServerUrl
        )
      }
      core.endGroup()
    }

    // LFS install
    if (settings.lfs) {
      await git.lfsInstall()
    }

    // Fetch
    core.startGroup('Fetching the repository')
    const objectsDir = path.join(settings.repositoryPath, '.git', 'objects')
    const objectsBytesBefore = cacheInfo
      ? await mirrorTelemetry.dirSizeBytesOrNull(objectsDir)
      : null
    const fetchStart = Date.now()
    const fetchOptions: FetchOptions = {}

    if (settings.filter) {
      fetchOptions.filter = settings.filter
    } else if (settings.sparseCheckout) {
      fetchOptions.filter = 'blob:none'
    }

    if (settings.fetchDepth <= 0) {
      // When the Blacksmith mirror is available and synced with the remote,
      // copy branch/tag refs from it locally (objects are already shared via
      // alternates) instead of doing a full +refs/heads/* fetch over the
      // network, and only ask the network for the specific ref/commit this
      // run needs.
      let fetchedFromMirror = false
      if (
        cacheInfo &&
        mirrorFresh &&
        !fetchOptions.filter &&
        !fsHelper.fileExistsSync(
          path.join(settings.repositoryPath, '.git', 'shallow')
        )
      ) {
        fetchedFromMirror = await blacksmithCache.fetchRefsFromMirror(
          settings.repositoryPath,
          cacheInfo.mirrorPath
        )
      }

      if (fetchedFromMirror) {
        // The mirror copy only materializes branches and tags. Any other ref
        // (refs/pull/*, etc.) must be fetched from the network so its local
        // destination ref exists for checkout. For branches/tags, verify the
        // wanted ref/commit is present and fetch it directly if not.
        const upperRef = (settings.ref || '').toUpperCase()
        const coveredByMirror =
          !settings.ref ||
          !upperRef.startsWith('REFS/') ||
          upperRef.startsWith('REFS/HEADS/') ||
          upperRef.startsWith('REFS/TAGS/')
        let verified = false
        if (coveredByMirror) {
          verified = await refHelper.testRef(git, settings.ref, settings.commit)
          if (verified && settings.commit) {
            verified = await git.shaExists(settings.commit)
          }
        }
        if (!verified) {
          const refSpec = refHelper.getRefSpec(settings.ref, settings.commit)
          await git.fetch(refSpec, fetchOptions)
        }
      } else {
        // Fetch all branches and tags
        let refSpec = refHelper.getRefSpecForAllHistory(
          settings.ref,
          settings.commit
        )
        await git.fetch(refSpec, fetchOptions)

        // When all history is fetched, the ref we're interested in may have moved to a different
        // commit (push or force push). If so, fetch again with a targeted refspec.
        if (!(await refHelper.testRef(git, settings.ref, settings.commit))) {
          refSpec = refHelper.getRefSpec(settings.ref, settings.commit)
          await git.fetch(refSpec, fetchOptions)
        }
      }
    } else {
      fetchOptions.fetchDepth = settings.fetchDepth
      fetchOptions.fetchTags = settings.fetchTags
      // With the mirror attached as an alternate, git would treat every
      // mirror ref as a known tip: the deepening fetch's connectivity check
      // walks the whole mirror object graph and negotiation offers every
      // mirror ref. Turn alternate ref discovery off and offer a few mirror
      // tips explicitly instead, so the server still sends only the delta
      // from the mirror (see resolveShallowNegotiationTips).
      if (
        cacheInfo &&
        (await git.version()).checkMinimum(
          MinimumGitAlternateRefsCommandVersion
        ) &&
        (await blacksmithCache.sharesMirrorObjects(
          settings.repositoryPath,
          cacheInfo.mirrorPath
        ))
      ) {
        fetchOptions.ignoreAlternateRefs = true
        fetchOptions.negotiationTips =
          await blacksmithCache.resolveShallowNegotiationTips(
            cacheInfo.mirrorPath,
            settings.ref,
            process.env['GITHUB_BASE_REF'] || ''
          )
        core.info(
          `[git-mirror] Shallow fetch negotiating from ${fetchOptions.negotiationTips.length} mirror tip(s) with alternate ref discovery disabled`
        )
      }
      const refSpec = refHelper.getRefSpec(settings.ref, settings.commit)
      await git.fetch(refSpec, fetchOptions)
    }
    if (cacheInfo) {
      // Mirror-served: the fetch pulls only the delta the mirror is missing.
      report.delta_fetch_ms = Date.now() - fetchStart
      const objectsBytesAfter =
        await mirrorTelemetry.dirSizeBytesOrNull(objectsDir)
      report.delta_fetch_bytes =
        objectsBytesBefore !== null && objectsBytesAfter !== null
          ? Math.max(0, objectsBytesAfter - objectsBytesBefore)
          : 0
      report.mirror_size_bytes = await mirrorTelemetry.dirSizeBytes(
        cacheInfo.mirrorPath
      )
      report.ref_count = await mirrorTelemetry.refCount(cacheInfo.mirrorPath)
    } else {
      // Fallback/bypass: the fetch is the full checkout cost.
      report.full_checkout_ms = Date.now() - fetchStart
    }
    core.endGroup()

    // Checkout info
    core.startGroup('Determining the checkout info')
    const checkoutInfo = await refHelper.getCheckoutInfo(
      git,
      settings.ref,
      settings.commit
    )
    core.endGroup()

    // LFS fetch
    // Explicit lfs-fetch to avoid slow checkout (fetches one lfs object at a time).
    // Explicit lfs fetch will fetch lfs objects in parallel.
    // For sparse checkouts, let `checkout` fetch the needed objects lazily.
    if (settings.lfs && !settings.sparseCheckout) {
      core.startGroup('Fetching LFS objects')
      const lfsStart = Date.now()
      await git.lfsFetch(checkoutInfo.startPoint || checkoutInfo.ref)
      report.lfs_ms = Date.now() - lfsStart
      core.endGroup()
    }

    // Sparse checkout
    if (!settings.sparseCheckout) {
      let gitVersion = await git.version()
      // no need to disable sparse-checkout if the installed git runtime doesn't even support it.
      if (gitVersion.checkMinimum(MinimumGitSparseCheckoutVersion)) {
        await git.disableSparseCheckout()
      }
    } else {
      core.startGroup('Setting up sparse checkout')
      if (settings.sparseCheckoutConeMode) {
        await git.sparseCheckout(settings.sparseCheckout)
      } else {
        await git.sparseCheckoutNonConeMode(settings.sparseCheckout)
      }
      core.endGroup()
    }

    // Checkout
    core.startGroup('Checking out the ref')
    const checkoutStart = Date.now()
    await git.checkout(checkoutInfo.ref, checkoutInfo.startPoint)
    if (cacheInfo) {
      // Materializing the working tree reads objects from the mirror through
      // alternates — the second half of the clone-from-mirror cost.
      report.clone_from_mirror_ms += Date.now() - checkoutStart
    } else {
      // Fallback/bypass: working-tree materialization is part of the full
      // checkout cost, keeping phase totals comparable across serving modes.
      report.full_checkout_ms += Date.now() - checkoutStart
    }
    core.endGroup()

    // Dissociate from Blacksmith mirror if requested
    // This copies all objects from alternates into the local repo so it's independent
    if (settings.dissociate && cacheInfo) {
      core.startGroup('Dissociating from Blacksmith mirror')
      await blacksmithCache.dissociate(settings.repositoryPath)
      core.endGroup()
    }

    // Submodules
    if (settings.submodules) {
      const submodulesStart = Date.now()
      // Temporarily override global config
      core.startGroup('Setting up auth for fetching submodules')
      await authHelper.configureGlobalAuth()
      core.endGroup()

      // Checkout submodules
      core.startGroup('Fetching submodules')
      await git.submoduleSync(settings.nestedSubmodules)
      await git.submoduleUpdate(settings.fetchDepth, settings.nestedSubmodules)
      await git.submoduleForeach(
        'git config --local gc.auto 0',
        settings.nestedSubmodules
      )
      core.endGroup()

      // Persist credentials
      if (settings.persistCredentials) {
        core.startGroup('Persisting credentials for submodules')
        await authHelper.configureSubmoduleAuth()
        core.endGroup()
      }
      report.submodules_ms = Date.now() - submodulesStart
    }

    // Get commit information
    const commitInfo = await git.log1()

    // Log commit sha
    const commitSHA = await git.log1('--format=%H')
    core.setOutput('commit', commitSHA.trim())

    // Check for incorrect pull request merge commit
    await refHelper.checkCommitInfo(
      settings.authToken,
      commitInfo,
      settings.repositoryOwner,
      settings.repositoryName,
      settings.ref,
      settings.commit,
      settings.githubServerUrl
    )
  } finally {
    // Remove auth
    if (authHelper) {
      if (!settings.persistCredentials) {
        core.startGroup('Removing auth')
        await authHelper.removeAuth()
        core.endGroup()
      }
      authHelper.removeGlobalConfig()
    }
  }
}

export async function cleanup(repositoryPath: string): Promise<void> {
  // Repo exists?
  if (
    !repositoryPath ||
    !fsHelper.fileExistsSync(path.join(repositoryPath, '.git', 'config'))
  ) {
    return
  }

  let git: IGitCommandManager
  try {
    git = await gitCommandManager.createCommandManager(
      repositoryPath,
      false,
      false
    )
  } catch {
    return
  }

  // Remove auth
  const authHelper = gitAuthHelper.createAuthHelper(git)
  try {
    if (stateHelper.PostSetSafeDirectory) {
      // Setup the repository path as a safe directory, so if we pass this into a container job with a different user it doesn't fail
      // Otherwise all git commands we run in a container fail
      await authHelper.configureTempGlobalConfig()
      core.info(
        `Adding repository directory to the temporary git global config as a safe directory`
      )

      await git
        .config('safe.directory', repositoryPath, true, true)
        .catch(error => {
          core.info(`Failed to initialize safe directory with error: ${error}`)
        })
    }

    await authHelper.removeAuth()
  } finally {
    await authHelper.removeGlobalConfig()
  }
}

async function getGitCommandManager(
  settings: IGitSourceSettings
): Promise<IGitCommandManager | undefined> {
  core.info(`Working directory is '${settings.repositoryPath}'`)
  try {
    return await gitCommandManager.createCommandManager(
      settings.repositoryPath,
      settings.lfs,
      settings.sparseCheckout != null
    )
  } catch (err) {
    // Git is required for LFS
    if (settings.lfs) {
      throw err
    }

    // Otherwise fallback to REST API
    return undefined
  }
}
