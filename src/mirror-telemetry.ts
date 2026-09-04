import * as core from '@actions/core'
import * as exec from '@actions/exec'
import {reportStructuredMetric} from './internal-metrics'

/**
 * Structured git-mirror telemetry reported to the Blacksmith agent over the
 * existing /internal channel. Payloads stay dumb: raw measurements plus
 * closed-enum outcomes; all identity stamping and derivation happen
 * agent-side. Everything here inherits the fail-soft contract —
 * fire-and-forget with a hard timeout, every error swallowed — so telemetry
 * can never fail a customer job.
 */

export type ServingMode =
  | 'mirror'
  | 'hydrating'
  | 'fallback-contention'
  | 'fallback-error'
  | 'bypass'

export type Outcome = 'success' | 'failure' | 'timeout'

/**
 * Field names match the fa agent's internalmetric.CheckoutReport JSON tags.
 * sticky_disk_key names the mirror the checkout targeted even when no disk
 * was exposed (fallback/bypass), so rows stay attributable per repository.
 */
export interface CheckoutReport {
  serving_mode: ServingMode
  outcome: Outcome
  error_class?: string
  sticky_disk_key: string

  sticky_disk_setup_ms: number
  clone_from_mirror_ms: number
  delta_fetch_ms: number
  delta_fetch_bytes: number
  full_checkout_ms: number
  submodules_ms: number
  lfs_ms: number
  total_ms: number

  mirror_size_bytes: number
  ref_count: number

  shallow: boolean
  filter: boolean
  submodules_enabled: boolean
  lfs_enabled: boolean
}

/** Field names match the fa agent's internalmetric.HydrationReport JSON tags. */
export interface HydrationReport {
  sticky_disk_key: string
  clone_ms: number
  clone_bytes: number
  ref_count: number
  outcome: Outcome
  error_class?: string
}

/** Field names match the fa agent's internalmetric.MaintenanceRun JSON tags. */
export interface MaintenanceRun {
  op: 'refresh' | 'gc' | 'fsck'
  sticky_disk_key: string
  duration_ms: number
  bytes: number
  outcome: Outcome
  error_class?: string
  mirror_size_bytes: number
}

/**
 * Build a maintenance row from an operation result. Measurement fields are
 * best-effort and default to 0 when the operation didn't record them.
 */
export function maintenanceRunFromResult(
  op: MaintenanceRun['op'],
  stickyDiskKey: string,
  result: {
    success: boolean
    timedOut: boolean
    error?: string
    durationMs?: number
    bytes?: number
    mirrorSizeBytes?: number
  }
): MaintenanceRun {
  const run: MaintenanceRun = {
    op,
    sticky_disk_key: stickyDiskKey,
    duration_ms: result.durationMs ?? 0,
    bytes: result.bytes ?? 0,
    outcome: result.success
      ? 'success'
      : result.timedOut
        ? 'timeout'
        : 'failure',
    mirror_size_bytes: result.mirrorSizeBytes ?? 0
  }
  if (!result.success && result.error) {
    run.error_class = result.timedOut ? 'timeout' : 'error'
  }
  return run
}

export function newCheckoutReport(): CheckoutReport {
  return {
    serving_mode: 'bypass',
    outcome: 'failure',
    sticky_disk_key: '',
    sticky_disk_setup_ms: 0,
    clone_from_mirror_ms: 0,
    delta_fetch_ms: 0,
    delta_fetch_bytes: 0,
    full_checkout_ms: 0,
    submodules_ms: 0,
    lfs_ms: 0,
    total_ms: 0,
    mirror_size_bytes: 0,
    ref_count: 0,
    shallow: false,
    filter: false,
    submodules_enabled: false,
    lfs_enabled: false
  }
}

// Hard cap on the `du` walk so a wedged or slow disk can never stall the
// job on a measurement — the walk is telemetry, not work.
const DIR_SIZE_TIMEOUT_SECS = 15

/**
 * Directory size in bytes via `du -sb` (time-capped). Returns null on any
 * failure so callers can tell "unmeasurable" apart from a real size — a
 * missing byte count degrades the report, never the job.
 */
export async function dirSizeBytesOrNull(dir: string): Promise<number | null> {
  try {
    const result = await exec.getExecOutput(
      'timeout',
      [String(DIR_SIZE_TIMEOUT_SECS), 'du', '-sb', dir],
      {
        ignoreReturnCode: true,
        silent: true
      }
    )
    if (result.exitCode !== 0) {
      return null
    }
    const size = parseInt(result.stdout.trim().split(/\s+/)[0], 10)
    return isNaN(size) || size < 0 ? null : size
  } catch {
    return null
  }
}

/** Directory size in bytes, or 0 when it cannot be measured. */
export async function dirSizeBytes(dir: string): Promise<number> {
  return (await dirSizeBytesOrNull(dir)) ?? 0
}

/** Ref count of a git repository. Returns 0 on any failure. */
export async function refCount(gitDir: string): Promise<number> {
  try {
    const result = await exec.getExecOutput('git', ['-C', gitDir, 'show-ref'], {
      ignoreReturnCode: true,
      silent: true
    })
    if (result.exitCode !== 0) {
      return 0
    }
    const out = result.stdout.trim()
    return out === '' ? 0 : out.split('\n').length
  } catch {
    return 0
  }
}

/** Short closed-ish error class from an unknown error; never customer data. */
export function classifyError(error: unknown): string {
  if (error instanceof Error && error.name && error.name !== 'Error') {
    return error.name
  }
  return 'error'
}

export async function reportCheckout(report: CheckoutReport): Promise<void> {
  try {
    await reportStructuredMetric('git_mirror_checkout_report', report)
  } catch (error) {
    core.debug(
      `[git-mirror] checkout report failed: ${(error as Error).message}`
    )
  }
}

export async function reportHydration(report: HydrationReport): Promise<void> {
  try {
    await reportStructuredMetric('git_mirror_hydration_report', report)
  } catch (error) {
    core.debug(
      `[git-mirror] hydration report failed: ${(error as Error).message}`
    )
  }
}

export async function reportMaintenance(run: MaintenanceRun): Promise<void> {
  try {
    await reportStructuredMetric('git_mirror_maintenance_run', run)
  } catch (error) {
    core.debug(
      `[git-mirror] maintenance report failed: ${(error as Error).message}`
    )
  }
}
