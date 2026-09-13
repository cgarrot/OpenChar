/**
 * Pi chat tabs: one live Pi session per tab, driven through Core's chat:* channels.
 * Deltas, tool calls and state arrive on the events:chat frame and fold into a per-tab
 * thread of entries (user bubbles, assistant text, tool cards).
 */
import { create } from 'zustand'
import { studio } from '@/lib/studio'
import { ipcErrorMessage } from '../lib/ipcError'
import { useUiStore } from './uiStore'
import { useMoodboardStore } from './moodboardStore'
import type {
  ChatArchivedSession,
  ChatEvent,
  ChatModelInfo,
  ChatSessionStats,
  ChatTab,
} from '@shared/ipc'

export interface ToolCard {
  tool: string
  args?: unknown
  result?: unknown
  running: boolean
}

export type ThreadEntry =
  | { kind: 'user'; text: string; images: string[]; contextNote?: string; entryId?: string }
  | { kind: 'assistant'; text: string; streaming: boolean }
  | { kind: 'tools'; cards: ToolCard[] }

interface ChatState {
  tabs: ChatTab[]
  activeId: string | null
  threads: Record<string, ThreadEntry[]>
  loaded: Record<string, boolean>
  /** Unsent composer text per tab — survives tab switches and reloads. */
  drafts: Record<string, string>
  /** One queued message per tab, sent when the run ends (or steered in early). */
  queued: Record<string, string>
  error: string | null
  /** Attachments staged in the composer: object URLs for display + the pending Files. */
  pending: Array<{ file: File; url: string }>
  /** A folder whose tree listing will be prepended as agent context on the next send. */
  folder: string | null
  /** Edit-and-resend state: the entry being rewritten (fork) while composing. */
  editing: { entryId: string; original: string } | null
  startEditing: (entryId: string, original: string) => void
  cancelEditing: () => void
  unqueue: (tabId: string) => void
  editQueued: (tabId: string) => void
  steerQueued: (tabId: string) => Promise<void>
  /** Fork from a past user message and replay it verbatim on the fresh branch. */
  replayFrom: (entryId: string, text: string) => Promise<void>
  /** Closed conversations (newest first) + reopen. */
  archived: ChatArchivedSession[]
  loadArchived: () => Promise<void>
  restoreSession: (file: string, title: string) => Promise<void>
  /** Model catalogue for the picker, per tab (loaded on demand). */
  models: ChatModelInfo[]

  subscribeToEvents: () => () => void
  loadTabs: () => Promise<void>
  selectTab: (id: string) => Promise<void>
  createTab: (title?: string) => Promise<void>
  newTabFromContext: () => Promise<void>
  closeTab: (id: string) => Promise<void>
  setDraft: (text: string) => void
  addFiles: (files: File[]) => void
  removeFile: (url: string) => void
  setFolder: (folder: string | null) => void
  appendSelectionContext: () => void
  setModel: (tabId: string, model: string) => Promise<void>
  setThinking: (tabId: string, level: string) => Promise<void>
  loadModels: (tabId: string) => Promise<void>
  loadStats: (tabId: string) => Promise<void>
  stats: ChatSessionStats | null
  addRef: (tabId: string, path: string) => Promise<void>
  removeRef: (tabId: string, path: string) => Promise<void>
  send: () => Promise<void>
  cancel: () => Promise<void>
}

/** Upload a chat attachment to Core's asset store; returns its id (chat:prompt {assetId}). */
async function uploadAsset(file: File): Promise<string | null> {
  try {
    const res = await fetch('/v1/assets', { method: 'POST', body: file })
    if (!res.ok) return null
    const stored = (await res.json()) as { id?: string }
    return stored.id ?? null
  } catch {
    return null
  }
}

/** A Result envelope's error text — ipcErrorMessage() would String() the whole object
 * into "[object Object]". */
function resultError(res: { ok: boolean; error?: unknown }): string {
  if (res.error && typeof res.error === 'string' && res.error.trim()) return res.error
  return ipcErrorMessage(res.error ?? res)
}

