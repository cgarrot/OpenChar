/**
 * The Pi chat dock: tabs of live Pi sessions on the right of the canvas. The agent shares
 * the same graph tools as the user (openchar extension) — what it builds lands on the canvas.
 */
import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useChatStore, type ThreadEntry, type ToolCard } from '../../store/chatStore'
import { studio } from '../../lib/studio'
import { useUiStore } from '../../store/uiStore'
import { useMoodboardStore } from '../../store/moodboardStore'

function stateDot(state: string | undefined): string {
  if (state === 'streaming') return 'bg-emerald-400'
  if (state === 'starting') return 'bg-amber-400'
  if (state === 'error') return 'bg-red-400'
  if (state === 'idle') return 'bg-sky-400'
  return 'bg-zinc-600'
}

/** An icon + a human label per tool family, so an action reads at a glance. */
function toolLook(tool: string): { icon: string; label: string } {
  if (tool === 'bash') return { icon: '$', label: 'shell' }
  if (tool === 'read') return { icon: '👁', label: 'lire' }
  if (tool === 'edit' || tool === 'write')
    return { icon: '✎', label: tool === 'edit' ? 'éditer' : 'écrire' }
  if (tool === 'graph_add_node') return { icon: '＋', label: 'node' }
  if (tool === 'graph_add_prompt') return { icon: '＋', label: 'prompt' }
  if (tool === 'graph_connect') return { icon: '⤳', label: 'câbler' }
  if (tool === 'graph_update_node') return { icon: '⚙', label: 'régler' }
  if (tool === 'graph_delete') return { icon: '🗑', label: 'suppr.' }
  if (tool === 'graph_run') return { icon: '▶', label: 'rendre' }
  if (tool === 'graph_cancel') return { icon: '■', label: 'stop' }
  if (tool.startsWith('graph_')) return { icon: '🎛', label: 'graphe' }
  if (tool.startsWith('nanogpt')) return { icon: '🧠', label: 'modèle' }
  return { icon: '·', label: tool }
}

