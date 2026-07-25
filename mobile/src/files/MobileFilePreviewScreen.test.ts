import { describe, expect, it } from 'vitest'
import { sourceKeyForPreview } from './mobile-file-preview-source'
import {
  hasUnsavedMobileTerminalArtifactDraft,
  isEditableMobileTerminalArtifactPreview,
  isOpenableMobileWorktreeFilePreview,
  shouldKeepDirtyDraftOnPreviewLoadResult
} from './mobile-file-preview-editability'

describe('MobileFilePreviewScreen', () => {
  it('treats empty terminal artifact text previews as editable', () => {
    expect(isEditableMobileTerminalArtifactPreview({ status: 'empty', kind: 'text' })).toBe(true)
    expect(
      isEditableMobileTerminalArtifactPreview({
        status: 'ready',
        kind: 'text',
        content: '',
        truncated: false,
        byteLength: 0
      })
    ).toBe(true)
    expect(
      isEditableMobileTerminalArtifactPreview({
        status: 'ready',
        kind: 'image',
        dataUri: 'data:image/png;base64,aW1n'
      })
    ).toBe(false)
  })

  it('treats truncated terminal artifact text previews as read-only', () => {
    expect(
      isEditableMobileTerminalArtifactPreview({
        status: 'ready',
        kind: 'text',
        content: 'partial',
        truncated: true,
        byteLength: 1024
      })
    ).toBe(false)
  })

  it('offers Open for worktree text, code, HTML, and Markdown previews', () => {
    expect(
      isOpenableMobileWorktreeFilePreview('worktree', {
        status: 'ready',
        kind: 'markdown',
        content: '# Notes',
        truncated: false,
        byteLength: 7
      })
    ).toBe(true)
    expect(
      isOpenableMobileWorktreeFilePreview('worktree', {
        status: 'empty',
        kind: 'markdown'
      })
    ).toBe(true)
    expect(
      isOpenableMobileWorktreeFilePreview('worktree', {
        status: 'ready',
        kind: 'text',
        content: 'export const value = 1',
        truncated: true,
        byteLength: 500_000
      })
    ).toBe(true)
    expect(
      isOpenableMobileWorktreeFilePreview('worktree', {
        status: 'ready',
        kind: 'html',
        content: '<main>Hello</main>',
        truncated: false,
        byteLength: 18
      })
    ).toBe(true)
  })

  it('does not offer Open for images or non-worktree artifacts', () => {
    expect(
      isOpenableMobileWorktreeFilePreview('worktree', {
        status: 'ready',
        kind: 'image',
        dataUri: 'data:image/png;base64,aW1n'
      })
    ).toBe(false)
    expect(
      isOpenableMobileWorktreeFilePreview('terminalArtifact', {
        status: 'ready',
        kind: 'markdown',
        content: '# Artifact',
        truncated: false,
        byteLength: 10
      })
    ).toBe(false)
  })

  it('keeps dirty terminal artifact drafts protected while preview is waiting for reconnect', () => {
    const sourceKey = sourceKeyForPreview({
      source: 'terminalArtifact',
      worktreeId: 'wt-1',
      absolutePath: '/tmp/result.json',
      grantId: 'grant-1'
    })

    expect(
      hasUnsavedMobileTerminalArtifactDraft({
        source: 'terminalArtifact',
        draftSourceKey: sourceKey,
        previewSourceKey: sourceKey,
        draftContent: '{"ok":false}',
        savedContent: '{"ok":true}'
      })
    ).toBe(true)
  })

  it('keeps dirty terminal artifact drafts when a reload fails or waits', () => {
    expect(
      shouldKeepDirtyDraftOnPreviewLoadResult(true, {
        status: 'error',
        message: 'Unable to reach desktop filesystem',
        reconnect: true
      })
    ).toBe(true)
    expect(
      shouldKeepDirtyDraftOnPreviewLoadResult(true, {
        status: 'waiting',
        message: 'Waiting for desktop...',
        reconnect: true
      })
    ).toBe(true)
    expect(
      shouldKeepDirtyDraftOnPreviewLoadResult(false, {
        status: 'error',
        message: 'Unable to load preview',
        reconnect: false
      })
    ).toBe(false)
  })
})
