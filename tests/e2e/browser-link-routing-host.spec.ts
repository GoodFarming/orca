import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import { cleanupMarkdownFixture, createMarkdownFixture } from './helpers/markdown-ordered-list-exit'
import { ensureTerminalVisible } from './helpers/store'
import { waitForActivePanePtyId } from './helpers/terminal'

type RoutingServer = {
  destinationUrl: string
  close: () => Promise<void>
}

type PairedWorktree = {
  id: string
  path: string
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}

async function startRoutingServer(): Promise<RoutingServer> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html>
      <html>
        <head><title>Local routing destination</title></head>
        <body><h1 id="routing-marker">Opened on this computer</h1></body>
      </html>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    destinationUrl: `http://127.0.0.1:${port}/destination`,
    close: () => closeServer(server)
  }
}

async function dismissTransientAnnouncement(page: Page): Promise<void> {
  const maybeLaterButton = page.getByRole('button', { name: 'Maybe Later' })
  if (await maybeLaterButton.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await maybeLaterButton.click()
  }
}

async function openBrowserSettings(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('Paired desktop store is unavailable')
    }
    state.openSettingsTarget({ pane: 'browser', repoId: null })
    state.openSettingsPage()
  })
  await expect(page.getByPlaceholder('Search settings')).toBeVisible({ timeout: 10_000 })
  await dismissTransientAnnouncement(page)
}

async function seedWorkspaceRoutingPreference(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const nextSettings = await window.api.settings.set({
      browserLinkRoutingHost: 'workspace',
      openLinksInApp: true,
      openLinksInAppPreferencePrompted: true
    })
    window.__store?.setState({ settings: nextSettings })
  })
}

async function setLinkRoutingToLocalThroughUi(page: Page): Promise<void> {
  const search = page.getByPlaceholder('Search settings')
  await search.fill('link routing')
  const linkRoutingSwitch = page.getByRole('switch', { name: 'Link Routing' })
  await expect(linkRoutingSwitch).toBeVisible()
  await expect(linkRoutingSwitch).toHaveAttribute('aria-checked', 'true')

  await search.fill('open links on')
  const routingHostSelect = page.getByRole('combobox').filter({
    hasText: 'Workspace runtime'
  })
  await expect(routingHostSelect).toBeVisible()
  await expect(routingHostSelect).toContainText('Workspace runtime')

  await routingHostSelect.evaluate((element) => {
    const trigger = element as HTMLElement
    trigger.focus()
    element.dispatchEvent(
      new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'Enter'
      })
    )
  })
  await expect(page.locator('[data-slot="select-trigger"][aria-expanded="true"]')).toHaveCount(1)
  const localOption = page.getByRole('option', { name: 'This computer', exact: true })
  await expect(localOption).toBeAttached({ timeout: 5_000 })
  await localOption.evaluate((element) => {
    const option = element as HTMLElement
    option.focus()
    element.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter' })
    )
  })
  await expect
    .poll(async () => (await page.evaluate(() => window.api.settings.get())).browserLinkRoutingHost)
    .toBe('local')
}

async function activatePairedWorktree(page: Page, repoId: string): Promise<PairedWorktree> {
  await expect
    .poll(
      async () =>
        page.evaluate(async (targetRepoId) => {
          const state = window.__store?.getState()
          if (!state) {
            return null
          }
          await state.fetchRepos()
          await state.fetchWorktrees(targetRepoId)
          const worktree = state.worktreesByRepo[targetRepoId]?.find(
            (candidate) => candidate.isMainWorktree
          )
          return worktree ? { id: worktree.id, path: worktree.path } : null
        }, repoId),
      { timeout: 30_000, message: 'Paired desktop did not project the runtime worktree' }
    )
    .not.toBeNull()

  const worktree = await page.evaluate((targetRepoId) => {
    const state = window.__store?.getState()
    const candidate = state?.worktreesByRepo[targetRepoId]?.find((entry) => entry.isMainWorktree)
    return candidate ? { id: candidate.id, path: candidate.path } : null
  }, repoId)
  if (!worktree) {
    throw new Error('Paired runtime worktree disappeared after discovery')
  }

  await page.evaluate((worktreeId) => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('Paired desktop store is unavailable')
    }
    state.setActiveWorktree(worktreeId)
  }, worktree.id)
  await expect(page.locator('[data-rendered-active-worktree-id]')).toHaveAttribute(
    'data-rendered-active-worktree-id',
    worktree.id
  )
  await ensureTerminalVisible(page, 30_000)
  return worktree
}