function ToolCardView({ tool, args, result, running }: ToolCard): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const look = toolLook(tool)
  const summary = (() => {
    const a = args as Record<string, unknown> | undefined
    if (tool === 'bash' && a && typeof a.command === 'string') return a.command
    if (
      (tool === 'read' || tool === 'edit' || tool === 'write') &&
      a &&
      typeof a.path === 'string'
    ) {
      return a.path
    }
    if (tool === 'graph_add_node' && a) return `${a.type} @ (${a.x}, ${a.y})`
    if (tool === 'graph_connect' && a)
      return `${String(a.from).slice(0, 8)} → ${String(a.to).slice(0, 8)}`
    if (tool === 'graph_run' && a) return String(a.itemId).slice(0, 8)
    if (tool.startsWith('nanogpt') && a && a.model) return String(a.model)
    const bits = Object.values(a ?? {})
      .slice(0, 3)
      .map((v) => (typeof v === 'object' ? JSON.stringify(v) : String(v)))
    return bits.join(' ')
  })()
  return (
    <div className="rounded border border-border bg-surface px-2 py-1.5 text-[11px]">
      <button className="flex w-full items-center gap-2 text-left" onClick={() => setOpen(!open)}>
        <span
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded font-mono text-[11px] ${
            running
              ? 'animate-pulse bg-amber-400/20 text-amber-300'
              : 'bg-zinc-700/60 text-zinc-400'
          }`}
        >
          {look.icon}
        </span>
        <span className="shrink-0 font-medium text-zinc-300">{look.label}</span>
        <span className="truncate text-zinc-500">{summary}</span>
        {open && <span className="ml-auto shrink-0 text-zinc-600">▲</span>}
      </button>
      {open && (
        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all text-zinc-400">
          {JSON.stringify({ args, result }, null, 1).slice(0, 4000)}
        </pre>
      )}
    </div>
  )
}

/** Discreet per-message actions (hover): copy, edit & resend, replay-from-here. */
function UserBubbleMenu({
  text,
  entryId,
  onEdit,
}: {
  text: string
  entryId?: string
  onEdit?: () => void
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  if (!entryId) return null
  const item = (label: string, icon: string, title: string, action: () => void) => (
    <button
      key={label}
      onClick={() => {
        setOpen(false)
        action()
      }}
      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] text-zinc-300 hover:bg-panel"
      title={title}
    >
      <span className="w-4 text-center">{icon}</span>
      {label}
    </button>
  )
  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={`rounded px-1 text-xs text-zinc-600 transition-opacity hover:text-zinc-300 ${
          open ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
        }`}
        title="Actions du message"
      >
        ⋯
      </button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 w-52 rounded border border-border bg-surface p-1 shadow-xl">
          {item(
            copied ? 'Copié ✓' : 'Copier le message',
            '⧉',
            'Copier le texte dans le presse-papier',
            () => {
              void navigator.clipboard.writeText(text).then(() => {
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              })
            },
          )}
          {onEdit &&
            item(
              'Modifier & renvoyer',
              '✎',
              'Éditer ce message — la conversation repart de ici',
              onEdit,
            )}
          {item(
            'Rejouer depuis ici',
            '↻',
            'Fourche une nouvelle branche à ce message et le renvoie tel quel',
            () => void useChatStore.getState().replayFrom(entryId, text),
          )}
        </div>
      )}
    </div>
  )
}

function EntryView({
  entry,
  onEdit,
}: {
  entry: ThreadEntry
  onEdit?: (text: string) => void
}): React.JSX.Element {
  if (entry.kind === 'user') {
    return (
      <div className="group flex flex-col items-end gap-1">
        {!!entry.images.length && (
          <div className="flex gap-1">
            {entry.images.map((url) => (
              <img key={url} src={url} alt="" className="h-16 w-16 rounded object-cover" />
            ))}
          </div>
        )}
        <div className="flex items-center gap-1">
          <UserBubbleMenu
            text={entry.text}
            entryId={entry.entryId}
            onEdit={onEdit ? () => onEdit(entry.text) : undefined}
          />
          <div className="max-w-[85%] whitespace-pre-wrap rounded-lg bg-zinc-700/60 px-3 py-2 text-sm text-zinc-100">
            {entry.text}
          </div>
        </div>
        {entry.contextNote && (
          <span
            className="max-w-[85%] truncate text-[10px] italic text-zinc-500"
            title={`Contexte envoyé à l'agent : ${entry.contextNote}`}
          >
            ⟡ contexte : {entry.contextNote}
          </span>
        )}
      </div>
    )
  }
  if (entry.kind === 'tools') {
    return (
      <div className="flex flex-col gap-1">
        {entry.cards.map((c, i) => (
          <ToolCardView key={i} {...c} />
        ))}
      </div>
    )
  }
  return (
    <div className="max-w-[95%] rounded-lg border border-border/60 bg-panel px-3 py-2 text-sm text-zinc-200">
      <div className="chat-md">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.text || '…'}</ReactMarkdown>
      </div>
      {entry.streaming && <span className="ml-0.5 animate-pulse">▍</span>}
    </div>
  )
}

/** Stable empty thread: a fresh [] from the selector would re-render forever (zustand v5). */
const NO_THREAD: ThreadEntry[] = []
const THINKING_LEVELS = ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** Live chips of what is selected on the canvas — the context that rides along with the
 * next message. Temporary by nature, unlike the persistent refs. */
function SelectionStrip(): React.JSX.Element | null {
  const ids = useUiStore((s) => s.canvasSelection)
  const items = useMoodboardStore((s) => s.items)
  const selected = items.filter((i) => ids.includes(i.id))
  if (!selected.length) return null
  return (
    <>
      {selected.slice(0, 6).map((i) => {
        const data = i.data as Record<string, unknown> | undefined
        const core = (data?.core ?? {}) as Record<string, unknown>
        const kind = core.type ? String(core.type) : i.type === 'prompt' ? 'prompt' : i.type
        return (
          <span
            key={i.id}
            title={`${kind} — envoyé comme contexte avec le prochain message`}
            className="flex max-w-52 items-center gap-1 rounded-full bg-sky-500/15 px-2 py-0.5 text-[11px] text-sky-300"
          >
            {i.type === 'prompt' ? '✎' : '🎛'}
            <span className="truncate">{kind}</span>
          </span>
        )
      })}
      {selected.length > 6 && (
        <span className="text-[11px] text-sky-400/70">+{selected.length - 6}</span>
      )}
    </>
  )
}

