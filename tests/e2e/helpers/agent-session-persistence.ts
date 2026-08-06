import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { PROTOCOL_VERSION } from '../../../src/main/daemon/types'
import { DEFAULT_LOCAL_ORCA_PROFILE_ID } from '../../../src/shared/orca-profiles'

type PersistedAgentSessionData = {
  workspaceSession?: {
    sleepingAgentSessionsByPaneKey?: Record<
      string,
      {
        providerSession?: { id?: unknown }
        launchConfig?: {
          agentCommand?: string
          agentArgs?: string
          agentEnv?: Record<string, string>
        }
      }
    >
  }
}

function dataFilePath(userDataDir: string): string {
  return path.join(userDataDir, 'profiles', DEFAULT_LOCAL_ORCA_PROFILE_ID, 'orca-data.json')
}

export function overridePersistedAgentResumeCommand(
  userDataDir: string,
  providerSessionId: string
): void {
  const dataPath = dataFilePath(userDataDir)
  const data = JSON.parse(readFileSync(dataPath, 'utf8')) as PersistedAgentSessionData
  const record = Object.values(data.workspaceSession?.sleepingAgentSessionsByPaneKey ?? {}).find(
    (candidate) => candidate.providerSession?.id === providerSessionId
  )
  if (!record) {
    throw new Error(`Expected persisted resumable agent session ${providerSessionId}`)
  }
  record.launchConfig = { agentCommand: 'echo', agentArgs: '', agentEnv: {} }
  writeFileSync(dataPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

export function readOrcaDaemonPid(userDataDir: string): number {
  const raw = readFileSync(
    path.join(userDataDir, 'daemon', `daemon-v${PROTOCOL_VERSION}.pid`),
    'utf8'
  )
  const parsed = JSON.parse(raw) as { pid?: unknown }
  if (typeof parsed.pid !== 'number') {
    throw new Error(`Daemon pid file did not contain a numeric pid: ${raw}`)
  }
  return parsed.pid
}
