import * as fs from 'fs'

/**
 * Detect whether we are running inside a container (e.g. a workflow job
 * with `container:` set). In container jobs the runner VM's block devices
 * and the runner's _diag directory are not accessible.
 */
export function isRunningInContainer(): boolean {
  // Check for /.dockerenv file (docker-specific).
  try {
    fs.accessSync('/.dockerenv')
    return true
  } catch {
    // Not a docker container, continue checking.
  }

  // Check cgroup for container indicators (works with cgroup v1).
  try {
    const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf-8')
    if (cgroup.includes('docker') || cgroup.includes('containerd')) {
      return true
    }
  } catch {
    // /proc/1/cgroup unreadable or doesn't exist, continue checking.
  }

  // For cgroup v2, check if working directory starts with /__w/.
  // This is GitHub Actions container-specific workspace mount.
  if (process.cwd().startsWith('/__w/')) {
    return true
  }

  return false
}