function RefsBar(): React.JSX.Element {
  const activeId = useChatStore((s) => s.activeId)
  const tab = useChatStore((s) => s.tabs.find((t) => t.id === s.activeId))
  const addRef = useChatStore((s) => s.addRef)
  const removeRef = useChatStore((s) => s.removeRef)
  const newTabFromContext = useChatStore((s) => s.newTabFromContext)
  const [menuOpen, setMenuOpen] = useState(false)
  if (!activeId) return <></>
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border bg-panel/50 px-2 py-1.5">
      <SelectionStrip />
      {tab?.refs.map((ref) => (
        <span
          key={ref}
          title={ref}
          className="flex max-w-52 items-center gap-1 rounded-full bg-surface px-2 py-0.5 text-[11px] text-zinc-300"
        >
          {ref.endsWith('/') || !ref.includes('.') ? '📁' : '📄'}
          <span className="truncate">{ref.split('/').filter(Boolean).pop()}</span>
          <button
            onClick={() => activeId && void removeRef(activeId, ref)}
            className="text-zinc-600 hover:text-red-400"
            title="Retirer la référence"
          >
            ✕
          </button>
        </span>
      ))}
      <button
        onClick={() => {
          const path = window.prompt('Chemin d’un dossier ou fichier à garder en référence :')
          if (path && path.trim()) void addRef(activeId, path.trim())
        }}
        className="rounded-full border border-dashed border-zinc-600 px-2 py-0.5 text-[11px] text-zinc-500 hover:border-zinc-400 hover:text-zinc-300"
        title="Ajouter une référence persistante (dossier ou fichier) — injectée dans chaque message"
      >
        + référence
      </button>
      <div className="relative ml-auto">
        <button
          onClick={() => setMenuOpen(!menuOpen)}
          className="rounded px-1.5 py-0.5 text-[11px] text-zinc-500 hover:bg-panel hover:text-white"
          title="Menu du contexte"
        >
          ☰
        </button>
        {menuOpen && (
          <div className="absolute right-0 top-full z-20 mt-1 w-64 rounded border border-border bg-surface p-1 shadow-xl">
            <button
              onClick={() => {
                setMenuOpen(false)
                void newTabFromContext()
              }}
              className="block w-full rounded px-2 py-1.5 text-left text-[11px] text-zinc-300 hover:bg-panel"
              title="Nouvelle session Pi avec les mêmes références, modèle et thinking"
            >
              ✚ Nouveau chat avec ce contexte
              <span className="block text-[10px] text-zinc-600">
                Mêmes dossiers/références, modèle et thinking — session vierge
              </span>
            </button>
          </div>
        )}
      </div>
      {!menuOpen && (
        <span
          className="text-[10px] text-zinc-600"
          title="Les éléments sélectionnés sur le canvas partent avec le prochain message"
        >
          sélection → contexte auto
        </span>
      )}
    </div>
  )
}