async function openRuntimeMarkdown(
  client: PairedElectronClient,
  worktree: PairedWorktree,
  filePath: string
): Promise<void> {
  await client.page.evaluate(
    ({ environmentId, filePath, relativePath, worktreeId }) => {
      const state = window.__store?.getState()
      if (!state) {
        throw new Error('Paired desktop store is unavailable')
      }
      state.openFile({
        filePath,
        relativePath,
        worktreeId,
        language: 'markdown',
        mode: 'edit',
        runtimeEnvironmentId: environmentId
      })
    },
    {
      environmentId: client.environmentId,
      filePath,
      relativePath: path.relative(worktree.path, filePath),
      worktreeId: worktree.id
    }
  )
  let fileId: string | null = null
  await expect
    .poll(
      async () => {
        fileId = await client.page.evaluate(
          ({ filePath, worktreeId }) =>
            window.__store
              ?.getState()
              .openFiles.find(
                (candidate) =>
                  candidate.filePath === filePath && candidate.worktreeId === worktreeId
              )?.id ?? null,
          { filePath, worktreeId: worktree.id }
        )
        return fileId
      },
      { timeout: 30_000, message: `Paired desktop did not register ${filePath}` }
    )
    .not.toBeNull()
  let tabId: string | null = null
  await expect
    .poll(
      async () => {
        tabId = await client.page.evaluate(
          ({ fileId, worktreeId }) =>
            window.__store
              ?.getState()
              .unifiedTabsByWorktree[worktreeId]?.find(
                (candidate) => candidate.entityId === fileId && candidate.contentType === 'editor'
              )?.id ?? null,
          { fileId, worktreeId: worktree.id }
        )
        return tabId
      },
      { timeout: 30_000, message: `Paired desktop did not create an editor tab for ${filePath}` }
    )
    .not.toBeNull()
  await client.page.evaluate(
    ({ fileId, tabId, worktreeId }) => {
      const state = window.__store?.getState()
      if (!state) {
        throw new Error('Paired desktop store is unavailable')
      }
      const tab = state.unifiedTabsByWorktree[worktreeId]?.find(
        (candidate) => candidate.id === tabId
      )
      if (!tab) {
        throw new Error(`Paired desktop editor tab disappeared: ${tabId}`)
      }
      state.focusGroup(worktreeId, tab.groupId)
      state.activateTab(tabId)
      state.setActiveFile(fileId)
      state.setActiveTabType('editor')
      state.setActiveView('terminal')
    },
    { fileId: fileId!, tabId: tabId!, worktreeId: worktree.id }
  )
  await expect
    .poll(
      () =>
        client.page.evaluate(
          ({ fileId, tabId, worktreeId }) => {
            const state = window.__store?.getState()
            const groupId = state?.activeGroupIdByWorktree[worktreeId]
            const group = state?.groupsByWorktree[worktreeId]?.find(
              (candidate) => candidate.id === groupId
            )
            const editorVisible = Array.from(
              document.querySelectorAll<HTMLElement>('.rich-markdown-editor')
            ).some((editor) => editor.offsetWidth > 0 && editor.offsetHeight > 0)
            return {
              activeFileId: state?.activeFileId ?? null,
              activeTabType: state?.activeTabType ?? null,
              activeView: state?.activeView ?? null,
              activeWorktreeId: state?.activeWorktreeId ?? null,
              editorVisible,
              groupActiveTabId: group?.activeTabId ?? null,
              groupId: group?.id ?? null,
              targetFileId: fileId,
              targetTabId: tabId
            }
          },
          { fileId: fileId!, tabId: tabId!, worktreeId: worktree.id }
        ),
      { timeout: 25_000, message: `Runtime editor did not become visible for ${filePath}` }
    )
    .toMatchObject({
      activeFileId: fileId,
      activeTabType: 'editor',
      activeView: 'terminal',
      activeWorktreeId: worktree.id,
      editorVisible: true,
      groupActiveTabId: tabId
    })
}

