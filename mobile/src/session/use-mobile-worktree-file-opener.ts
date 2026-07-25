import { useCallback, useEffect, useRef, useState } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import {
  openMobileWorktreeFileTab,
  type MobileWorktreeFileTabOpenResult
} from './mobile-worktree-file-tab-open'

type Options = {
  client: Pick<RpcClient, 'sendRequest'> | null
  connectionState: ConnectionState
  worktreeId: string
  scopeKey?: string | null
  onActivated: (result: Extract<MobileWorktreeFileTabOpenResult, { status: 'activated' }>) => void
  onErrorChange: (message: string | null) => void
}

type OpenScope = Pick<Options, 'client' | 'connectionState' | 'scopeKey' | 'worktreeId'>

type OpenOperation = {
  revision: number
  controller: AbortController
  scope: OpenScope
}

export function useMobileWorktreeFileOpener({
  client,
  connectionState,
  worktreeId,
  scopeKey,
  onActivated,
  onErrorChange
}: Options): {
  opening: boolean
  openWorktreeFile: (relativePath: string) => void
} {
  const scope = { client, connectionState, scopeKey, worktreeId }
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const [openingOperation, setOpeningOperation] = useState<OpenOperation | null>(null)
  const operationRef = useRef<OpenOperation | null>(null)
  const nextRevisionRef = useRef(0)

  const beginOperation = useCallback((operationScope: OpenScope) => {
    operationRef.current?.controller.abort()
    const operation = {
      revision: nextRevisionRef.current + 1,
      controller: new AbortController(),
      scope: operationScope
    }
    nextRevisionRef.current = operation.revision
    operationRef.current = operation
    return operation
  }, [])

  const isCurrent = useCallback(
    (operation: OpenOperation) =>
      operationRef.current?.revision === operation.revision &&
      !operation.controller.signal.aborted &&
      scopesMatch(operation.scope, scopeRef.current),
    []
  )

  useEffect(
    () => () => {
      operationRef.current?.controller.abort()
      operationRef.current = null
    },
    []
  )

  useEffect(() => {
    operationRef.current?.controller.abort()
    operationRef.current = null
  }, [client, connectionState, scopeKey, worktreeId])

  const openWorktreeFile = useCallback(
    (relativePath: string) => {
      const operation = beginOperation({ client, connectionState, scopeKey, worktreeId })
      onErrorChange(null)
      if (!client || connectionState !== 'connected') {
        setOpeningOperation(null)
        onErrorChange('Reconnect to open this file.')
        return
      }

      setOpeningOperation(operation)
      void openMobileWorktreeFileTab({
        client,
        worktreeId,
        relativePath,
        signal: operation.controller.signal,
        isCurrent: () => isCurrent(operation)
      }).then((result) => {
        if (!isCurrent(operation)) {
          return
        }
        setOpeningOperation(null)
        if (result.status === 'activated') {
          onActivated(result)
          return
        }
        if (result.status !== 'cancelled') {
          onErrorChange(mobileWorktreeFileOpenError(result))
        }
      })
    },
    [
      beginOperation,
      client,
      connectionState,
      isCurrent,
      onActivated,
      onErrorChange,
      scopeKey,
      worktreeId
    ]
  )

  const opening = openingOperation !== null && scopesMatch(openingOperation.scope, scope)
  return { opening, openWorktreeFile }
}

function scopesMatch(left: OpenScope, right: OpenScope): boolean {
  return (
    left.client === right.client &&
    left.connectionState === right.connectionState &&
    left.scopeKey === right.scopeKey &&
    left.worktreeId === right.worktreeId
  )
}

export function mobileWorktreeFileOpenError(
  result: Exclude<MobileWorktreeFileTabOpenResult, { status: 'activated' | 'cancelled' }>
): string {
  if (result.status === 'timeout') {
    return "The file opened, but its tab isn't ready yet. Try again."
  }
  if (result.status === 'not-opened') {
    return "This file can't be opened in an editor."
  }
  return 'Unable to open file.'
}
