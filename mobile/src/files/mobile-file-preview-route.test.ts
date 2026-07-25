import { describe, expect, it } from 'vitest'
import {
  createMobileFilePreviewHref,
  createMobileFilePreviewSessionHref,
  displayNameFromPreviewPath,
  normalizeMobileFilePreviewRouteParams
} from './mobile-file-preview-route'

describe('mobile-file-preview-route', () => {
  it('normalizes valid route params without changing encoded-sensitive path characters', () => {
    const relativePath = 'docs/a #b?c%25 d\\note.md'
    const route = normalizeMobileFilePreviewRouteParams({
      hostId: 'host-1',
      worktreeId: 'wt-1',
      relativePath,
      name: 'note.md',
      worktreeName: 'Orca'
    })

    expect(route).toEqual({
      ok: true,
      params: {
        hostId: 'host-1',
        worktreeId: 'wt-1',
        relativePath,
        source: 'worktree',
        line: undefined,
        column: undefined,
        name: 'note.md',
        worktreeName: 'Orca'
      }
    })
  })

  it('normalizes worktree preview line and column params', () => {
    const route = normalizeMobileFilePreviewRouteParams({
      hostId: 'host-1',
      worktreeId: 'wt-1',
      relativePath: 'src/app.ts',
      line: '120',
      column: '7'
    })

    expect(route).toEqual({
      ok: true,
      params: {
        hostId: 'host-1',
        worktreeId: 'wt-1',
        relativePath: 'src/app.ts',
        source: 'worktree',
        line: '120',
        column: '7',
        name: undefined,
        worktreeName: undefined
      }
    })
  })

  it('normalizes terminal artifact params without requiring a relative path', () => {
    const route = normalizeMobileFilePreviewRouteParams({
      hostId: 'host-1',
      worktreeId: 'wt-1',
      source: 'terminalArtifact',
      absolutePath: '/tmp/result.json',
      grantId: 'grant-1',
      terminal: 'term-1',
      pathText: 'result.json',
      cwd: '/tmp/run',
      line: '12',
      column: '3'
    })

    expect(route).toEqual({
      ok: true,
      params: {
        hostId: 'host-1',
        worktreeId: 'wt-1',
        source: 'terminalArtifact',
        absolutePath: '/tmp/result.json',
        grantId: 'grant-1',
        terminal: 'term-1',
        pathText: 'result.json',
        cwd: '/tmp/run',
        line: '12',
        column: '3'
      }
    })
  })

  it('rejects missing, empty, or array-valued required params', () => {
    expect(normalizeMobileFilePreviewRouteParams({ hostId: 'h', worktreeId: 'w' })).toEqual({
      ok: false,
      message: 'Unable to load preview'
    })
    expect(
      normalizeMobileFilePreviewRouteParams({
        hostId: 'h',
        worktreeId: 'w',
        relativePath: ''
      })
    ).toEqual({ ok: false, message: 'Unable to load preview' })
    expect(
      normalizeMobileFilePreviewRouteParams({
        hostId: 'h',
        worktreeId: 'w',
        relativePath: ['a.ts', 'b.ts']
      })
    ).toEqual({ ok: false, message: 'Unable to load preview' })
  })

  it('builds the Expo href object so Expo owns URL encoding', () => {
    const relativePath = 'src/#hash ?query%20\\file.ts'

    expect(
      createMobileFilePreviewHref({
        hostId: 'host-1',
        worktreeId: 'wt-1',
        relativePath,
        name: 'file.ts'
      })
    ).toEqual({
      pathname: '/h/[hostId]/files/preview/[worktreeId]',
      params: {
        hostId: 'host-1',
        worktreeId: 'wt-1',
        relativePath,
        name: 'file.ts'
      }
    })
  })

  it('builds the existing session destination with encoded path and name values', () => {
    expect(
      createMobileFilePreviewSessionHref({
        hostId: 'host/one',
        worktreeId: 'repo::feature notes',
        worktreeName: 'Feature & notes'
      })
    ).toBe('/h/host%2Fone/session/repo%3A%3Afeature%20notes?name=Feature%20%26%20notes')

    expect(createMobileFilePreviewSessionHref({ hostId: 'host-1', worktreeId: 'wt-1' })).toBe(
      '/h/host-1/session/wt-1'
    )
  })

  it('derives display names from slash or backslash paths only for display', () => {
    expect(displayNameFromPreviewPath('src/app.ts')).toBe('app.ts')
    expect(displayNameFromPreviewPath('src\\app.ts')).toBe('app.ts')
  })
})
