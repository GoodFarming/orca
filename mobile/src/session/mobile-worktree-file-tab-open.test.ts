import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import { openMobileWorktreeFileTab } from './mobile-worktree-file-tab-open'

function success(result: unknown): RpcResponse {
  return { id: 'rpc-1', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

function failure(code: string, message: string): RpcResponse {
  return {
    id: 'rpc-1',
    ok: false,
    error: { code, message },
    _meta: { runtimeId: 'runtime-1' }
  }
}

function openResult(opened = true, kind: 'markdown' | 'text' | 'binary' | 'image' = 'markdown') {
  return {
    worktree: 'worktree-1',
    relativePath: 'docs/readme.md',
    kind,
    opened
  }
}

function clientWith(sendRequest: RpcClient['sendRequest']): Pick<RpcClient, 'sendRequest'> {
  return { sendRequest }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('openMobileWorktreeFileTab', () => {
  it('opens, finds the exact non-diff tab, and activates it for only the caller', async () => {
    const sendRequest = vi
      .fn<RpcClient['sendRequest']>()
      .mockResolvedValueOnce(success(openResult()))
      .mockResolvedValueOnce(
        success({
          tabs: [
            {
              type: 'file',
              id: 'other',
              relativePath: 'docs/readme.md.bak',
              mode: 'edit'
            },
            { type: 'file', id: 'diff', relativePath: 'docs/readme.md', mode: 'diff' },
            { type: 'markdown', id: 'edit', relativePath: 'docs/readme.md' }
          ]
        })
      )
      .mockResolvedValueOnce(success({ activeTabId: 'edit' }))

    await expect(
      openMobileWorktreeFileTab({
        client: clientWith(sendRequest),
        worktreeId: 'worktree-1',
        relativePath: 'docs/readme.md'
      })
    ).resolves.toEqual({ status: 'activated', tabId: 'edit', kind: 'markdown' })

    expect(sendRequest).toHaveBeenNthCalledWith(
      1,
      'files.open',
      { worktree: 'id:worktree-1', relativePath: 'docs/readme.md' },
      { timeoutMs: 15_000 }
    )
    expect(sendRequest).toHaveBeenNthCalledWith(
      2,
      'session.tabs.list',
      { worktree: 'id:worktree-1' },
      { timeoutMs: 10_000 }
    )
    expect(sendRequest).toHaveBeenNthCalledWith(3, 'session.tabs.activate', {
      worktree: 'id:worktree-1',
      tabId: 'edit',
      notifyClients: false,
      navigation: 'caller'
    })
  })

  it('waits for delayed SSH tab publication before activation', async () => {
    vi.useFakeTimers()
    const sendRequest = vi
      .fn<RpcClient['sendRequest']>()
      .mockResolvedValueOnce(success(openResult()))
      .mockResolvedValueOnce(success({ tabs: [] }))
      .mockResolvedValueOnce(success({ tabs: [] }))
      .mockResolvedValueOnce(
        success({ tabs: [{ type: 'markdown', id: 'remote-tab', relativePath: 'docs/readme.md' }] })
      )
      .mockResolvedValueOnce(success({ activeTabId: 'remote-tab' }))

    const opening = openMobileWorktreeFileTab({
      client: clientWith(sendRequest),
      worktreeId: 'worktree-1',
      relativePath: 'docs/readme.md'
    })
    await vi.advanceTimersByTimeAsync(900)

    await expect(opening).resolves.toEqual({
      status: 'activated',
      tabId: 'remote-tab',
      kind: 'markdown'
    })
    expect(sendRequest).toHaveBeenCalledTimes(5)
  })

  it.each([
    { staleMode: 'diff', staleId: 'existing-diff' },
    { staleMode: 'markdown-preview', staleId: 'existing-preview' }
  ])('waits for an edit tab instead of activating a same-path $staleMode tab', async (entry) => {
    vi.useFakeTimers()
    const staleTab = {
      type: entry.staleMode === 'diff' ? 'file' : 'markdown',
      id: entry.staleId,
      relativePath: 'docs/readme.md',
      mode: entry.staleMode
    }
    const editTab = {
      type: 'markdown',
      id: 'new-edit',
      relativePath: 'docs/readme.md',
      mode: 'edit'
    }
    const sendRequest = vi
      .fn<RpcClient['sendRequest']>()
      .mockResolvedValueOnce(success(openResult()))
      .mockResolvedValueOnce(success({ tabs: [staleTab] }))
      .mockResolvedValueOnce(success({ tabs: [staleTab, editTab] }))
      .mockResolvedValueOnce(success({ activeTabId: 'new-edit' }))

    const opening = openMobileWorktreeFileTab({
      client: clientWith(sendRequest),
      worktreeId: 'worktree-1',
      relativePath: 'docs/readme.md'
    })
    await vi.advanceTimersByTimeAsync(300)

    await expect(opening).resolves.toEqual({
      status: 'activated',
      tabId: 'new-edit',
      kind: 'markdown'
    })
    expect(sendRequest).toHaveBeenLastCalledWith('session.tabs.activate', {
      worktree: 'id:worktree-1',
      tabId: 'new-edit',
      notifyClients: false,
      navigation: 'caller'
    })
  })

  it('returns an explicit open failure without listing tabs', async () => {
    const sendRequest = vi
      .fn<RpcClient['sendRequest']>()
      .mockResolvedValue(failure('renderer_unavailable', 'Renderer unavailable'))

    await expect(
      openMobileWorktreeFileTab({
        client: clientWith(sendRequest),
        worktreeId: 'worktree-1',
        relativePath: 'docs/readme.md'
      })
    ).resolves.toEqual({
      status: 'failed',
      stage: 'open',
      code: 'renderer_unavailable',
      message: 'Renderer unavailable'
    })
    expect(sendRequest).toHaveBeenCalledOnce()
  })

  it.each([
    { worktree: 'other-worktree', relativePath: 'docs/readme.md' },
    { worktree: 'worktree-1', relativePath: 'docs/other.md' }
  ])('rejects a files.open response for a different target', async (target) => {
    const sendRequest = vi.fn<RpcClient['sendRequest']>().mockResolvedValue(
      success({
        ...openResult(),
        ...target
      })
    )

    await expect(
      openMobileWorktreeFileTab({
        client: clientWith(sendRequest),
        worktreeId: 'worktree-1',
        relativePath: 'docs/readme.md'
      })
    ).resolves.toEqual({
      status: 'failed',
      stage: 'open',
      code: 'invalid_response',
      message: 'Invalid files.open response'
    })
    expect(sendRequest).toHaveBeenCalledOnce()
  })

  it('reports unsupported binary files when the host declines to open them', async () => {
    const sendRequest = vi
      .fn<RpcClient['sendRequest']>()
      .mockResolvedValue(success(openResult(false, 'binary')))

    await expect(
      openMobileWorktreeFileTab({
        client: clientWith(sendRequest),
        worktreeId: 'worktree-1',
        relativePath: 'docs/readme.md'
      })
    ).resolves.toEqual({ status: 'not-opened', kind: 'binary' })
    expect(sendRequest).toHaveBeenCalledOnce()
  })

  it('returns timeout after a finite number of successful empty snapshots', async () => {
    vi.useFakeTimers()
    const sendRequest = vi
      .fn<RpcClient['sendRequest']>()
      .mockResolvedValueOnce(success(openResult()))
      .mockResolvedValue(success({ tabs: [] }))

    const opening = openMobileWorktreeFileTab({
      client: clientWith(sendRequest),
      worktreeId: 'worktree-1',
      relativePath: 'docs/readme.md'
    })
    await vi.advanceTimersByTimeAsync(1_800)

    await expect(opening).resolves.toEqual({ status: 'timeout', attempts: 4 })
    expect(sendRequest).toHaveBeenCalledTimes(5)
  })

  it('returns a list failure instead of treating a missing snapshot as success', async () => {
    const sendRequest = vi
      .fn<RpcClient['sendRequest']>()
      .mockResolvedValueOnce(success(openResult()))
      .mockResolvedValueOnce(failure('disconnected', 'Desktop disconnected'))

    await expect(
      openMobileWorktreeFileTab({
        client: clientWith(sendRequest),
        worktreeId: 'worktree-1',
        relativePath: 'docs/readme.md'
      })
    ).resolves.toEqual({
      status: 'failed',
      stage: 'list',
      code: 'disconnected',
      message: 'Desktop disconnected'
    })
  })

  it('requires activation confirmation before reporting success', async () => {
    const sendRequest = vi
      .fn<RpcClient['sendRequest']>()
      .mockResolvedValueOnce(success(openResult()))
      .mockResolvedValueOnce(
        success({ tabs: [{ type: 'markdown', id: 'edit', relativePath: 'docs/readme.md' }] })
      )
      .mockResolvedValueOnce(success({ activeTabId: 'other-tab' }))

    await expect(
      openMobileWorktreeFileTab({
        client: clientWith(sendRequest),
        worktreeId: 'worktree-1',
        relativePath: 'docs/readme.md'
      })
    ).resolves.toEqual({
      status: 'failed',
      stage: 'activate',
      code: 'activation_unconfirmed',
      message: 'Host did not confirm session tab activation'
    })
  })

  it('cancels before issuing any RPC when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const sendRequest = vi.fn<RpcClient['sendRequest']>()

    await expect(
      openMobileWorktreeFileTab({
        client: clientWith(sendRequest),
        worktreeId: 'worktree-1',
        relativePath: 'docs/readme.md',
        signal: controller.signal
      })
    ).resolves.toEqual({ status: 'cancelled' })
    expect(sendRequest).not.toHaveBeenCalled()
  })

  it('stops polling when a newer caller action supersedes the request', async () => {
    vi.useFakeTimers()
    let current = true
    const sendRequest = vi
      .fn<RpcClient['sendRequest']>()
      .mockResolvedValueOnce(success(openResult()))
      .mockResolvedValueOnce(success({ tabs: [] }))

    const opening = openMobileWorktreeFileTab({
      client: clientWith(sendRequest),
      worktreeId: 'worktree-1',
      relativePath: 'docs/readme.md',
      isCurrent: () => current
    })
    await vi.advanceTimersByTimeAsync(0)
    current = false
    await vi.advanceTimersByTimeAsync(300)

    await expect(opening).resolves.toEqual({ status: 'cancelled' })
    expect(sendRequest).toHaveBeenCalledTimes(2)
  })
})