function TabSettingsBar(): React.JSX.Element {
  const activeId = useChatStore((s) => s.activeId)
  const tab = useChatStore((s) => s.tabs.find((t) => t.id === s.activeId))
  const models = useChatStore((s) => s.models)
  const loadModels = useChatStore((s) => s.loadModels)
  const setModel = useChatStore((s) => s.setModel)
  const setThinking = useChatStore((s) => s.setThinking)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [modelQuery, setModelQuery] = useState('')
  if (!activeId || !tab) return <></>
  const filteredModels = modelQuery.trim()
    ? models.filter(
        (m) =>
          m.id.toLowerCase().includes(modelQuery.toLowerCase()) ||
          m.name.toLowerCase().includes(modelQuery.toLowerCase()),
      )
    : models
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border bg-panel/30 px-2 py-1 text-[11px] text-zinc-400">
      <div className="relative">
        <button
          onClick={() => {
            if (!pickerOpen) void loadModels(activeId)
            setPickerOpen(!pickerOpen)
          }}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-panel hover:text-white"
          title="Changer le modèle Pi de cet onglet"
        >
          <span className="text-zinc-500">Ⓜ</span>
          <span className="max-w-44 truncate">{tab.model || 'modèle par défaut'}</span>
          <span className="text-zinc-600">▾</span>
        </button>
        {pickerOpen && (
          <div className="absolute right-0 top-full z-20 mt-1 w-80 rounded border border-border bg-surface p-1 shadow-xl">
            <input
              autoFocus
              value={modelQuery}
              onChange={(e) => setModelQuery(e.target.value)}
              placeholder={`Rechercher parmi ${models.length} modèles…`}
              className="mb-1 w-full rounded border border-border bg-panel px-2 py-1 text-[11px] text-zinc-100 outline-none focus:border-zinc-500"
            />
            <div className="max-h-72 overflow-y-auto">
              {filteredModels.map((m) => (
                <button
                  key={m.id}
                  onClick={() => {
                    setPickerOpen(false)
                    void setModel(activeId, m.id)
                  }}
                  className={`block w-full truncate rounded px-2 py-1 text-left hover:bg-panel ${
                    m.id === tab.model ? 'text-white' : 'text-zinc-300'
                  }`}
                >
                  {m.name} {m.thinking ? '🧠' : ''}
                  <span className="ml-1 text-zinc-600">{m.id}</span>
                </button>
              ))}
              {!filteredModels.length && (
                <div className="px-2 py-1 text-zinc-500">
                  {models.length ? 'aucune correspondance' : 'chargement…'}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      <select
        value={tab.thinking}
        onChange={(e) => void setThinking(activeId, e.target.value)}
        className="rounded border border-border bg-panel px-1 py-0.5 text-[11px] text-zinc-300"
        title="Niveau de raisonnement (thinking)"
      >
        {THINKING_LEVELS.map((l) => (
          <option key={l} value={l}>
            {l === '' ? 'thinking: défaut' : `thinking: ${l}`}
          </option>
        ))}
      </select>
    </div>
  )
}

/** Slim footer: session usage as a tiny gauge + cost. Unobtrusive by design. */
function StatsFooter(): React.JSX.Element | null {
  const stats = useChatStore((s) => s.stats)
  if (!stats?.available) return null
  const percent = stats.contextUsage?.percent ?? null
  return (
    <div
      className="flex h-6 shrink-0 items-center gap-2 border-t border-border bg-panel/40 px-3 text-[10px] text-zinc-500"
      title={`Contexte utilisé : ${percent ?? '?'}% · Coût de la session : $${(stats.cost ?? 0).toFixed(2)} · Tokens : ${stats.tokens?.total ?? '?'}`}
    >
      <span className="uppercase tracking-wide">ctx</span>
      {percent != null ? (
        <span className="relative h-1 w-16 overflow-hidden rounded-full bg-zinc-700">
          <span
            className={`absolute inset-y-0 left-0 rounded-full ${
              percent > 80 ? 'bg-red-400' : percent > 50 ? 'bg-amber-400' : 'bg-emerald-400'
            }`}
            style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
          />
        </span>
      ) : (
        <span>—</span>
      )}
      <span>{percent != null ? `${Math.round(percent)}%` : '—'}</span>
      <span className="text-zinc-700">·</span>
      <span>${(stats.cost ?? 0).toFixed(2)}</span>
      <span className="text-zinc-700">·</span>
      <span>{((stats.tokens?.total ?? 0) / 1000).toFixed(1)}k tok</span>
    </div>
  )
}

/** Microphone dictation: record in-browser, transcribe through Core (pi-voice-stt config). */
function useDictation(onError: (message: string) => void): {
  recording: boolean
  seconds: number
  busy: boolean
  toggle: () => void
} {
  const [recording, setRecording] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const [busy, setBusy] = useState(false)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const timerRef = useRef<number | null>(null)
  const stopRef = useRef<(send: boolean) => void>(() => {})

  const stopTimer = (): void => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current)
      timerRef.current = null
    }
  }

  const transcribe = async (blob: Blob): Promise<void> => {
    setBusy(true)
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onloadend = (): void => resolve(String(reader.result).split(',')[1] ?? '')
        reader.onerror = (): void => reject(new Error('lecture audio impossible'))
        reader.readAsDataURL(blob)
      })
      const res = await studio().chat.transcribe({
        data,
        mimeType: blob.type || 'audio/webm',
      })
      if (!res.ok) {
        onError(res.error && typeof res.error === 'string' ? res.error : 'transcription échouée')
        return
      }
      const text = res.value.text
      if (text) useChatStore.getState().setDraft((useChatStore.getState().draft + text).trimStart())
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const stop = (send: boolean): void => {
    const recorder = recorderRef.current
    if (!recorder) return
    recorderRef.current = null
    stopTimer()
    setRecording(false)
    recorder.onstop = (): void => {
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
      recorder.stream.getTracks().forEach((t) => t.stop())
      if (send && blob.size > 0) void transcribe(blob)
    }
    recorder.stop()
  }
  stopRef.current = stop

  const toggle = (): void => {
    if (recorderRef.current) {
      stop(true)
      return
    }
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        const recorder = new MediaRecorder(stream)
        chunksRef.current = []
        recorder.ondataavailable = (e): void => {
          if (e.data.size > 0) chunksRef.current.push(e.data)
        }
        recorder.start(250)
        recorderRef.current = recorder
        setSeconds(0)
        setRecording(true)
        timerRef.current = window.setInterval(() => {
          setSeconds((s) => {
            if (s >= 119) stop(true)
            return s + 1
          })
        }, 1000)
      })
      .catch(() => onError('micro inaccessible — autorisez le micro pour 127.0.0.1'))
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && recorderRef.current) stopRef.current(false)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      stopTimer()
    }
  }, [])

  return { recording, seconds, busy, toggle }
}

