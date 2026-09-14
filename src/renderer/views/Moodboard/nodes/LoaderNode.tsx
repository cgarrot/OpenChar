import { useEffect, useState } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { portKindColor } from '@shared/coreNodes'
import type { FrameInput } from '@shared/types'
import { useAssetStore } from '../../../store/assetStore'
import { useMoodboardStore } from '../../../store/moodboardStore'
import {
  getAssetDragIds,
  getMediaFileDrag,
  ASSET_DND_TYPE,
  MEDIA_FILE_DND_TYPE,
} from '../../../lib/dnd'
import { LOADER_CHROME_H, LOADER_MIN_BODY, LOADER_MIN_W } from '../../../lib/loaderFit'
import { useMediaContextMenu } from '../../../lib/mediaContextMenu'
import { resolveMedia } from '@/lib/media'
import {
  importFilesToLibrary,
  importMediaUrlToLibrary,
  pickFilesViaInput,
} from '../../../lib/importFiles'
import { useLightboxStore } from '../../../store/lightboxStore'
import { Waveform } from '../../../components/Waveform'
import { MediaBody } from './MediaBody'
import { NodeFrame } from './NodeFrame'
import { ImageGlyph, NodeBadge, NodeBadgeRow, StarIcon, UploadIcon } from './NodeBadge'
import { ThumbStrip } from './ThumbStrip'
import { resolveInputThumbs } from './inputThumbs'

interface LoaderNodeData extends Record<string, unknown> {
  itemId: string
}

/**
 * "Load Assets": a standalone source node (no frame) that holds library asset refs in its item data
 * and feeds its hero (first) asset downstream via the output handle. Freely resizable viewer; add
 * media by dropping onto it or via "Select from Local".
 */