async function readBrowserDestination(
  page: Page,
  worktreeId: string,
  existingBrowserTabIds: string[]
): Promise<{
  browserRuntimeEnvironmentId: string | null | undefined
  marker: string | null
  terminalTabIds: string[]
  url: string
} | null> {
  return page.evaluate(
    async ({ existingBrowserTabIds, worktreeId }) => {
      const state = window.__store?.getState()
      if (!state) {
        return null
      }
      const tab = (state.browserTabsByWorktree[worktreeId] ?? []).find(
        (candidate) => !existingBrowserTabIds.includes(candidate.id)
      )
      if (!tab?.activePageId) {
        return null
      }
      const browserPage = state.browserPagesByWorkspace[tab.id]?.find(
        (candidate) => candidate.id === tab.activePageId
      )
      const overlay = document.querySelector(`[data-browser-overlay-tab-id="${tab.id}"]`)
      const webview = overlay?.querySelector('webview') as Electron.WebviewTag | null
      if (!browserPage || !webview) {
        return null
      }
      try {
        const marker = (await webview.executeJavaScript(
          'document.querySelector("#routing-marker")?.textContent ?? null'
        )) as string | null
        return {
          browserRuntimeEnvironmentId: browserPage.browserRuntimeEnvironmentId,
          marker,
          terminalTabIds: (state.tabsByWorktree[worktreeId] ?? []).map(
            (terminalTab) => terminalTab.id
          ),
          url: browserPage.url
        }
      } catch {
        return null
      }
    },
    { existingBrowserTabIds, worktreeId }
  )
}

test('a paired desktop keeps a runtime-owned link local when the user selects This computer', async ({
  orcaPage,
  testRepoPath
}, testInfo) => {
  test.setTimeout(240_000)
  const server = await startRoutingServer()
  let client: PairedElectronClient | null = null
  let markdownPath: string | null = null

  try {
    const repoId = await orcaPage.evaluate((repoPath) => {
      const repo = window.__store?.getState().repos.find((candidate) => candidate.path === repoPath)
      if (!repo) {
        throw new Error(`HUB test repo is unavailable: ${repoPath}`)
      }
      return repo.id
    }, testRepoPath)

    const offer = await createRuntimeDesktopPairingOffer(orcaPage)
    client = await launchPairedElectronClient(offer, testInfo, 'Browser routing user test', {
      // A fresh paired client can render its disposable local repo while the
      // session-ready latch remains false. Pair first; the runtime switch is
      // the readiness boundary this user flow actually depends on.
      waitForInitialWorkspaceSessionReady: false
    })
    await client.page.setViewportSize({ width: 1600, height: 1000 })
    const worktree = await activatePairedWorktree(client.page, repoId)
    // The runtime's initial terminal focus notification is asynchronous. Wait
    // for the pane binding before starting the Settings workflow so the test
    // does not confuse fixture startup navigation with a setting-triggered jump.
    await waitForActivePanePtyId(client.page, 30_000)

    await seedWorkspaceRoutingPreference(client.page)
    await openBrowserSettings(client.page)
    const search = client.page.getByPlaceholder('Search settings')
    await search.fill('cookies')
    await expect(client.page.getByText('Profile & Cookie Host', { exact: true })).toBeVisible()
    await expect(
      client.page.getByText(/This does not control where browser tabs run\./).first()
    ).toBeVisible()
    await setLinkRoutingToLocalThroughUi(client.page)

    markdownPath = await createMarkdownFixture(
      { worktreeId: worktree.id, rootPath: worktree.path },
      'browser-link-routing-host',
      testInfo.workerIndex,
      `# Browser routing user test\n\n[Open destination](${server.destinationUrl})\n`
    )

    const before = await client.page.evaluate((worktreeId) => {
      const state = window.__store?.getState()
      return {
        browserTabIds: (state?.browserTabsByWorktree[worktreeId] ?? []).map((tab) => tab.id),
        terminalTabIds: (state?.tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id)
      }
    }, worktree.id)

    await openRuntimeMarkdown(client, worktree, markdownPath)
    const link = client.page.locator(`.rich-markdown-editor a[href="${server.destinationUrl}"]`)
    await expect(link).toBeVisible()
    await link.click({ force: true })
    const openLink = client.page.getByRole('button', { name: 'Open link' })
    await expect(openLink).toBeVisible()
    await openLink.click({ force: true })

    await expect
      .poll(() => readBrowserDestination(client!.page, worktree.id, before.browserTabIds), {
        timeout: 15_000,
        message: 'The runtime-owned link did not load in a local browser tab'
      })
      .toEqual({
        browserRuntimeEnvironmentId: null,
        marker: 'Opened on this computer',
        terminalTabIds: before.terminalTabIds,
        url: server.destinationUrl
      })
  } finally {
    await cleanupMarkdownFixture(markdownPath)
    await client?.dispose()
    await server.close()
  }
})
