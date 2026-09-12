/**
 * A searchable select: for param lists too long to scan (the NanoGPT model dropdowns carry
 * 200-600 ids). Shows the current pick as a button; clicking opens a popover with a filter
 * input and a capped list of matches. Falls back to nothing - callers keep their native
 * <select> for short lists.
 */
import { useEffect, useMemo, useRef, useState } from 'react'

export interface SearchOption {
  value: string
  label: string
}

const MATCH_CAP = 120

export function SearchSelect({
  value,
  options,
  onPick,
  placeholder = 'Rechercher…',
  emptyLabel,
}: {
  value: string
  options: SearchOption[]
  onPick: (value: string) => void
  placeholder?: string
  emptyLabel?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const current = options.find((o) => o.value === value)

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options.slice(0, MATCH_CAP)
    return options
      .filter((o) => o.value.toLowerCase().includes(q) || o.label.toLowerCase().includes(q))
      .slice(0, MATCH_CAP)
  }, [options, query])

  useEffect(() => {
    if (!open) return
    inputRef.current?.focus()
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={rootRef} className="relative min-w-0 flex-1">
      <button
        type="button"
        onClick={() => {
          setOpen(!open)
          setQuery('')
        }}
        className="flex w-full items-center justify-between gap-1 truncate rounded border border-border bg-panel px-2 py-1 text-left text-xs text-zinc-200 hover:border-zinc-500"
        title={current?.label ?? value}
      >
        <span className="truncate">{current ? current.label : value || emptyLabel || ''}</span>
        <span className="shrink-0 text-zinc-500">▾</span>
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-max min-w-full max-w-96 rounded border border-border bg-surface p-1 shadow-xl">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && matches.length) {
                onPick(matches[0].value)
                setOpen(false)
              }
            }}
            placeholder={placeholder}
            className="mb-1 w-full rounded border border-border bg-panel px-2 py-1 text-xs text-zinc-100 outline-none focus:border-zinc-500"
          />
          <div className="max-h-64 overflow-y-auto">
            {emptyLabel !== undefined && !query.trim() && (
              <button
                type="button"
                onClick={() => {
                  onPick('')
                  setOpen(false)
                }}
                className="block w-full truncate rounded px-2 py-1 text-left text-xs text-zinc-400 hover:bg-panel"
              >
                {emptyLabel}
              </button>
            )}
            {matches.map((o) => (
              <button
                key={o.value}
                type="button"
                onClick={() => {
                  onPick(o.value)
                  setOpen(false)
                }}
                className={`block w-full truncate rounded px-2 py-1 text-left text-xs hover:bg-panel ${
                  o.value === value ? 'bg-panel font-medium text-white' : 'text-zinc-300'
                }`}
                title={o.label}
              >
                {o.label}
              </button>
            ))}
            {!matches.length && (
              <div className="px-2 py-1 text-xs text-zinc-500">aucune correspondance</div>
            )}
          </div>
          {options.length > MATCH_CAP && (
            <div className="border-t border-border/60 px-2 py-0.5 text-[10px] text-zinc-600">
              {options.length} options — tape pour filtrer (120 affichées)
            </div>
          )}
        </div>
      )}
    </div>
  )
}
