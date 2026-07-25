import type { GlobalSettings } from '../../../shared/types'

export type BrowserTabHost = NonNullable<GlobalSettings['browserTabHost']>

/** Returns whether this client can own a local Electron browser surface. */
export function isBrowserTabHostLockedToWorkspace(): boolean {
  return (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ === true
}

/** Resolves the effective host while keeping paired web clients runtime-owned. */
export function resolveBrowserTabHost(
  configuredHost: GlobalSettings['browserTabHost']
): BrowserTabHost {
  return isBrowserTabHostLockedToWorkspace() ? 'workspace' : (configuredHost ?? 'local')
}