export function LoaderNode({ id, selected }: NodeProps): React.JSX.Element {
  const item = useMoodboardStore((s) => s.items.find((it) => it.id === id))
  const assets = useAssetStore((s) => s.assets)
  const addLoaderAssets = useMoodboardStore((s) => s.addLoaderAssets)
  const updateItem = useMoodboardStore((s) => s.updateItem)

  // Ctrl+V sur ce node = ajouter l'image du presse-papier directement dedans.
  // Le plus court chemin pour importer une ref visuelle depuis le web.
  useEffect(() => {
    if (!selected) return
    const onKey = async (e: KeyboardEvent): Promise<void> => {
      if (!(e.ctrlKey || e.metaKey) || e.key !== 'v') return
      const target = e.target as HTMLElement
      if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') return
      try {
        const items = await navigator.clipboard.read()
        const imageItem = items
          .flatMap((ci) => ci.types.map((type) => ({ ci, type })))
          .find(({ type }) => type.startsWith('image/'))
        if (!imageItem) return
        e.preventDefault()
        const blob = await imageItem.ci.getType(imageItem.type)
        const file = new File([blob], `pasted-${Date.now()}.png`, { type: imageItem.type })
        const res = await fetch(
          `/upload?fileName=${encodeURIComponent(file.name)}&kind=${file.type}`,
          { method: 'POST', body: file },
        )
        if (!res.ok) return
        const asset = (await res.json()) as { id?: string }
        if (asset.id) void addLoaderAssets(id, [asset.id])
      } catch {
        /* clipboard indisponible */
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected, id, addLoaderAssets])
  const removeLoaderAsset = useMoodboardStore((s) => s.removeLoaderAsset)
  const setLoaderHero = useMoodboardStore((s) => s.setLoaderHero)
  const onMediaContextMenu = useMediaContextMenu()
  const openLightbox = useLightboxStore((s) => s.open)
  const [idx, setIdx] = useState(0)
  const [dropActive, setDropActive] = useState(false)

  const assetIds = item?.data.assetIds ?? []
  // Shape the asset refs like frame inputs so the shared thumbnail resolver handles them.
  const asInputs: FrameInput[] = assetIds.map((assetId, position) => ({
    id: assetId,
    frameId: id,
    assetId,
    sourceFrameId: null,
    position,
    handle: null,
  }))
  const thumbs = resolveInputThumbs(asInputs, {
    assets,
    allFrames: [],
    takesByFrame: {},
    inputsByFrame: {},
  })
  const count = thumbs.length
  const safeIdx = count ? Math.min(idx, count - 1) : 0
  const cur = count ? thumbs[safeIdx] : undefined

  const addLocalFiles = async (files: File[]): Promise<void> => {
    if (files.length === 0) return
    const added = await importFilesToLibrary(files, null)
    if (added.length) {
      await useAssetStore.getState().load()
      void addLoaderAssets(
        id,
        added.map((a) => a.id),
      )
    }
  }
  const selectLocal = (): void => {
    void pickFilesViaInput().then(addLocalFiles)
  }

  // execCommand('paste') from a click = NO permission popup (unlike navigator.clipboard.read
  // which prompts every time in Firefox). The paste event carries clipboardData for free.
  const pasteFromClipboard = (): void => {
    const input = document.createElement('textarea')
    input.style.cssText = 'position:fixed;top:-100px;left:-100px;opacity:0'
    document.body.appendChild(input)
    input.focus()

    let handled = false
    input.addEventListener('paste', (e) => {
      e.preventDefault()
      handled = true
      const files = Array.from(e.clipboardData?.files || [])
      const images = files.filter((f) => f.type.startsWith('image/'))
      if (images.length > 0) {
        void addLocalFiles(images)
      } else {
        // fallback: URL texte
        const text = e.clipboardData?.getData('text') || ''
        if (text.startsWith('http') && /\.(png|jpe?g|webp|gif)$/i.test(text.split('?')[0])) {
          void importMediaUrlToLibrary(text, text.split('/').pop() || 'image.png').then((asset) => {
            if (asset) {
              void useAssetStore.getState().load()
              void addLoaderAssets(id, [asset.id])
            }
          })
        }
      }
      input.remove()
    })

    // execCommand from a user gesture (this click) = no permission needed
    const ok = document.execCommand('paste')
    if (!ok || !handled) {
      input.remove()
      // Last resort: the async API (may prompt in Firefox, but better than nothing)
      void (async () => {
        try {
          const items = await navigator.clipboard.read()
          for (const ci of items) {
            const type = ci.types.find((t) => t.startsWith('image/'))
            if (!type) continue
            const blob = await ci.getType(type)
            const file = new File([blob], `pasted-${Date.now()}.png`, { type })
            await addLocalFiles([file])
            return
          }
        } catch {
          /* clipboard indisponible */
        }
      })()
    }
  }

  const isFileDrag = (e: React.DragEvent): boolean => e.dataTransfer.types.includes('Files')
  const canDrop = (e: React.DragEvent): boolean =>
    e.dataTransfer.types.includes(ASSET_DND_TYPE) ||
    e.dataTransfer.types.includes(MEDIA_FILE_DND_TYPE) ||
    isFileDrag(e)

  const onDragOver = (e: React.DragEvent): void => {
    if (!canDrop(e)) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
    if (!dropActive) setDropActive(true)
  }

  const onDrop = (e: React.DragEvent): void => {
    if (!canDrop(e)) return
    e.preventDefault()
    e.stopPropagation()
    setDropActive(false)
    if (isFileDrag(e)) {
      void addLocalFiles(Array.from(e.dataTransfer.files ?? []))
      return
    }
    // A Core-node output (raw media file) → import into the library, then hold it.
    const media = getMediaFileDrag(e.dataTransfer)
    if (media) {
      void (async () => {
        const asset = await importMediaUrlToLibrary(resolveMedia(media.filePath), media.name)
        if (!asset) return
        await useAssetStore.getState().load()
        void addLoaderAssets(id, [asset.id])
      })()
      return
    }
    const ids = getAssetDragIds(e.dataTransfer).filter((a) => !assetIds.includes(a))
    if (ids.length) void addLoaderAssets(id, ids)
  }

  const heroName = cur ? (assets.find((a) => a.id === cur.assetId)?.name ?? 'asset') : 'asset'
  // Audio renders as a waveform, so the media body only ever sees the other two kinds.
  const mediaKind: 'image' | 'video' = cur?.kind === 'video' ? 'video' : 'image'

  return (
    <div className="group">
      <NodeBadgeRow dragNodeId={id}>
        <NodeBadge
          icon={<ImageGlyph />}
          title={item?.data?.name || 'Load Assets — double-clic pour renommer'}
        >
          {item?.data?.name || 'Load Assets'}
        </NodeBadge>
        <button
          onClick={() => {
            const current = item?.data?.name || ''
            const name = window.prompt('Nom de cette référence :', current)
            if (name !== null) {
              void updateItem(id, {
                data: { ...(item?.data || {}), name: name.trim() || undefined },
              })
            }
          }}
          className="nodrag ml-0.5 rounded px-1 text-[9px] text-zinc-500 opacity-0 transition-opacity hover:text-white group-hover:opacity-100"
          title="Renommer (double-clic sur le titre)"
        >
          ✎
        </button>
      </NodeBadgeRow>

      <NodeFrame
        id={id}
        selected={!!selected}
        minWidth={LOADER_MIN_W}
        minHeight={LOADER_MIN_BODY + LOADER_CHROME_H}
        padded={false}
        subtleSelect
      >
        <div
          className="relative flex h-full w-full flex-col"
          onDragOver={onDragOver}
          onDragLeave={() => setDropActive(false)}
          onDrop={onDrop}
        >
          <div className="relative flex flex-1 items-center justify-center overflow-hidden bg-black">
            {cur ? (
              cur.kind === 'audio' ? (
                <div className="flex h-full w-full items-center px-2">
                  <Waveform url={cur.waveform ?? null} className="h-1/2 w-full text-emerald-400" />
                </div>
              ) : (
                <MediaBody
                  src={cur.url}
                  kind={mediaKind}
                  poster={cur.poster}
                  onContextMenu={(e) =>
                    onMediaContextMenu(e, { src: cur.saveSrc, name: heroName, kind: mediaKind })
                  }
                  onDoubleClick={() =>
                    openLightbox({ src: cur.saveSrc, kind: mediaKind, name: heroName })
                  }
                />
              )
            ) : (
              <div className="flex flex-col items-center gap-2 p-3 text-center">
                <span className="text-[11px] text-zinc-500">
                  Drag an image or video here, from the Library or your computer.
                </span>
                <button
                  onClick={selectLocal}
                  className="nodrag flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1 text-[11px] text-zinc-200 hover:border-zinc-500 hover:text-white"
                >
                  <UploadIcon className="h-3.5 w-3.5" />
                  Select from Local
                </button>
                <button
                  onClick={pasteFromClipboard}
                  title="Paste an image from your clipboard (copy from the web, then click)"
                  className="nodrag flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1 text-[11px] text-zinc-200 hover:border-zinc-500 hover:text-white"
                >
                  📋 Paste
                </button>
              </div>
            )}

            {count > 1 && (
              <>
                <ThumbStrip
                  items={thumbs.map((t) => ({
                    id: t.id,
                    url: t.url,
                    kind: t.kind,
                    poster: t.poster,
                  }))}
                  selected={safeIdx}
                  onSelect={setIdx}
                  onRemove={(i) => void removeLoaderAsset(id, thumbs[i].id)}
                />
                {safeIdx === 0 ? (
                  <span className="absolute left-1 top-1 flex items-center gap-1 rounded bg-emerald-500/80 px-1 py-0.5 text-[9px] font-medium text-white">
                    <StarIcon filled className="h-2.5 w-2.5" />
                    Hero
                  </span>
                ) : (
                  <button
                    onClick={() => void setLoaderHero(id, thumbs[safeIdx].id)}
                    title="Use this asset as the hero (fed downstream)"
                    className="nodrag absolute left-1 top-1 flex items-center gap-1 rounded bg-black/60 px-1 py-0.5 text-[9px] text-amber-300 hover:bg-black/80"
                  >
                    <StarIcon className="h-2.5 w-2.5" />
                    Set hero
                  </button>
                )}
              </>
            )}
          </div>

          {cur && (
            <div className="flex items-center justify-end border-t border-border bg-surface/90 px-2 py-1">
              <button
                onClick={selectLocal}
                title="Add media from your computer"
                className="nodrag flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-zinc-300 hover:bg-black/40 hover:text-white"
              >
                <UploadIcon className="h-3 w-3" />
                Select from Local
              </button>
              <button
                onClick={pasteFromClipboard}
                title="Paste from clipboard"
                className="nodrag ml-1 flex items-center rounded px-1.5 py-0.5 text-[10px] text-zinc-300 hover:bg-black/40 hover:text-white"
              >
                📋
              </button>
            </div>
          )}

          {dropActive && (
            <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-md border-2 border-dashed border-accent bg-accent/15 text-[11px] font-medium text-panel">
              Add asset
            </div>
          )}
        </div>
      </NodeFrame>

      <Handle
        type="source"
        id="out"
        position={Position.Right}
        title="Output"
        // Coloured by what it emits, so it matches the image sockets it wires into.
        style={{ background: portKindColor('image') }}
        className="group !h-3 !w-3 !border-2 !border-surface"
      >
        <span className="pointer-events-none absolute left-full top-1/2 ml-1.5 hidden -translate-y-1/2 items-center whitespace-nowrap rounded-md border border-border bg-panel/95 px-1.5 py-0.5 text-[10px] font-medium text-zinc-200 shadow-sm backdrop-blur group-hover:flex">
          Output
        </span>
      </Handle>
    </div>
  )
}

export type { LoaderNodeData }
