/**
 * Feature-scoped store for the currently open project + recents. Components
 * render from this; all real work happens in main via the IPC bridge.
 */
import { create } from 'zustand'
import type { Project, RecentProject } from '@shared/types'
import { ipcErrorMessage } from '../lib/ipcError'
import { studio } from '@/lib/studio'

/** One open-project tab: metadata only; the active one is `current`. */
export interface ProjectTab {
  id: string
  name: string
  path: string
}

interface ProjectState {
  current: Project | null
  /** Every opened project as a tab; switching reopens it server-side (fast SQLite swap). */
  tabs: ProjectTab[]
  activeTabId: string | null
  recents: RecentProject[]
  loading: boolean
  /** True until Core has been asked what is open, so boot shows no launcher flash. */
  restoring: boolean
  error: string | null
  /** A transient success message (e.g. "Exported to …"). */
  notice: string | null
  /** Path of the project currently being exported, if any. */
  exportingPath: string | null

  /** Adopt whatever project Core has open, so a refresh lands back in the workspace. */
  restore: () => Promise<void>
  loadRecents: () => Promise<void>
  createProject: (name: string) => Promise<void>
  openFromDialog: () => Promise<void>
  openFromZip: () => Promise<void>
  openByPath: (path: string) => Promise<void>
  /** Add (or activate) a tab for an opened project — every open path funnels here. */
  adopt: (project: Project) => void
  /** Reopen a tab's project server-side and make it the active canvas. */
  switchTab: (tabId: string) => Promise<void>
  /** Remove a tab; if it was active, fall back to a neighbour (or the launcher). */
  closeTab: (tabId: string) => void
  /** Export a project folder (by path) to a portable .zip via a save dialog. */
  exportProject: (path: string) => Promise<void>
  closeProject: () => void
}

const TABS_KEY = 'openchar-project-tabs'

function persistTabs(tabs: ProjectTab[], activeTabId: string | null): void {
  try {
    localStorage.setItem(TABS_KEY, JSON.stringify({ tabs, activeTabId }))
  } catch {
    /* storage plein : les onglets survivent au moins au cycle de page */
  }
}

function readTabs(): { tabs: ProjectTab[]; activeTabId: string | null } {
  try {
    const raw = JSON.parse(localStorage.getItem(TABS_KEY) ?? 'null') as {
      tabs?: ProjectTab[]
      activeTabId?: string | null
    } | null
    if (raw && Array.isArray(raw.tabs)) {
      return {
        tabs: raw.tabs.filter((t) => t && t.id && t.path),
        activeTabId: raw.activeTabId ?? null,
      }
    }
  } catch {
    /* corrupt: repart du courant */
  }
  return { tabs: [], activeTabId: null }
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  current: null,
  tabs: [],
  activeTabId: null,
  recents: [],
  loading: false,
  restoring: true,
  error: null,
  notice: null,
  exportingPath: null,

  restore: async () => {
    const res = await studio().project.current()
    const current = res.ok ? res.value : null
    const stored = readTabs()
    let tabs = stored.tabs
    if (current && !tabs.some((t) => t.id === current.id)) {
      tabs = [{ id: current.id, name: current.name, path: current.path }, ...tabs]
    }
    if (!current) tabs = []
    const activeTabId = current ? current.id : null
    persistTabs(tabs, activeTabId)
    set({ current, restoring: false, tabs, activeTabId })
  },

  loadRecents: async () => {
    const res = await studio().project.listRecent()
    if (res.ok) set({ recents: res.value })
  },

  createProject: async (name: string) => {
    set({ loading: true, error: null })
    const dir = await studio().dialog.pickDirectory()
    if (!dir.ok) return set({ loading: false, error: dir.error })
    if (dir.value === null) return set({ loading: false })

    const res = await studio().project.create({ name, parentDir: dir.value })
    if (!res.ok) return set({ loading: false, error: res.error })
    get().adopt(res.value)
    set({ loading: false })
    void get().loadRecents()
  },

  openFromDialog: async () => {
    set({ loading: true, error: null })
    const res = await studio().project.openDialog()
    if (!res.ok) return set({ loading: false, error: res.error })
    if (res.value === null) return set({ loading: false })
    get().adopt(res.value)
    set({ loading: false })
    void get().loadRecents()
  },

  openFromZip: async () => {
    set({ loading: true, error: null })
    try {
      const res = await studio().project.openZip()
      if (!res.ok) return set({ loading: false, error: res.error })
      if (res.value === null) return set({ loading: false })
      get().adopt(res.value)
      set({ loading: false })
      void get().loadRecents()
    } catch (e) {
      set({ loading: false, error: ipcErrorMessage(e) })
    }
  },

  openByPath: async (path: string) => {
    set({ loading: true, error: null })
    const res = await studio().project.open(path)
    if (!res.ok) return set({ loading: false, error: res.error })
    get().adopt(res.value)
    set({ loading: false })
    void get().loadRecents()
  },

  adopt: (project) => {
    const tabs = get().tabs.some((t) => t.id === project.id)
      ? get().tabs
      : [...get().tabs, { id: project.id, name: project.name, path: project.path }]
    persistTabs(tabs, project.id)
    set({ tabs, activeTabId: project.id, current: project })
  },

  switchTab: async (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (!tab || tabId === get().activeTabId) return
    set({ loading: true, error: null })
    const res = await studio().project.open(tab.path)
    if (!res.ok) {
      set({ loading: false, error: res.error })
      return
    }
    persistTabs(get().tabs, tabId)
    // Le remont du Workspace (key=project.id) recharge board/frames/assets proprement.
    set({ current: res.value, activeTabId: tabId, loading: false })
  },

  closeTab: (tabId) => {
    const tabs = get().tabs.filter((t) => t.id !== tabId)
    if (get().activeTabId === tabId) {
      if (tabs.length > 0) {
        persistTabs(tabs, tabs[0].id)
        void get().switchTab(tabs[0].id)
        return
      }
      persistTabs([], null)
      get().closeProject()
      return
    }
    persistTabs(tabs, get().activeTabId)
    set({ tabs })
  },

  exportProject: async (path: string) => {
    set({ exportingPath: path, error: null, notice: null })
    try {
      const res = await studio().project.export(path)
      if (!res.ok) return set({ exportingPath: null, error: res.error })
      // null = the user cancelled the save dialog.
      set({ exportingPath: null, notice: res.value ? `Exported to ${res.value.path}` : null })
    } catch (e) {
      set({ exportingPath: null, error: ipcErrorMessage(e) })
    }
  },

  // Tell Core too, or it reopens this project on its next start.
  closeProject: () => {
    void studio().project.close()
    persistTabs([], null)
    set({ current: null, tabs: [], activeTabId: null, error: null, notice: null })
  },
}))
