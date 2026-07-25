import type { GlobalSettings } from '../../../shared/types'

export type BrowserTabHost = NonNullable<GlobalSettings['browserTabHost']>

export function resolveBrowserTabHost(
  configuredHost: GlobalSettings['browserTabHost']
): BrowserTabHost {
  const isWebClient = (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ === true
  return isWebClient ? 'workspace' : (configuredHost ?? 'local')
}
