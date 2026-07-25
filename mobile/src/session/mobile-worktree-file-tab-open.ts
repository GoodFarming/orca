import type { RuntimeFileOpenResult } from '../../../src/shared/runtime-types'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcFailure, RpcResponse } from '../transport/types'
import { activateMobileSessionTab } from './mobile-session-tab-activation'
import {
  findEditableOpenedMobileSessionTab,
  type OpenedMobileSessionTabCandidate
} from './opened-mobile-session-tab'

type WorktreeFileTabOpenClient = Pick<RpcClient, 'sendRequest'>

export type MobileWorktreeFileTabOpenOptions = {
  client: WorktreeFileTabOpenClient
  worktreeId: string
  relativePath: string
  signal?: AbortSignal
  isCurrent?: () => boolean
}

type MobileWorktreeFileTabOpenFailureStage = 'open' | 'list' | 'activate'

export type MobileWorktreeFileTabOpenResult =
  | {
      status: 'activated'
      tabId: string
      kind: RuntimeFileOpenResult['kind']
    }
  | { status: 'cancelled' }
  | {
      status: 'not-opened'
      kind: RuntimeFileOpenResult['kind']
    }
  | {
      status: 'timeout'
      attempts: number
    }
  | {
      status: 'failed'
      stage: MobileWorktreeFileTabOpenFailureStage
      message: string
      code?: string
    }

const OPEN_REQUEST_TIMEOUT_MS = 15_000
const TAB_LIST_REQUEST_TIMEOUT_MS = 10_000
const TAB_POLL_DELAYS_MS = [0, 300, 600, 900] as const

export async function openMobileWorktreeFileTab(
  options: MobileWorktreeFileTabOpenOptions
): Promise<MobileWorktreeFileTabOpenResult> {
  if (isCancelled(options)) {
    return { status: 'cancelled' }
  }
  const worktree = `id:${options.worktreeId}`
  const openResponse = await sendRequest(
    options.client,
    'files.open',
    {
      worktree,
      relativePath: options.relativePath
    },
    OPEN_REQUEST_TIMEOUT_MS
  )
  if (isCancelled(options)) {
    return { status: 'cancelled' }
  }
  if (openResponse instanceof Error) {
    return failedResult('open', openResponse.message)
  }
  if (!openResponse.ok) {
    return rpcFailureResult('open', openResponse)
  }
  const opened = readFileOpenResult(openResponse.result, options.worktreeId, options.relativePath)
  if (!opened) {
    return failedResult('open', 'Invalid files.open response', 'invalid_response')
  }
  if (!opened.opened) {
    return { status: 'not-opened', kind: opened.kind }
  }

  for (let attempt = 0; attempt < TAB_POLL_DELAYS_MS.length; attempt += 1) {
    await waitForDelay(TAB_POLL_DELAYS_MS[attempt] ?? 0, options.signal)
    if (isCancelled(options)) {
      return { status: 'cancelled' }
    }
    const listResponse = await sendRequest(
      options.client,
      'session.tabs.list',
      { worktree },
      TAB_LIST_REQUEST_TIMEOUT_MS
    )
    if (isCancelled(options)) {
      return { status: 'cancelled' }
    }
    if (listResponse instanceof Error) {
      return failedResult('list', listResponse.message)
    }
    if (!listResponse.ok) {
      return rpcFailureResult('list', listResponse)
    }
    const tabs = readSessionTabs(listResponse.result)
    if (!tabs) {
      return failedResult('list', 'Invalid session.tabs.list response', 'invalid_response')
    }
    const tab = findEditableOpenedMobileSessionTab(tabs, opened.relativePath)
    if (!tab) {
      continue
    }
    if (isCancelled(options)) {
      return { status: 'cancelled' }
    }
    const activationResponse = await sendActivationRequest(options.client, worktree, tab.id)
    if (isCancelled(options)) {
      return { status: 'cancelled' }
    }
    if (activationResponse instanceof Error) {
      return failedResult('activate', activationResponse.message)
    }
    if (!activationResponse.ok) {
      return rpcFailureResult('activate', activationResponse)
    }
    if (!activationConfirmsTab(activationResponse.result, tab.id)) {
      return failedResult(
        'activate',
        'Host did not confirm session tab activation',
        'activation_unconfirmed'
      )
    }
    return { status: 'activated', tabId: tab.id, kind: opened.kind }
  }

  return { status: 'timeout', attempts: TAB_POLL_DELAYS_MS.length }
}

async function sendRequest(
  client: WorktreeFileTabOpenClient,
  method: string,
  params: unknown,
  timeoutMs: number
): Promise<RpcResponse | Error> {
  try {
    return await client.sendRequest(method, params, { timeoutMs })
  } catch (error) {
    return error instanceof Error ? error : new Error('Request failed')
  }
}

async function sendActivationRequest(
  client: WorktreeFileTabOpenClient,
  worktree: string,
  tabId: string
): Promise<RpcResponse | Error> {
  try {
    return await activateMobileSessionTab(client, {
      worktree,
      tabId,
      notifyClients: false,
      navigation: 'caller'
    })
  } catch (error) {
    return error instanceof Error ? error : new Error('Tab activation failed')
  }
}

function readFileOpenResult(
  value: unknown,
  worktreeId: string,
  relativePath: string
): RuntimeFileOpenResult | null {
  if (!isRecord(value)) {
    return null
  }
  if (
    value.worktree !== worktreeId ||
    value.relativePath !== relativePath ||
    typeof value.opened !== 'boolean' ||
    !isFileKind(value.kind)
  ) {
    return null
  }
  return value as RuntimeFileOpenResult
}

function readSessionTabs(value: unknown): OpenedMobileSessionTabCandidate[] | null {
  if (!isRecord(value) || !Array.isArray(value.tabs)) {
    return null
  }
  if (!value.tabs.every(isSessionTabCandidate)) {
    return null
  }
  return value.tabs as OpenedMobileSessionTabCandidate[]
}

function isSessionTabCandidate(value: unknown): value is OpenedMobileSessionTabCandidate {
  return isRecord(value) && typeof value.id === 'string' && typeof value.type === 'string'
}

function activationConfirmsTab(value: unknown, tabId: string): boolean {
  return isRecord(value) && value.activeTabId === tabId
}

function isFileKind(value: unknown): value is RuntimeFileOpenResult['kind'] {
  return value === 'markdown' || value === 'text' || value === 'binary' || value === 'image'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isCancelled(options: MobileWorktreeFileTabOpenOptions): boolean {
  return options.signal?.aborted === true || options.isCurrent?.() === false
}

function rpcFailureResult(
  stage: MobileWorktreeFileTabOpenFailureStage,
  response: RpcFailure
): MobileWorktreeFileTabOpenResult {
  return failedResult(stage, response.error.message, response.error.code)
}

function failedResult(
  stage: MobileWorktreeFileTabOpenFailureStage,
  message: string,
  code?: string
): MobileWorktreeFileTabOpenResult {
  return {
    status: 'failed',
    stage,
    message,
    ...(code ? { code } : {})
  }
}

async function waitForDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0 || signal?.aborted) {
    return
  }
  await new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = () => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    timer = setTimeout(finish, delayMs)
    signal?.addEventListener('abort', finish, { once: true })
  })
}
