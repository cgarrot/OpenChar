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

/** The main shell: the node canvas plus the Settings drawer. */
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
    <div className="flex h-full flex-col">
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
          <span className="text-sm text-zinc-300">{project.name}</span>
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
