import * as core from '@actions/core'
import * as http from 'http'

const METRICS_PORT = process.env.BLACKSMITH_METRICS_HTTP_PORT || ''
const VM_ID = process.env.BLACKSMITH_VM_ID || ''
const AGENT_IP = '192.168.127.1'

/**
 * Report an internal metric to the Blacksmith agent.
 * Fire-and-forget: errors are logged but never thrown.
 */
export async function reportInternalMetric(
  metricType: string,
  value: number,
  attributes: Record<string, string>
): Promise<void> {
  if (!METRICS_PORT) {
    core.debug(
      '[metrics] BLACKSMITH_METRICS_HTTP_PORT not set, skipping metric'
    )
    return
  }

  const payload = JSON.stringify({
    metric_type: metricType,
    value,
    vm_id: VM_ID,
    attributes
  })

  try {
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          hostname: AGENT_IP,
          port: Number(METRICS_PORT),
          path: '/internal',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
          },
          timeout: 5000
        },
        res => {
          // Drain response
          res.resume()
          res.on('end', () => resolve())
        }
      )
      req.on('error', reject)
      req.on('timeout', () => {
        req.destroy()
        reject(new Error('metrics request timed out'))
      })
      req.write(payload)
      req.end()
    })
    core.debug(`[metrics] Reported ${metricType} metric`)
  } catch (error) {
    core.debug(
      `[metrics] Failed to report ${metricType}: ${(error as Error).message}`
    )
  }
}
