import { useState } from 'react'
import type { Project } from '@shared/types'
import { Logo } from '../../components/Logo'
import { SettingsIcon } from '../../components/icons'
import { useProjectStore } from '../../store/projectStore'
import { useAssetStore } from '../../store/assetStore'
import { useMoodboardStore } from '../../store/moodboardStore'
import { useFrameStore } from '../../store/frameStore'
import { useGenerationStore } from '../../store/generationStore'
import { useUiStore } from '../../store/uiStore'
import { MoodboardPanel } from '../Moodboard/MoodboardPanel'
import { SettingsPanel } from '../Settings/SettingsPanel'
import { ExtensionsDialog } from '../Extensions/ExtensionsDialog'
import { ContextMenu } from '../../components/ContextMenu'
import { MediaLightbox } from '../../components/MediaLightbox'
import { ControlSpaceEditorMount } from '../ControlSpace/ControlSpaceEditorMount'
import { ActivityIndicator } from '../Activity/ActivityIndicator'
import { ChatDock } from '../Chat/ChatPanel'

/** Open-project tabs: several projects at once, instant switch (server reopens the SQLite
 * db, ~instant); runs keep landing in their own project — the ref is pinned at submit. */
function ProjectTabs(): React.JSX.Element {
  const tabs = useProjectStore((s) => s.tabs)
  const activeTabId = useProjectStore((s) => s.activeTabId)
  const switchTab = useProjectStore((s) => s.switchTab)
  const closeTab = useProjectStore((s) => s.closeTab)
  const recents = useProjectStore((s) => s.recents)
  const openByPath = useProjectStore((s) => s.openByPath)
  const loadRecents = useProjectStore((s) => s.loadRecents)
  const openFromDialog = useProjectStore((s) => s.openFromDialog)
  const createProject = useProjectStore((s) => s.createProject)
  const [menuOpen, setMenuOpen] = useState(false)
  return (
    <div className="flex min-w-0 items-center gap-1">
      <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
        {tabs.map((t) => (
          <div
            key={t.id}
            className={`group/tab flex shrink-0 items-center gap-1 rounded px-2 py-0.5 text-xs ${
              t.id === activeTabId ? 'bg-panel text-white' : 'text-zinc-400 hover:bg-panel'
            }`}
            title={t.path}
          >
            <button onClick={() => void switchTab(t.id)} className="max-w-40 truncate">
              {t.name}
            </button>
            <button
              onClick={() => closeTab(t.id)}
              className="text-zinc-600 opacity-0 transition-opacity hover:text-red-400 group-hover/tab:opacity-100"
              title="Fermer cet onglet"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      <div className="relative shrink-0">
        <button
          onClick={() => {
            if (!menuOpen) void loadRecents()
            setMenuOpen(!menuOpen)
          }}
          className="rounded px-1.5 py-0.5 text-xs text-zinc-500 hover:bg-panel hover:text-white"
          title="Ouvrir un autre projet"
        >
          +
        </button>
        {menuOpen && (
          <div className="absolute left-0 top-full z-40 mt-1 max-h-80 w-72 overflow-y-auto rounded border border-border bg-surface p-1 shadow-xl">
            {recents
              .filter((r) => !tabs.some((t) => t.path === r.path))
              .slice(0, 8)
              .map((r) => (
                <button
                  key={r.path}
                  onClick={() => {
                    setMenuOpen(false)
                    void openByPath(r.path)
                  }}
                  className="block w-full truncate rounded px-2 py-1.5 text-left text-xs text-zinc-300 hover:bg-panel"
                  title={r.path}
                >
                  {r.name}
                </button>
              ))}
            <button
              onClick={() => {
                setMenuOpen(false)
                void openFromDialog()
              }}
              className="mt-1 block w-full border-t border-border/60 px-2 pt-1.5 text-left text-xs text-zinc-500 hover:text-zinc-300"
            >
              📁 Parcourir…
            </button>
            <button
              onClick={() => {
                setMenuOpen(false)
                const name = window.prompt('Nom du nouveau projet :')
                if (name && name.trim()) void createProject(name.trim())
              }}
              className="block w-full px-2 pt-1.5 text-left text-xs text-zinc-500 hover:text-zinc-300"
              title="Créer un projet dans le dossier des projets"
            >
              ✚ Nouveau projet…
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

/** The main shell: the node canvas plus the Settings drawer. `project` (and the caller's
 * key on it) makes every tab switch remount, so all stores reload for the new project. */
export function Workspace({ project }: { project: Project }): React.JSX.Element {
  const settingsOpen = useUiStore((s) => s.settingsOpen)
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen)
  const [chatOpen, setChatOpen] = useState(true)
  const [chatCollapsed, setChatCollapsed] = useState(false)
  const [chatWidth, setChatWidth] = useState(() => {
    const saved = Number(localStorage.getItem('chat-panel-width'))
    return saved >= 280 && saved <= 760 ? saved : 384
  })
  const resizeChat = (width: number): void => {
    const clamped = Math.min(760, Math.max(280, width))
    setChatWidth(clamped)
    localStorage.setItem('chat-panel-width', String(clamped))
  }
  const closeProject = useProjectStore((s) => s.closeProject)
  const resetAssets = useAssetStore((s) => s.reset)
  const resetBoard = useMoodboardStore((s) => s.reset)
  const resetFrames = useFrameStore((s) => s.reset)
  const resetGeneration = useGenerationStore((s) => s.reset)

  const onClose = (): void => {
    resetAssets()
    resetBoard()
    resetFrames()
    // Only the local node badges: the runs keep going in Core and stay in the activity panel.
    resetGeneration()
    closeProject()
  }

  return (
    <div className="flex h-full flex-col" data-project={project.id}>
      <header className="relative flex h-12 shrink-0 items-center justify-between border-b border-border bg-surface px-3">
        <div className="flex items-center gap-2.5">
          <button
            onClick={onClose}
            title="Back to your projects"
            className="-m-1 flex items-center gap-2.5 rounded p-1 transition-opacity hover:opacity-75"
          >
            <Logo size={26} />
            <span className="text-sm font-semibold text-white">OpenChar</span>
          </button>
          <span className="text-zinc-600">/</span>
          <ProjectTabs />
        </div>

        <div className="flex items-center gap-1">
          <ActivityIndicator />
          <button
            onClick={() => setChatOpen(!chatOpen)}
            title="Pi chat"
            aria-label="Pi chat"
            aria-pressed={chatOpen}
            className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
              chatOpen ? 'bg-panel text-white' : 'text-zinc-400 hover:bg-panel hover:text-zinc-200'
            }`}
          >
            <span className="text-sm font-semibold">⌘</span>
          </button>
          <button
            onClick={() => setSettingsOpen(!settingsOpen)}
            title="Settings"
            aria-label="Settings"
            aria-pressed={settingsOpen}
            className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
              settingsOpen
                ? 'bg-panel text-white'
                : 'text-zinc-400 hover:bg-panel hover:text-zinc-200'
            }`}
          >
            <SettingsIcon className="h-5 w-5" />
          </button>
        </div>
      </header>

      <main className="flex min-h-0 flex-1">
        <div className="relative min-h-0 flex-1">
          <MoodboardPanel />
        </div>
        {settingsOpen && (
          <div className="min-h-0 w-80 shrink-0">
            <SettingsPanel onClose={() => setSettingsOpen(false)} />
          </div>
        )}
        {chatOpen && (
          <div
            className="min-h-0 shrink-0"
            style={{ width: chatCollapsed ? undefined : chatWidth }}
          >
            <ChatDock
              onClose={() => setChatOpen(false)}
              collapsed={chatCollapsed}
              onToggleCollapse={() => setChatCollapsed(!chatCollapsed)}
              onResize={resizeChat}
            />
          </div>
        )}
      </main>

      <ContextMenu />
      <MediaLightbox />
      <ControlSpaceEditorMount />
      <ExtensionsDialog />
    </div>
  )
}
