/**
 * Why the post step skips the deferred mirror refresh, or '' to run it.
 *
 * Shallow checkouts defer the mirror refresh (ls-remote plus a fetch of
 * every changed branch and tag) to the post step. The refresh only pays off
 * when the sticky disk is committed afterwards, so it is skipped when the
 * host has already denied this job's commit (e.g. branch protection) or the
 * workflow opted out with `refresh-mirror: false`.
 */
export function deferredRefreshSkipReason(options: {
  refreshMirror: boolean
  commitEarlyDenyReason: string
}): string {
  if (!options.refreshMirror) {
    return 'refresh-mirror is false'
  }
  if (options.commitEarlyDenyReason) {
    return `commit denied for this job (${options.commitEarlyDenyReason})`
  }
  return ''
}

/** Parses the `refresh-mirror` input; anything but `false` keeps the default. */
export function parseRefreshMirrorInput(value: string): boolean {
  return value.trim().toUpperCase() !== 'FALSE'
}
