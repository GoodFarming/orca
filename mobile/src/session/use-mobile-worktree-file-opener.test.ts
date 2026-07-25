import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import {
  mobileWorktreeFileOpenError,
  useMobileWorktreeFileOpener
} from './use-mobile-worktree-file-opener'

const mockOpenWorktreeFileTab = vi.hoisted(() => vi.fn())
vi.mock('./mobile-worktree-file-tab-open', () => ({
  openMobileWorktreeFileTab: mockOpenWorktreeFileTab
}))

type HookValue = ReturnType<typeof useMobileWorktreeFileOpener>

type HarnessProps = {
  client: Pick<RpcClient, 'sendRequest'> | null
  connectionState: ConnectionState
  worktreeId: string
  scopeKey?: string | null
  onActivated: (result: {
    status: 'activated'
    tabId: string
    kind: 'markdown' | 'text' | 'binary' | 'image'
  }) => void
  onErrorChange: (message: string | null) => void
}

let hookValue: HookValue | null = null
let renderer: ReactTestRenderer | null = null

function HookHarness(props: HarnessProps) {
  hookValue = useMobileWorktreeFileOpener(props)
  return null
}

function currentHook(): HookValue {
  if (!hookValue) {
    throw new Error('Hook harness did not render')
  }
  return hookValue
}

async function renderHook(props: HarnessProps): Promise<void> {
  const originalConsoleError = console.error
  const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) {
      return
    }
    originalConsoleError(...args)
  })
  try {
    await act(async () => {
      renderer = create(createElement(HookHarness, props))
    })
  } finally {
    consoleErrorSpy.mockRestore()
  }
}

async function flushAsyncOperation(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function connectedProps(overrides: Partial<HarnessProps> = {}): HarnessProps {
  return {
    client: { sendRequest: vi.fn() },
    connectionState: 'connected',
    worktreeId: 'worktree-1',
    scopeKey: 'markdown-tab-1',
    onActivated: vi.fn(),
    onErrorChange: vi.fn(),
    ...overrides
  }
}

afterEach(() => {
  if (renderer) {
    act(() => renderer?.unmount())
  }
  renderer = null
  hookValue = null
  mockOpenWorktreeFileTab.mockReset()
  vi.restoreAllMocks()
})

describe('mobileWorktreeFileOpenError', () => {
  it('keeps RPC details out of user-facing failures', () => {
    expect(
      mobileWorktreeFileOpenError({
        status: 'failed',
        stage: 'open',
        message: '/private/worktree/path was rejected',
        code: 'EACCES'
      })
    ).toBe('Unable to open file.')
  })

  it('distinguishes unsupported files and delayed tab publication', () => {
    expect(mobileWorktreeFileOpenError({ status: 'not-opened', kind: 'binary' })).toBe(
      "This file can't be opened in an editor."
    )
    expect(mobileWorktreeFileOpenError({ status: 'timeout', attempts: 4 })).toBe(
      "The file opened, but its tab isn't ready yet. Try again."
    )
  })
})

describe('useMobileWorktreeFileOpener', () => {
  it('opens and activates a text file in the worktree session', async () => {
    const props = connectedProps()
    mockOpenWorktreeFileTab.mockResolvedValue({
      status: 'activated',
      tabId: 'file-tab-2',
      kind: 'text'
    })
    await renderHook(props)

    act(() => currentHook().openWorktreeFile('src/app.ts'))
    await flushAsyncOperation()

    expect(mockOpenWorktreeFileTab).toHaveBeenCalledWith(
      expect.objectContaining({
        client: props.client,
        worktreeId: 'worktree-1',
        relativePath: 'src/app.ts'
      })
    )
    expect(props.onActivated).toHaveBeenCalledWith({
      status: 'activated',
      tabId: 'file-tab-2',
      kind: 'text'
    })
    expect(props.onErrorChange).toHaveBeenCalledWith(null)
  })

  it('cancels a pending open when the preview scope changes', async () => {
    let resolveOpen: ((value: unknown) => void) | null = null
    mockOpenWorktreeFileTab.mockReturnValue(
      new Promise((resolve) => {
        resolveOpen = resolve
      })
    )
    const props = connectedProps()
    await renderHook(props)

    act(() => currentHook().openWorktreeFile('docs/next.md'))
    const openOptions = mockOpenWorktreeFileTab.mock.calls[0]?.[0]
    await act(async () => {
      renderer?.update(createElement(HookHarness, { ...props, scopeKey: 'markdown-tab-3' }))
    })
    expect(openOptions.signal.aborted).toBe(true)

    resolveOpen?.({ status: 'activated', tabId: 'markdown-tab-2', kind: 'markdown' })
    await flushAsyncOperation()

    expect(props.onActivated).not.toHaveBeenCalled()
    expect(currentHook().opening).toBe(false)
  })

  it('reports a reconnect requirement without issuing an RPC', async () => {
    const props = connectedProps({ client: null, connectionState: 'disconnected' })
    await renderHook(props)

    act(() => currentHook().openWorktreeFile('docs/next.md'))

    expect(mockOpenWorktreeFileTab).not.toHaveBeenCalled()
    expect(props.onErrorChange).toHaveBeenLastCalledWith('Reconnect to open this file.')
  })
})