/** The canvas selection as a compact context block, or null when nothing is selected. */
function selectionContext(): string | null {
  const ids = new Set(useUiStore.getState().canvasSelection)
  if (!ids.size) return null
  const board = useMoodboardStore.getState()
  const items = board.items
    .filter((i) => ids.has(i.id))
    .map((i) => {
      const data = i.data as Record<string, unknown> | undefined
      const core = (data?.core ?? {}) as Record<string, unknown>
      // Loaders carry the assets they expose — the #1 thing the agent otherwise digs for.
      const loader = (data?.assetIds ?? []) as string[]
      return {
        id: i.id,
        type: core.type ?? i.type,
        params: core.params ?? (typeof data?.promptText === 'string' ? data.promptText : ''),
        ...(loader.length ? { assets: loader } : {}),
      }
    })
  if (!items.length) return null
  const links = board.connectors
    .filter((c) => ids.has(c.fromItemId) && ids.has(c.toItemId))
    .map((c) => `${c.fromItemId} -> ${c.toItemId}`)
  return `[Contexte canvas — sélection actuelle]\n${JSON.stringify({ items, links }, null, 1).slice(0, 4000)}`
}

/** Split a stored user message into display text + a context note (refs/selection blocks
 * are agent food, not something to re-read in the bubble). */
function splitContext(raw: string): { text: string; note: string } {
  const parts = raw.split('\n---\n')
  const tail = (parts.pop() ?? '').replace(/^\(Demande utilisateur[:]?\)\s*/i, '').trim()
  const bits: string[] = []
  for (const part of parts) {
    const folder = part.match(/^\[Contexte dossier:\s*(.+?)\]/m)
    if (folder) bits.push(`dossier ${folder[1].split('/').filter(Boolean).pop()}`)
    else if (part.includes('[Contexte canvas')) bits.push('sélection canvas')
    else if (part.startsWith('[Référence')) bits.push('référence fichier')
  }
  return { text: tail, note: bits.join(' · ') }
}

