# Pi chat dock

A tabbed agent chat built into the Studio: each tab is a live
[Pi](https://github.com/earendil-works/pi-coding-agent) session that can drive the canvas
(create/wire/run nodes), read your machine and use hosted NanoGPT models — see
[openchar-pi-chat](https://github.com/cgarrot/openchar-pi-chat) for the companion Pi
extension, the one-shot installer and the full user guide.

## Quickstart

```bash
# 1. this fork, chat branch
git clone -b pi-chat https://github.com/cgarrot/OpenChar
cd OpenChar
npm ci && npm run build:spa          # builds the SPA with the chat dock (dist-web/)

# 2. the Pi extension (graph tools for the agent)
git clone https://github.com/cgarrot/openchar-pi-chat ~/.pi/agent/extensions/openchar

# 3. run Core serving the custom SPA
cd core
INLINE_FRONTEND_ROOT=../dist-web ./webui.sh    # http://127.0.0.1:8848
```

Open the app, click the **⌘** button (top right): the chat dock opens. `+` spawns a Pi
session; the agent names its own tab, streams markdown, shows its actions as tool cards
(node added / wired / rendered) and rides along with your canvas selection as context.

Optional: the [inline-nanogpt](https://github.com/cgarrot/inline-nanogpt) extension
(image/text/video/audio nodes, full model dropdowns) installs from the app's Extensions
dialog by URL.

## What's in this branch

- `core/src/inline_core/studio/chat.py` — the ChatBridge: one `pi --mode rpc` process per
  tab (spawn/resume/kill), `chat:*` RPC channels, `events:chat` streaming, per-tab model +
  thinking control, persistent references, folder context, session stats
- `src/renderer/views/Chat/` + `src/renderer/store/chatStore.ts` — the dock UI: tabs,
  markdown streaming, tool cards, attachments, searchable model picker, collapsible +
  resizable panel, canvas-selection chips
- `src/renderer/views/Moodboard/SearchSelect.tsx` — searchable combobox for any select
  param with 20+ options
- `src/shared/ipc.ts` — the `chat` IPC namespace and types
