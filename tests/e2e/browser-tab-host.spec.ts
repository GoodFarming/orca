import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import { ensureTerminalVisible } from './helpers/store'
import { waitForActivePanePtyId } from './helpers/terminal'

type DestinationServer = {
  url: string
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

async function startDestinationServer(): Promise<DestinationServer> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html>
      <html>
        <head><title>Local browser destination</title></head>
        <body><h1 id="browser-host-marker">Opened on this computer</h1></body>
      </html>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}/destination`,
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

async function seedWorkspaceBrowserHost(page: Page, browserDefaultUrl: string): Promise<void> {
  await page.evaluate(
    async ({ browserDefaultUrl }) => {
      const nextSettings = await window.api.settings.set({
        browserTabHost: 'workspace',
        openLinksInApp: false,
        openLinksInAppPreferencePrompted: true
      })
      const state = window.__store?.getState()
      if (!state) {
        throw new Error('Paired desktop store is unavailable')
      }
      window.__store?.setState({ settings: nextSettings })
      state.setBrowserDefaultUrl(browserDefaultUrl)
    },
    { browserDefaultUrl }
  )
}

async function setBrowserTabHostToLocalThroughUi(page: Page): Promise<void> {
  const search = page.getByPlaceholder('Search settings')
  await search.fill('link routing')
  const linkRoutingSwitch = page.getByRole('switch', { name: 'Link Routing' })
  await expect(linkRoutingSwitch).toBeVisible()
  await expect(linkRoutingSwitch).toHaveAttribute('aria-checked', 'false')

  await search.fill('browser tab host')
  await expect(page.getByText('Browser tab host', { exact: true }).first()).toBeVisible()
  await expect(
    page
      .getByText('Choose where new browser tabs and links routed into Orca Browser run.', {
        exact: true
      })
      .first()
  ).toBeVisible()
  const browserHostSelect = page.getByRole('combobox').filter({
    hasText: 'Workspace runtime'
  })
  await expect(browserHostSelect).toBeVisible()

  await browserHostSelect.evaluate((element) => {
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
    .poll(async () => (await page.evaluate(() => window.api.settings.get())).browserTabHost)
    .toBe('local')
  await expect
    .poll(() => page.evaluate(() => window.__store?.getState().settings?.browserTabHost))
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

async function renderedTabIds(page: Page): Promise<string[]> {
  return page
    .locator('.terminal-tab-strip [data-tab-id]')
    .evaluateAll((tabs) =>
      Array.from(
        new Set(
          tabs
            .map((tab) => tab.getAttribute('data-tab-id'))
            .filter((tabId): tabId is string => Boolean(tabId))
        )
      )
    )
}

async function readNewBrowserDestination(
  page: Page,
  worktreeId: string,
  existingBrowserTabIds: string[]
): Promise<{
  browserRuntimeEnvironmentId: string | null | undefined
  marker: string | null
  tabId: string
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
          'document.querySelector("#browser-host-marker")?.textContent ?? null'
        )) as string | null
        return {
          browserRuntimeEnvironmentId: browserPage.browserRuntimeEnvironmentId,
          marker,
          tabId: tab.id,
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

test('paired New Browser Tab stays local when Browser tab host is This computer', async ({
  orcaPage,
  testRepoPath
}, testInfo) => {
  test.setTimeout(240_000)
  const server = await startDestinationServer()
  let client: PairedElectronClient | null = null

  try {
    const repoId = await orcaPage.evaluate((repoPath) => {
      const repo = window.__store?.getState().repos.find((candidate) => candidate.path === repoPath)
      if (!repo) {
        throw new Error(`HUB test repo is unavailable: ${repoPath}`)
      }
      return repo.id
    }, testRepoPath)

    const offer = await createRuntimeDesktopPairingOffer(orcaPage)
    client = await launchPairedElectronClient(offer, testInfo, 'Browser tab host user test', {
      waitForInitialWorkspaceSessionReady: false
    })
    await client.page.setViewportSize({ width: 1600, height: 1000 })
    const worktree = await activatePairedWorktree(client.page, repoId)
    await waitForActivePanePtyId(client.page, 30_000)

    await seedWorkspaceBrowserHost(client.page, server.url)
    await openBrowserSettings(client.page)
    const search = client.page.getByPlaceholder('Search settings')
    await search.fill('cookies')
    await expect(client.page.getByText('Profile & Cookie Host', { exact: true })).toBeVisible()
    await expect(
      client.page.getByText(/This does not control where browser tabs run\./).first()
    ).toBeVisible()
    await setBrowserTabHostToLocalThroughUi(client.page)

    const before = await client.page.evaluate((worktreeId) => {
      const state = window.__store?.getState()
      return {
        browserTabIds: (state?.browserTabsByWorktree[worktreeId] ?? []).map((tab) => tab.id),
        terminalTabIds: (state?.tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id)
      }
    }, worktree.id)
    const renderedTabsBefore = await renderedTabIds(client.page)

    await client.page.evaluate(() => window.__store?.getState().closeSettingsPage())
    await client.page.getByRole('button', { name: 'New tab' }).click({ force: true })
    const newBrowserTabItem = client.page
      .getByRole('menuitem', { name: /New Browser Tab/i })
      .first()
    await newBrowserTabItem.click({ force: true })

    await expect
      .poll(() => renderedTabIds(client!.page), {
        timeout: 15_000,
        message: 'New Browser Tab did not render exactly one additional tab'
      })
      .toHaveLength(renderedTabsBefore.length + 1)

    let destination: Awaited<ReturnType<typeof readNewBrowserDestination>> = null
    await expect
      .poll(
        async () => {
          destination = await readNewBrowserDestination(
            client!.page,
            worktree.id,
            before.browserTabIds
          )
          return destination
        },
        {
          timeout: 20_000,
          message: 'The new local browser tab did not load its configured home page'
        }
      )
      .toMatchObject({
        browserRuntimeEnvironmentId: null,
        marker: 'Opened on this computer',
        terminalTabIds: before.terminalTabIds,
        url: server.url
      })

    const activeBrowserTab = client.page.locator(
      `.terminal-tab-strip [data-tab-id="${destination!.tabId}"]`
    )
    await expect(activeBrowserTab).toBeVisible()
    await expect(
      client.page.locator(`[data-browser-overlay-tab-id="${destination!.tabId}"]`)
    ).toHaveCSS('opacity', '1')
    await expect(client.page.locator('[data-rendered-active-worktree-id]')).toHaveAttribute(
      'data-rendered-active-worktree-id',
      worktree.id
    )
  } finally {
    await client?.dispose()
    await server.close()
  }
})