export const useChatStore = create<ChatState>((set, get) => ({
  tabs: [],
  activeId: null,
  threads: {},
  loaded: {},
  drafts: {},
  queued: {},
  error: null,
  pending: [],
  folder: null,
  /** Edit-and-resend state: the entry being rewritten (fork) while composing. */
  editing: null as { entryId: string; original: string } | null,
  /** Model catalogue for the picker, per tab (loaded on demand). */
  models: [] as ChatModelInfo[],
  stats: null as ChatSessionStats | null,
  archived: [] as ChatArchivedSession[],

  subscribeToEvents: () => {
    // Agent-side canvas mutations push a board refresh, so the user watches the work live.
    const offBoard = studio().events.onBoardChanged(() => {
      void useMoodboardStore.getState().load()
    })
    const off = studio().events.onChat((event: ChatEvent) => {
      const { tabs, threads, activeId } = get()
      // A state frame carries nothing else; refetch the tab list for the badge.
      if (event.kind === 'state') {
        void studio()
          .chat.tabs()
          .then((res) => {
            if (res.ok) set({ tabs: res.value })
          })
        const current = get().activeId
        // After a run settles, rebind entryIds (fork/copy menus) by re-reading the thread's
        // history — live entries lack entryIds until the session file is re-read.
        if (current === event.tabId) {
          const pendingMsg = get().queued[current]
          if (pendingMsg !== undefined) {
            const rest = { ...get().queued } as Record<string, string>
            delete rest[current]
            set({ queued: rest })
            void studio()
              .chat.prompt(current, pendingMsg)
              .then((res2) => {
                if (!res2.ok) set({ error: resultError(res2) })
              })
          }
          const thread = get().threads[current] ?? []
          if (thread.some((e) => e.kind === 'user' && !e.entryId)) {
            set({ loaded: { ...get().loaded, [current]: false } })
            void get().selectTab(current)
          }
        }
        // Refresh usage after each run settles (cost/context moved).
        if (current === event.tabId)
          void studio()
            .chat.stats(current)
            .then((r) => {
              if (r.ok) set({ stats: r.value })
            })
        return
      }
      const thread = threads[event.tabId] ?? []
      const patch = (entries: ThreadEntry[]) => ({
        threads: { ...threads, [event.tabId]: entries },
      })

      if (event.kind === 'delta') {
        const entries = [...thread]
        const i = [...entries].reverse().findIndex((e) => e.kind === 'assistant')
        if (i === -1) {
          entries.push({ kind: 'assistant', text: event.text, streaming: true })
        } else {
          const at = entries.length - 1 - i
          const current = entries[at] as Extract<ThreadEntry, { kind: 'assistant' }>
          entries[at] = { ...current, text: current.text + event.text, streaming: true }
        }
        set(patch(entries))
        return
      }
      if (event.kind === 'message') {
        // The final assistant message replaces the accumulated deltas.
        const entries: ThreadEntry[] = thread.filter((e) => e.kind !== 'assistant')
        if (event.message.role === 'assistant' && event.message.text) {
          entries.push({ kind: 'assistant', text: event.message.text, streaming: false })
          set(patch(entries))
        } else if (event.message.role === 'assistant') {
          set(patch(entries))
        }
        return
      }
      if (event.kind === 'toolCall' || event.kind === 'toolStart') {
        const entries = [...thread]
        const last = entries[entries.length - 1]
        const card: ToolCard = {
          tool: event.tool,
          args: event.kind === 'toolCall' ? event.input : event.args,
          running: true,
        }
        if (last?.kind === 'tools') {
          entries[entries.length - 1] = { kind: 'tools', cards: [...last.cards, card] }
        } else {
          entries.push({ kind: 'tools', cards: [card] })
        }
        set(patch(entries))
        return
      }
      if (event.kind === 'toolEnd') {
        const entries = [...thread]
        for (let i = entries.length - 1; i >= 0; i--) {
          const e = entries[i]
          if (e.kind !== 'tools') continue
          const cards = [...e.cards]
          for (let j = cards.length - 1; j >= 0; j--) {
            if (cards[j].tool === event.tool && cards[j].running) {
              cards[j] = { ...cards[j], running: false, result: event.result }
              entries[i] = { kind: 'tools', cards }
              set(patch(entries))
              return
            }
          }
        }
        return
      }
      if (event.kind === 'error') {
        set({ error: event.error, tabs, activeId })
      }
    })
    return () => {
      off()
      offBoard()
    }
  },

  loadTabs: async () => {
    const res = await studio().chat.tabs()
    if (!res.ok) {
      set({ error: resultError(res) })
      return
    }
    const active = get().activeId ?? res.value[0]?.id ?? null
    set({ tabs: res.value, activeId: active })
    if (active) await get().selectTab(active)
  },

  selectTab: async (id) => {
    let draft = get().drafts[id] ?? ''
    try {
      draft = localStorage.getItem(`chat-draft-${id}`) ?? draft
    } catch {
      /* ignore */
    }
    set({ activeId: id, error: null, drafts: { ...get().drafts, [id]: draft } })
    void get().loadStats(id)
    if (get().loaded[id]) return
    const res = await studio().chat.history(id)
    if (!res.ok) {
      // History is best-effort: a fresh tab has none and a stopped one respawns on next prompt.
      set({ loaded: { ...get().loaded, [id]: true } })
      return
    }
    const entries: ThreadEntry[] = []
    const rawMessages = res.value.messages as Array<{
      role: string
      text: string
      tools?: Array<{ tool: string; input: unknown }>
      entryId?: string
    }>
    for (const m of rawMessages) {
      if (m.role === 'user' && m.text) {
        const { text, note } = splitContext(m.text)
        entries.push({
          kind: 'user',
          text: text || m.text.slice(0, 80),
          images: [],
          contextNote: note || undefined,
          entryId: m.entryId,
        })
      } else if (m.role === 'assistant') {
        if (m.tools?.length)
          entries.push({ kind: 'tools', cards: m.tools.map((t) => ({ ...t, running: false })) })
        if (m.text) entries.push({ kind: 'assistant', text: m.text, streaming: false })
      }
    }
    set({
      threads: { ...get().threads, [id]: entries },
      loaded: { ...get().loaded, [id]: true },
    })
  },

  createTab: async (title) => {
    const res = await studio().chat.createTab(title ? { title } : undefined)
    if (!res.ok) {
      set({ error: resultError(res) })
      return
    }
    await get().loadTabs()
    await get().selectTab(res.value.id)
  },

  /** Clone the current tab's context (refs + model + thinking) into a fresh Pi session. */
  newTabFromContext: async () => {
    const current = get().tabs.find((t) => t.id === get().activeId)
    if (!current) return
    const res = await studio().chat.createTab({
      title: `${current.title} ⟶`,
      model: current.model || undefined,
      thinking: current.thinking || undefined,
      refs: current.refs,
    })
    if (!res.ok) {
      set({ error: resultError(res) })
      return
    }
    await get().loadTabs()
    await get().selectTab(res.value.id)
  },

  closeTab: async (id) => {
    await studio().chat.closeTab(id, true)
    const remaining = get().tabs.filter((t) => t.id !== id)
    set({
      tabs: remaining,
      activeId: get().activeId === id ? (remaining[0]?.id ?? null) : get().activeId,
    })
  },

  setDraft: (text) => {
    const id = get().activeId
    if (!id) return
    set({ drafts: { ...get().drafts, [id]: text } })
    try {
      localStorage.setItem(`chat-draft-${id}`, text)
    } catch {
      /* storage plein/prive : survit au moins au changement d'onglet */
    }
  },

  addFiles: async (files) => {
    // Images go to the composer (vision input); anything else (md, txt, pdf...) becomes a
    // persistent reference chip - uploaded server-side, the agent reads it by name.
    const activeId = get().activeId
    const images = files.filter((f) => f.type.startsWith('image/'))
    const others = files.filter((f) => !f.type.startsWith('image/'))
    if (images.length) {
      set({
        pending: [
          ...get().pending,
          ...images.map((file) => ({ file, url: URL.createObjectURL(file) })),
        ],
      })
    }
    if (others.length && activeId) {
      for (const file of others) {
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onloadend = (): void => resolve(String(reader.result).split(',')[1] ?? '')
          reader.onerror = (): void => reject(new Error('lecture impossible'))
          reader.readAsDataURL(file)
        })
        const res = await studio().chat.uploadRef(activeId, file.name, data)
        if (!res.ok) set({ error: resultError(res) })
        else set({ tabs: get().tabs.map((t) => (t.id === activeId ? res.value : t)) })
      }
    }
  },

  removeFile: (url) => {
    URL.revokeObjectURL(url)
    set({ pending: get().pending.filter((p) => p.url !== url) })
  },

  setFolder: (folder) => set({ folder: folder || null }),

  startEditing: (entryId: string, original: string) => {
    set({ editing: { entryId, original }, error: null })
    get().setDraft(original)
  },

  unqueue: (tabId) => {
    const rest = { ...get().queued } as Record<string, string>
    delete rest[tabId]
    set({ queued: rest })
  },

  editQueued: (tabId) => {
    const text = get().queued[tabId]
    if (text === undefined) return
    get().unqueue(tabId)
    set({ activeId: tabId })
    get().setDraft(text)
  },

  steerQueued: async (tabId) => {
    const text = get().queued[tabId]
    if (text === undefined) return
    get().unqueue(tabId)
    const res = await studio().chat.steer(tabId, text)
    if (!res.ok) set({ error: resultError(res) })
  },

  cancelEditing: () => {
    set({ editing: null })
    get().setDraft('')
  },

  loadArchived: async () => {
    const res = await studio().chat.archivedSessions()
    if (!res.ok) {
      set({ error: resultError(res) })
      return
    }
    set({ archived: res.value })
  },

  restoreSession: async (file, title) => {
    const res = await studio().chat.restoreSession(file, title)
    if (!res.ok) {
      set({ error: resultError(res) })
      return
    }
    await get().loadTabs()
    await get().selectTab(res.value.id)
  },

  replayFrom: async (entryId, text) => {
    const activeId = get().activeId
    if (!activeId) return
    const res = await studio().chat.forkResend(activeId, entryId, text)
    if (!res.ok) {
      set({ error: resultError(res) })
      return
    }
    set({
      threads: { ...get().threads, [activeId]: [] },
      loaded: { ...get().loaded, [activeId]: false },
    })
    await get().selectTab(activeId)
  },

  setModel: async (tabId, model) => {
    const res = await studio().chat.setModel(tabId, model)
    if (!res.ok) {
      set({ error: resultError(res) })
      return
    }
    set({ tabs: get().tabs.map((t) => (t.id === tabId ? res.value : t)) })
  },

  setThinking: async (tabId, level) => {
    const res = await studio().chat.setThinking(tabId, level)
    if (!res.ok) {
      set({ error: resultError(res) })
      return
    }
    set({ tabs: get().tabs.map((t) => (t.id === tabId ? res.value : t)) })
  },

  loadModels: async (tabId) => {
    const res = await studio().chat.models(tabId)
    if (!res.ok) {
      set({ error: resultError(res), models: [] })
      return
    }
    set({ models: res.value })
  },

  loadStats: async (tabId) => {
    const res = await studio().chat.stats(tabId)
    if (res.ok) set({ stats: res.value })
  },

  addRef: async (tabId, path) => {
    const res = await studio().chat.addRef(tabId, path)
    if (!res.ok) {
      set({ error: resultError(res) })
      return
    }
    set({ tabs: get().tabs.map((t) => (t.id === tabId ? res.value : t)) })
  },

  removeRef: async (tabId, path) => {
    const res = await studio().chat.removeRef(tabId, path)
    if (!res.ok) {
      set({ error: resultError(res) })
      return
    }
    set({ tabs: get().tabs.map((t) => (t.id === tabId ? res.value : t)) })
  },

  appendSelectionContext: () => {
    const block = selectionContext()
    if (!block) {
      set({ error: 'Rien de sélectionné sur le canvas.' })
      return
    }
    set({ error: null })
    const cur = get().activeId ? (get().drafts[get().activeId as string] ?? '') : ''
    get().setDraft(`${block}\n(Demande utilisateur:) ${cur}`)
  },

  send: async () => {
    const { activeId, pending, folder, editing } = get()
    const draft = (activeId ? get().drafts[activeId] : '') ?? ''
    if (!activeId || (!draft.trim() && !pending.length)) return
    const text = draft.trim()
    // Auto-contexte : la sélection du canvas accompagne chaque message (l'agent sait de
    // quoi on parle) ; le bouton 🎯 l'insère aussi visiblement dans le draft si voulu.
    let message = text
    if (!text.includes('[Contexte canvas')) {
      const sel = selectionContext()
      if (sel) message = `${sel}\n\n(Demande utilisateur:) ${text}`
    }
    const images: Array<{ assetId: string }> = []
    for (const p of pending) {
      const assetId = await uploadAsset(p.file)
      if (assetId) images.push({ assetId })
      URL.revokeObjectURL(p.url)
    }
    const threads = get().threads
    try {
      if (activeId) localStorage.removeItem(`chat-draft-${activeId}`)
    } catch {
      /* ignore */
    }
    set({
      drafts: activeId ? { ...get().drafts, [activeId]: '' } : get().drafts,
      pending: [],
      folder: null,
      error: null,
      threads: {
        ...threads,
        [activeId]: [
          ...(threads[activeId] ?? []),
          { kind: 'user', text: text || '(images)', images: pending.map((p) => p.url) },
        ],
      },
    })
    const state = get().tabs.find((t) => t.id === activeId)?.state
    if (state === 'streaming' && !editing) {
      // File d'attente : affichée au-dessus du composer — envoyée à la fin du run,
      // ou steerable immédiatement (injectée entre les tool calls en cours).
      set({ queued: { ...get().queued, [activeId]: text } })
      return
    }
    if (editing) {
      set({
        editing: null,
        loaded: { ...get().loaded, [activeId]: false },
        threads: { ...get().threads, [activeId]: [] },
      })
      const res = await studio().chat.forkResend(activeId, editing.entryId, message)
      if (!res.ok) set({ error: resultError(res) })
      else await get().selectTab(activeId)
      return
    }
    const res = await studio().chat.prompt(activeId, message, images, folder ?? undefined)
    if (!res.ok) set({ error: resultError(res) })
  },

  cancel: async () => {
    const id = get().activeId
    if (!id) return
    await studio().chat.cancel(id)
  },
}))
