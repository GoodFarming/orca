import { afterEach, describe, expect, it } from 'vitest'
import { isBrowserTabHostLockedToWorkspace, resolveBrowserTabHost } from './browser-tab-host'

const webClientFlag = globalThis as { __ORCA_WEB_CLIENT__?: boolean }

describe('resolveBrowserTabHost', () => {
  afterEach(() => {
    delete webClientFlag.__ORCA_WEB_CLIENT__
  })

  it('defaults desktop clients to local ownership', () => {
    expect(isBrowserTabHostLockedToWorkspace()).toBe(false)
    expect(resolveBrowserTabHost(undefined)).toBe('local')
  })

  it('honors the configured desktop host', () => {
    expect(resolveBrowserTabHost('workspace')).toBe('workspace')
  })

  it('keeps web clients runtime-owned', () => {
    webClientFlag.__ORCA_WEB_CLIENT__ = true

    expect(isBrowserTabHostLockedToWorkspace()).toBe(true)
    expect(resolveBrowserTabHost('local')).toBe('workspace')
  })
})