export function ChatDock({
  onClose,
  collapsed,
  onToggleCollapse,
  onResize,
}: {
  onClose: () => void
  collapsed: boolean
  onToggleCollapse: () => void
  onResize?: (width: number) => void
}): React.JSX.Element {
  const tabs = useChatStore((s) => s.tabs)
  const activeId = useChatStore((s) => s.activeId)
  const thread = useChatStore((s) => (s.activeId ? s.threads[s.activeId] : undefined)) ?? NO_THREAD
  const draft = useChatStore((s) => s.draft)
  const error = useChatStore((s) => s.error)
  const pending = useChatStore((s) => s.pending)
  const activeState = tabs.find((t) => t.id === activeId)?.state

  const loadTabs = useChatStore((s) => s.loadTabs)
  const subscribe = useChatStore((s) => s.subscribeToEvents)
  const selectTab = useChatStore((s) => s.selectTab)
  const createTab = useChatStore((s) => s.createTab)
  const closeTab = useChatStore((s) => s.closeTab)
  const setDraft = useChatStore((s) => s.setDraft)
  const send = useChatStore((s) => s.send)
  const cancel = useChatStore((s) => s.cancel)
  const addFiles = useChatStore((s) => s.addFiles)
  const removeFile = useChatStore((s) => s.removeFile)
  const setFolder = useChatStore((s) => s.setFolder)
  const appendSelectionContext = useChatStore((s) => s.appendSelectionContext)
  const folder = useChatStore((s) => s.folder)

  const dictation = useDictation((message) => useChatStore.setState({ error: message }))
  const editing = useChatStore((s) => s.editing)
  const startEditing = useChatStore((s) => s.startEditing)
  const cancelEditing = useChatStore((s) => s.cancelEditing)

  const scrollRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    void loadTabs()
    return subscribe()
  }, [loadTabs, subscribe])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [thread])

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    addFiles(Array.from(e.dataTransfer.files))
  }

  if (collapsed) {
    return (
      <div className="flex h-full w-10 shrink-0 flex-col items-center gap-2 border-l border-border bg-surface py-2">
        {' '}
        <button
          onClick={onToggleCollapse}
          title="Déplier le chat"
          className="rounded p-1 text-zinc-400 hover:bg-panel hover:text-white"
        >
          «
        </button>
        {tabs.map((t) => (
          <span
            key={t.id}
            title={`${t.title} — ${t.state}`}
            className={`mt-1 h-2 w-2 rounded-full ${stateDot(t.state)}`}
          />
        ))}
      </div>
    )
  }

  return (
    <div className="relative flex h-full w-full min-h-0 shrink-0 flex-col border-l border-border bg-surface">
      {onResize && (
        <div
          role="separator"
          aria-orientation="vertical"
          title="Glisser pour redimensionner"
          className="absolute left-0 top-0 z-10 h-full w-1.5 cursor-col-resize hover:bg-sky-500/40"
          onMouseDown={(e) => {
            e.preventDefault()
            const startX = e.clientX
            const startWidth = e.currentTarget.parentElement?.getBoundingClientRect().width ?? 384
            const onMove = (move: MouseEvent): void => {
              onResize(startWidth + (startX - move.clientX))
            }
            const onUp = (): void => {
              window.removeEventListener('mousemove', onMove)
              window.removeEventListener('mouseup', onUp)
              document.body.style.cursor = ''
              document.body.style.userSelect = ''
            }
            document.body.style.cursor = 'col-resize'
            document.body.style.userSelect = 'none'
            window.addEventListener('mousemove', onMove)
            window.addEventListener('mouseup', onUp)
          }}
        />
      )}
      {/* Tab bar */}
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => void selectTab(t.id)}
              title={`${t.title} — ${t.state}`}
              className={`flex shrink-0 items-center gap-1.5 rounded px-2 py-1 text-xs ${
                t.id === activeId ? 'bg-panel text-white' : 'text-zinc-400 hover:bg-panel'
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${stateDot(t.state)}`} />
              <span className="max-w-24 truncate">{t.title}</span>
              {t.id === activeId && (
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation()
                    void closeTab(t.id)
                  }}
                  className="text-zinc-600 hover:text-red-400"
                  title="Fermer l'onglet"
                >
                  ✕
                </span>
              )}
            </button>
          ))}
          <button
            onClick={() => void createTab()}
            title="New Pi session"
            className="shrink-0 rounded px-1.5 py-1 text-xs text-zinc-400 hover:bg-panel hover:text-white"
          >
            +
          </button>
          <button
            onClick={async () => {
              const tab = tabs.find((t) => t.id === activeId)
              const text = tab?.sessionFile || (activeId ?? '')
              try {
                await navigator.clipboard.writeText(text)
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              } catch {
                useChatStore.setState({ error: `Copie impossible — session : ${text}` })
              }
            }}
            title="Copier l'ID/chemin de la session Pi (pour la faire reviewer)"
            className="shrink-0 rounded px-1.5 py-1 text-xs text-zinc-400 hover:bg-panel hover:text-white"
          >
            {copied ? '✓' : '⧉'}
          </button>
        </div>
        {activeState && activeState !== 'idle' && activeState !== 'stopped' && (
          <button
            onClick={() => void cancel()}
            className="rounded bg-red-500/20 px-2 py-1 text-[11px] text-red-300 hover:bg-red-500/30"
            title={
              activeState === 'streaming'
                ? 'Arrêter la génération en cours'
                : 'Annuler le démarrage'
            }
          >
            Stop
          </button>
        )}
        <button
          onClick={onToggleCollapse}
          title="Rabattre le chat"
          className="rounded px-1.5 py-1 text-xs text-zinc-500 hover:bg-panel hover:text-white"
        >
          »
        </button>
        <button
          onClick={onClose}
          title="Close chat"
          className="rounded px-1.5 py-1 text-xs text-zinc-500 hover:bg-panel hover:text-white"
        >
          ✕
        </button>
      </div>

      <RefsBar />
      <TabSettingsBar />

      {/* Thread */}
      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
        {!tabs.length && (
          <div className="mt-8 px-4 text-center text-xs text-zinc-500">
            Aucune session. « + » démarre une session Pi connectée à ce canvas — elle peut créer des
            nodes, les câbler, lancer des rendus, lire tes fichiers.
          </div>
        )}
        {thread.map((entry, i) =>
          entry.kind === 'user' && entry.entryId && startEditing ? (
            <EntryView
              key={i}
              entry={entry}
              onEdit={() => startEditing(entry.entryId as string, entry.text)}
            />
          ) : (
            <EntryView key={i} entry={entry} />
          ),
        )}
        {(activeState === 'streaming' || activeState === 'starting') && (
          <div className="flex items-center gap-2 px-1 text-[11px] text-zinc-400">
            <span className="flex gap-1">
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400 [animation-delay:0ms]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400 [animation-delay:150ms]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400 [animation-delay:300ms]" />
            </span>
            {activeState === 'starting' ? 'démarrage de la session…' : 'réflexion en cours…'}
          </div>
        )}
        {error && (
          <div className="rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-[11px] text-red-300">
            {error}
          </div>
        )}
      </div>

      {/* Composer */}
      <div
        className="shrink-0 border-t border-border p-2"
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
      >
        {!!pending.length && (
          <div className="mb-1.5 flex gap-1">
            {pending.map((p) => (
              <button
                key={p.url}
                onClick={() => removeFile(p.url)}
                title="Retirer"
                className="relative"
              >
                <img src={p.url} alt="" className="h-12 w-12 rounded object-cover" />
                <span className="absolute -right-1 -top-1 rounded-full bg-red-500 px-1 text-[9px] text-white">
                  ✕
                </span>
              </button>
            ))}
          </div>
        )}
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            } else if (e.key === 'Escape' && editing) {
              cancelEditing()
            }
          }}
          placeholder="Demande à l'agent… (Entrée pour envoyer, images en glisser-déposer)"
          rows={3}
          className="w-full resize-none rounded border border-border bg-panel px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-zinc-500"
        />
        <div className="mt-1 flex items-center justify-between">
          <div className="flex items-center gap-0.5">
            {editing && (
              <button
                onClick={cancelEditing}
                className="mr-1 rounded bg-amber-500/20 px-2 py-0.5 text-[11px] text-amber-300 hover:bg-amber-500/30"
                title="Annuler la modification (Échap)"
              >
                ✎ édition — annuler
              </button>
            )}
            <button
              onClick={() => fileRef.current?.click()}
              className="rounded px-1.5 py-0.5 text-[11px] text-zinc-400 hover:bg-panel hover:text-white"
              title="Joindre une image"
            >
              📎
            </button>
            <button
              onClick={dictation.toggle}
              className={`relative rounded px-1.5 py-0.5 text-[11px] ${
                dictation.recording
                  ? 'bg-red-500/20 text-red-300'
                  : dictation.busy
                    ? 'bg-amber-500/20 text-amber-300'
                    : 'text-zinc-400 hover:bg-panel hover:text-white'
              }`}
              title={
                dictation.recording
                  ? 'Enregistrement… re-clique pour transcrire (Échap annule)'
                  : 'Dicter (micro → transcription)'
              }
            >
              {dictation.busy ? '…' : '🎤'}
              {dictation.recording && (
                <span className="absolute -right-1 -top-1 h-2 w-2 animate-pulse rounded-full bg-red-400" />
              )}
            </button>
            {dictation.recording && (
              <span className="text-[11px] tabular-nums text-red-300">{dictation.seconds}s</span>
            )}
            <button
              onClick={() => appendSelectionContext()}
              className="rounded px-1.5 py-0.5 text-[11px] text-zinc-400 hover:bg-panel hover:text-white"
              title="Joindre la sélection du canvas comme contexte"
            >
              🎯
            </button>
            <button
              onClick={() => {
                const path = window.prompt(
                  'Chemin du dossier à explorer (l’agent recevra l’arborescence puis pourra lire les fichiers) :',
                  useChatStore.getState().folder ?? '',
                )
                setFolder(path)
              }}
              className={`rounded px-1.5 py-0.5 text-[11px] ${
                folder
                  ? 'bg-sky-500/20 text-sky-300'
                  : 'text-zinc-400 hover:bg-panel hover:text-white'
              }`}
              title="Référencer un dossier (contexte arborescent)"
            >
              📁{folder ? '●' : ''}
            </button>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              addFiles(Array.from(e.target.files ?? []))
              e.target.value = ''
            }}
          />
          <button
            onClick={() => void send()}
            disabled={!draft.trim() && !pending.length}
            className="rounded bg-zinc-200 px-3 py-1 text-[11px] font-medium text-zinc-900 disabled:opacity-40"
          >
            Envoyer
          </button>
        </div>
      </div>
      <StatsFooter />
    </div>
  )
}
