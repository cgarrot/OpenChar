"""The Pi chat bridge: one `pi --mode rpc` process per tab, driven over JSONL stdio.

The browser panel talks to the ``chat:*`` RPC channels; agent events stream back on the
``events:chat`` WebSocket frame (``{tabId, kind, ...}``), reusing the studio event bus.
Each tab owns a Pi session file under <app data>/chat/sessions/, so tabs survive a Core
restart (the process is respawned and the session switched back on demand).

The agent's graph powers come from the ``openchar`` Pi extension (graph_add_node, ...) which
calls this same server's ``/rpc`` — the UI and the agent share one source of truth.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import logging
import os
import re
import shutil
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any

logger = logging.getLogger("inline_core.studio.chat")

#: Where the pi binary lives. PATH first, then the known pi-node install.
_PI_FALLBACK = str(Path.home() / ".local/share/pi-node/node-v22.23.2-linux-x64/bin/pi")

#: Seconds without any stdout line before a starting tab is considered broken. Generous:
#: extension-heavy pi setups (mesh, goals, webbridge…) flood UI requests during startup and can
#: hold the first get_state — let alone a session switch — past 20s.
_STARTUP_TIMEOUT = 45.0
#: Pi frames can be huge (get_available_models lists every model with costs): the default
#: 64 KiB asyncio readline limit raises LimitOverrunError and would kill the reader task.
_STREAM_LIMIT = 16 * 1024 * 1024


#: The canvas-assistant behaviour appended to every chat tab's pi session. Without it the tab
#: behaves like a file-explorer coding agent: it re-lists the board, digs for asset files and
#: reads binaries — one trivial question cost 5 tool calls and a 2 MB file read (session review,
#: 2026-09-12).
_CHAT_SYSTEM_PROMPT = """
You are the assistant embedded in OpenChar Studio's chat panel. The user is a creative working
on a node canvas (image/video/audio generation); you can act on it through the graph_* tools.

Ground rules:
- Every message carries a "[Contexte canvas]" block when something is selected (item types,
  key params, links); persistent folder references are injected ONCE per session and remain
  valid for the whole conversation. USE the provided context; call graph_list_nodes only when
  you truly need the WHOLE board.
- Answer questions from the provided context FIRST. "What is this node?"-style questions need
  ZERO tool calls.
- Prefer the FEWEST actions that satisfy the request. Never add unrequested nodes, never
  "improve" the graph unprompted. Batch related changes into one turn.
- PIPELINES: when asked to build one, chain EVERYTHING — every generator's output feeds the
  next stage (a fusion node can take several images wired into its image input). Nothing left
  isolated. Announce the plan in one short list BEFORE building, then build; the user watches
  the canvas live. BUILDING IS HALF THE JOB: run it too (graph_run on the final node, wait),
  verify takes (graph_item_info) and diagnose failures (activity_recent). The skill
  "openchar-pipelines" has the full recipe — follow it for character-design pipelines.
- NEVER read binary/media files (png/jpg/webp/mp4/mp3/wav/pdf/safetensors) with read — assets
  are data, not text. Rely on context, file names and sizes, or assets metadata.
- Creating nodes: check graph_list_node_types once, then create; every tool returns the ids you
  will need for wiring. nanogpt models: nanogpt_model_docs gives the exact per-model parameters
  before you configure a node.
- Be concise, answer in the user's language.
- PROJECTS: the "[Projet actif : …]" line in each message names the project your graph tools
  operate on. If it changed since your last action, the board you knew is NOT the one you see
  now — re-list before mutating anything.
- Naming: right after your first substantive answer, give the tab a short LOGICAL name (2-4 plain
  words describing the conversation topic, e.g. "Génération phare tempête" or "Pipeline vidéo
  H3") by calling chat_set_title once. Never catchy or generic ("Discussion", "Assistant");
  never rename again unless the topic clearly changes.
"""


def _pi_bin() -> str:
    found = shutil.which("pi")
    if found:
        return found
    return _PI_FALLBACK if Path(_PI_FALLBACK).exists() else "pi"


class ChatError(RuntimeError):
    """A user-readable chat failure."""


class _Tab:
    def __init__(self, tab_id: str, title: str, model: str, cwd: str,
                 session_file: str = "", refs: list[str] | None = None,
                 thinking: str = "") -> None:
        self.id = tab_id
        self.title = title
        self.model = model
        self.cwd = cwd
        #: Last known Pi session file — set from get_state, used to resume after a restart.
        self.session_file = session_file
        #: Persistent references (dirs/files) whose context is prepended to every prompt.
        self.refs: list[str] = list(refs or [])
        #: Subset of refs flagged "deep": a repository's whole text content is injected,
        #: not just its tree — the agent must not browse at its own discretion.
        self.deep_refs: list[str] = []
        #: Signature of the refs context already delivered this session — refs are injected
        #: ONCE (re-injected only when the list changes or after a fork rewinds the branch).
        self.refs_sent: str = ""
        #: Last applied thinking level (off/minimal/low/medium/high/...), "" = model default.
        self.thinking = thinking
        self.process: asyncio.subprocess.Process | None = None
        self.reader: asyncio.Task[Any] | None = None
        self.state = "stopped"  # stopped | starting | idle | streaming | error
        self.last_error = ""
        self.last_activity = 0.0
        #: RPC command correlation: id -> Future resolved by the response frame.
        self.pending: dict[str, asyncio.Future[Any]] = {}

    def to_json(self) -> dict[str, Any]:
        return {
            "id": self.id, "title": self.title, "model": self.model, "cwd": self.cwd,
            "state": self.state, "lastError": self.last_error,
            "lastActivity": int(self.last_activity * 1000),
            "refs": self.refs, "deepRefs": self.deep_refs, "thinking": self.thinking,
            "sessionFile": self.session_file, "refsSent": self.refs_sent,
        }


#: Provider families the dock's transcription reuses — same config file as pi-voice-stt.
_STT_ENDPOINTS = {
    "mistral": "https://api.mistral.ai/v1/audio/transcriptions",
    "openai": "https://api.openai.com/v1/audio/transcriptions",
    "groq": "https://api.groq.com/openai/v1/audio/transcriptions",
}
_STT_KEY_ENV = {"mistral": "MISTRAL_API_KEY", "openai": "OPENAI_API_KEY", "groq": "GROQ_API_KEY"}


class ChatBridge:
    """Owns the chat tabs and their Pi processes."""

    def __init__(self, store: Any, events: Any, assets: Any = None) -> None:
        self._store = store
        self._events = events
        self._assets = assets
        app_data = Path(getattr(store, "_app_data", Path(".inline-app")))
        self._root = app_data / "chat"
        self._sessions = self._root / "sessions"
        self._root.mkdir(parents=True, exist_ok=True)
        self._sessions.mkdir(parents=True, exist_ok=True)
        self._tabs: dict[str, _Tab] = {}
        self._load_tabs()

    # --- persistence ---------------------------------------------------------------------------

    def _tabs_file(self) -> Path:
        return self._root / "tabs.json"

    def _load_tabs(self) -> None:
        try:
            raw = json.loads(self._tabs_file().read_text(encoding="utf-8"))
            for entry in raw.get("tabs", []):
                tab = _Tab(str(entry["id"]), str(entry.get("title", "Chat")),
                           str(entry.get("model", "")), str(entry.get("cwd", "") or self._default_cwd()),
                           str(entry.get("sessionFile", "")),
                           [str(r) for r in entry.get("refs", []) if r],
                           str(entry.get("thinking", "")))
                tab.refs_sent = str(entry.get("refsSent", ""))
                tab.deep_refs = [str(d) for d in entry.get("deepRefs", []) if d]
                self._tabs[tab.id] = tab
        except (OSError, ValueError, KeyError):
            pass

    def _save_tabs(self) -> None:
        payload = {"tabs": [
            {"id": t.id, "title": t.title, "model": t.model, "cwd": t.cwd,
             "sessionFile": t.session_file, "refs": t.refs, "deepRefs": t.deep_refs,
             "thinking": t.thinking, "refsSent": t.refs_sent}
            for t in self._tabs.values()
        ]}
        self._tabs_file().write_text(json.dumps(payload, indent=2), encoding="utf-8")

    def _default_cwd(self) -> str:
        workspace = getattr(self._store, "_workspace", None)
        return str(workspace) if workspace else str(Path.home())

    # --- RPC channels --------------------------------------------------------------------------

    def list_tabs(self) -> list[dict[str, Any]]:
        return [t.to_json() for t in self._tabs.values()]

    async def create_tab(self, inp: dict[str, Any] | None = None) -> dict[str, Any]:
        inp = inp or {}
        title = str(inp.get("title") or f"Chat {len(self._tabs) + 1}")
        model = str(inp.get("model") or "")
        cwd = str(inp.get("cwd") or self._default_cwd())
        tab = _Tab(uuid.uuid4().hex[:12], title, model, cwd,
                   refs=[str(r) for r in inp.get("refs", []) if r],
                   thinking=str(inp.get("thinking") or ""))
        # Restoring an archived session: pre-point the tab at the existing .jsonl — the next
        # prompt respawns pi and switch_session rewinds onto it.
        if inp.get("sessionFile"):
            candidate = self._sessions / Path(str(inp["sessionFile"])).name
            if candidate.suffix == ".jsonl" and candidate.is_file():
                tab.session_file = str(candidate)
        self._tabs[tab.id] = tab
        self._save_tabs()
        await self._ensure_process(tab)
        return tab.to_json()

    async def close_tab(self, tab_id: str, kill: bool = True) -> dict[str, Any]:
        tab = self._tab(tab_id)
        if kill:
            await self._stop(tab)
        # Without kill the tab entry stays (session file kept); a later prompt respawns it.
        if kill:
            del self._tabs[tab_id]
            self._save_tabs()
        return {"id": tab_id, "closed": True}

    def rename_tab(self, tab_id: str, title: str, auto: bool = False) -> dict[str, Any]:
        """Rename a tab. ``auto`` (the agent naming its own tab) only applies while the title is
        still the default, so a user-given name is never overwritten."""
        tab = self._tab(tab_id)
        if auto and not re.match(r"^Chat \d+$", tab.title):
            return tab.to_json()
        tab.title = str(title or tab.title).strip()[:60] or tab.title
        self._save_tabs()
        self._emit(tab, {"kind": "state"})
        return tab.to_json()

    async def prompt(self, tab_id: str, message: str,
                     images: list[dict[str, Any]] | None = None,
                     folder: str = "") -> dict[str, Any]:
        tab = self._tab(tab_id)
        await self._ensure_process(tab)
        images = images or []
        payload_images = []
        for image in images:
            resolved = self._resolve_image(image)
            if resolved is not None:
                payload_images.append(resolved)
        text = str(message)
        contexts: list[str] = []
        # The ACTIVE project rides with every message: graph tools operate on whatever project
        # the server has open, and the agent must never guess which board it is mutating —
        # switching project tabs changes it under its feet.
        active = self._store.project_ref()
        if active is not None:
            # The path matters: the per-project film memory lives at <path>/film-memory.yaml.
            contexts.append(f"[Projet actif : {active.name} — {active.folder}]")
        # Persistent refs ride ONCE per session: re-sending a folder tree with every message
        # burns tokens for no gain. Re-injected when the list changes (new signature) — and
        # cleared after a fork, since the branch rewind may drop the earlier injection.
        signature = "\n".join(f"{ref}{'[deep]' if ref in tab.deep_refs else ''}" for ref in tab.refs)
        if signature != tab.refs_sent:
            if tab.refs:
                contexts.append(
                    "[Contexte persistant — injecté une fois par session, il reste valable pour "
                    "toute la conversation]\n" + "\n\n".join(
                        self._ref_context(ref, deep=ref in tab.deep_refs) for ref in tab.refs
                    )
                )
            tab.refs_sent = signature
            self._save_tabs()
        if folder:
            contexts.append(self._folder_context(str(folder)))
        if contexts:
            text = "\n\n---\n\n".join(contexts) + f"\n\n---\n\n{text}"
        command: dict[str, Any] = {"id": uuid.uuid4().hex[:8], "type": "prompt",
                                   "message": text}
        if payload_images:
            command["images"] = payload_images
        # Queue as a steering message when the agent is mid-run, so a second message never errors.
        if tab.state == "streaming":
            command["streamingBehavior"] = "steer"
        await self._send(tab, command)
        tab.last_activity = time.time()
        return {"id": tab_id, "accepted": True}

    async def cancel(self, tab_id: str) -> dict[str, Any]:
        tab = self._tab(tab_id)
        if tab.process is not None:
            await self._send(tab, {"type": "clear_queue"})
            await self._send(tab, {"type": "abort"})
        return {"id": tab_id, "cancelled": True}

    async def steer(self, tab_id: str, message: str) -> dict[str, Any]:
        """Inject a message mid-run: pi delivers it after the current tool calls, before the
        next LLM turn — the non-destructive 'cut in' of the queued-message UI."""
        tab = self._tab(tab_id)
        await self._ensure_process(tab)
        await self._send(tab, {"id": uuid.uuid4().hex[:8], "type": "steer",
                                "message": str(message)})
        return {"id": tab_id, "steered": True}

    async def set_model(self, tab_id: str, model: str) -> dict[str, Any]:
        """model is 'provider/id' (as listed by chat:models)."""
        tab = self._tab(tab_id)
        await self._ensure_process(tab)
        provider, _, model_id = str(model).partition("/")
        if not model_id:
            raise ChatError("Format attendu: provider/id (ex: anthropic/claude-sonnet-4)")
        await self._command(tab, {"type": "set_model", "provider": provider,
                                  "modelId": model_id})
        tab.model = str(model)
        self._save_tabs()
        self._emit(tab, {"kind": "state"})
        return tab.to_json()

    async def set_thinking(self, tab_id: str, level: str) -> dict[str, Any]:
        tab = self._tab(tab_id)
        await self._ensure_process(tab)
        await self._command(tab, {"type": "set_thinking_level", "level": str(level)})
        tab.thinking = str(level)
        self._save_tabs()
        self._emit(tab, {"kind": "state"})
        return tab.to_json()

    async def models(self, tab_id: str) -> list[dict[str, Any]]:
        """The models this pi can use (providers configured on the machine)."""
        tab = self._tab(tab_id)
        await self._ensure_process(tab)
        data = await self._command(tab, {"type": "get_available_models"})
        out: list[dict[str, Any]] = []
        for model in ((data or {}).get("models") or []) if isinstance(data, dict) else []:
            if not isinstance(model, dict):
                continue
            model_id = str(model.get("id") or "?")
            provider = str(model.get("provider") or "?")
            out.append({"id": f"{provider}/{model_id}",
                        "name": str(model.get("name") or model_id),
                        "thinking": bool(model.get("reasoning"))})
        return out

    async def stats(self, tab_id: str) -> dict[str, Any]:
        """Token/cost/context usage of the tab's session (pi get_session_stats)."""
        tab = self._tab(tab_id)
        if tab.process is None or tab.process.returncode is not None:
            return {"available": False}
        data = await self._command(tab, {"type": "get_session_stats"})
        return {"available": True, **(data if isinstance(data, dict) else {})}

    # --- transcription (dictée) -----------------------------------------------------------------

    def _stt_config(self) -> dict[str, Any]:
        """The provider block from ~/.pi/agent/stt.json (pi-voice-stt's config), best-effort."""
        import contextlib as _ctx

        path = Path.home() / ".pi" / "agent" / "stt.json"
        with _ctx.suppress(OSError, ValueError):
            cfg = json.loads(path.read_text(encoding="utf-8"))
            profile = str(cfg.get("profile") or "")
            if profile and isinstance(cfg.get("profiles"), dict):
                override = cfg["profiles"].get(profile)
                if isinstance(override, dict):
                    merged = {**cfg, **override}
                    merged["profiles"] = cfg["profiles"]
                    cfg = merged
            if isinstance(cfg.get("provider"), dict):
                return cfg
        return {}

    async def transcribe(self, inp: dict[str, Any]) -> dict[str, Any]:
        """Browser audio (base64) -> transcript, via the pi-voice-stt provider config.
        Supports the OpenAI-compatible multipart family (mistral/openai/groq/openai-compatible)."""
        import binascii
        import uuid as _uuid

        data = str((inp or {}).get("data", ""))
        if not data:
            raise ChatError("Aucun audio reçu.")
        try:
            audio = base64.b64decode(data, validate=False)
        except (binascii.Error, ValueError) as error:
            raise ChatError(f"Audio illisible : {error}") from None

        cfg = self._stt_config()
        provider = dict(cfg.get("provider") or {})
        kind = str(provider.get("type", "mistral"))
        if kind not in _STT_ENDPOINTS and kind != "openai-compatible":
            raise ChatError(
                f"Provider STT « {kind} » non supporté par le dock (mistral/openai/groq/"
                "openai-compatible). Dictée TUI : Ctrl+R."
            )
        endpoint = str(provider.get("endpoint") or _STT_ENDPOINTS.get(kind, ""))
        if not endpoint:
            raise ChatError("Aucun endpoint STT configuré (~/.pi/agent/stt.json → provider.endpoint).")

        key = str(provider.get("apiKey") or "")
        if not key:
            env_name = str(provider.get("apiKeyEnv") or _STT_KEY_ENV.get(kind, ""))
            key = os.environ.get(env_name, "").strip()
        if not key and provider.get("apiKeyFile"):
            key = self._read_key_file(
                Path(str(provider["apiKeyFile"])).expanduser(),
                str(provider.get("apiKeyEnv") or _STT_KEY_ENV.get(kind, "")),
            )
        if not key:
            raise ChatError(
                "Clé STT introuvable (provider.apiKey / apiKeyEnv / apiKeyFile dans stt.json)."
            )

        model = str(provider.get("model") or "")
        if not model:
            raise ChatError("Aucun modèle STT configuré (provider.model dans stt.json).")
        language = str((inp.get("language") or provider.get("language") or "")).strip() or None
        mime = str(inp.get("mimeType") or "audio/webm")
        ext = {"audio/ogg": ".ogg", "audio/webm": ".webm", "audio/mp4": ".m4a",
               "audio/mpeg": ".mp3", "audio/wav": ".wav", "audio/x-wav": ".wav"}.get(
                   mime.split(";")[0].strip(), ".webm")

        boundary = "----opencharstt" + _uuid.uuid4().hex
        fields = {"model": model, "file": (f"recording{ext}", audio, mime.split(";")[0])}
        if language:
            fields["language"] = language
        body = bytearray()
        for name, value in fields.items():
            body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"".encode())
            if isinstance(value, tuple):
                filename, blob, file_mime = value
                body += f"; filename=\"{filename}\"\r\nContent-Type: {file_mime}\r\n\r\n".encode()
                body += blob + b"\r\n"
            else:
                body += f"\r\n\r\n{value}\r\n".encode()
        body += f"--{boundary}--\r\n".encode()

        request = urllib.request.Request(
            endpoint, data=bytes(body), method="POST",
            headers={"Authorization": f"Bearer {key}", "Accept": "application/json",
                     "Content-Type": f"multipart/form-data; boundary={boundary}"},
        )
        loop = asyncio.get_running_loop()

        def _post() -> dict[str, Any]:
            with urllib.request.urlopen(request, timeout=120) as response:
                return json.loads(response.read() or b"{}")

        try:
            payload = await loop.run_in_executor(None, _post)
        except urllib.error.HTTPError as error:
            raise ChatError(f"STT HTTP {error.code} : {error.read().decode('utf-8', 'replace')[:200]}") from None
        text = str((payload or {}).get("text", "")).strip()
        if not text:
            raise ChatError("Transcription vide (audio silencieux ?).")
        if (cfg.get("output") or {}).get("appendTrailingSpace", True):
            text += " "
        return {"text": text}

    @staticmethod
    def _read_key_file(path: Path, env_name: str) -> str:
        """pi-voice-stt's key-file semantics: a raw key, or an .env file where the line
        `NAME=value` (optionally `export`-prefixed, quoted values) matching env_name wins."""
        try:
            raw = path.read_text(encoding="utf-8").strip()
        except OSError:
            return ""
        if not raw:
            return ""
        if "=" not in raw:
            return raw
        for line in raw.splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("export "):
                line = line[len("export "):].strip()
            name, sep, value = line.partition("=")
            if not sep or name.strip() != env_name:
                continue
            return value.strip().strip('"').strip("'")
        return ""

    async def fork_resend(self, tab_id: str, entry_id: str, message: str) -> dict[str, Any]:
        """Edit-and-resend: fork the session from a previous user message, then prompt the new
        text — the conversation redoes from there on a fresh branch."""
        tab = self._tab(tab_id)
        await self._ensure_process(tab)
        await self._command(tab, {"type": "fork", "entryId": str(entry_id)})
        tab.refs_sent = ""  # the branch rewind may have dropped the refs injection
        self._save_tabs()
        await self.prompt(tab_id, str(message))
        return {"id": tab_id, "forked": True}

    async def fork_rewind(self, tab_id: str, entry_id: str) -> dict[str, Any]:
        """Checkpoint rewind: fork the session just before `entry_id` WITHOUT resending.
        The UI puts the original text back in the composer - the user edits it or resends
        as-is. Everything after that point is dropped from the active branch."""
        tab = self._tab(tab_id)
        await self._ensure_process(tab)
        await self._command(tab, {"type": "fork", "entryId": str(entry_id)})
        tab.refs_sent = ""  # the branch rewind may have dropped the refs injection
        self._save_tabs()
        return {"id": tab_id, "forked": True}

    async def forkables(self, tab_id: str) -> list[dict[str, Any]]:
        """User messages available for forking: (entryId, text) pairs."""
        tab = self._tab(tab_id)
        await self._ensure_process(tab)
        data = await self._command(tab, {"type": "get_fork_messages"})
        out: list[dict[str, Any]] = []
        raw = data if isinstance(data, list) else (data or {}).get("messages") or (data or {}).get("entries") or []
        for item in raw:
            if not isinstance(item, dict):
                continue
            entry_id = item.get("entryId") or item.get("id")
            text = item.get("text") or item.get("message")
            if entry_id and text:
                out.append({"entryId": str(entry_id), "text": str(text)})
        return out

    def archived_sessions(self, limit: int = 50) -> list[dict[str, Any]]:
        """Session files not attached to any live tab — the closed conversations one can reopen."""
        known = {t.session_file for t in self._tabs.values() if t.session_file}
        out: list[dict[str, Any]] = []
        files = sorted(self._sessions.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
        for path in files:
            if str(path) in known:
                continue
            name, preview, count = "", "", 0
            try:
                with path.open(encoding="utf-8", errors="replace") as handle:
                    for line in handle:
                        try:
                            entry = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        if entry.get("type") == "session_info" and entry.get("name"):
                            candidate = str(entry["name"])
                            if not candidate.startswith("mesh"):
                                name = candidate
                        message = entry.get("message") or {}
                        if entry.get("type") == "message":
                            count += 1
                            if message.get("role") == "user" and not preview:
                                content = message.get("content")
                                preview = content if isinstance(content, str) else " ".join(
                                    str(b.get("text", "")) for b in content or []
                                    if isinstance(b, dict) and b.get("type") == "text"
                                )
                        if count > 400:
                            break
            except OSError:
                continue
            stat = path.stat()
            out.append({
                "file": path.name,
                "title": name or path.stem[:19],
                "preview": " ".join(preview.split())[:100],
                "messages": count,
                "bytes": stat.st_size,
                "modified": int(stat.st_mtime * 1000),
            })
            if len(out) >= limit:
                break
        return out

    async def restore_session(self, file: str, title: str = "") -> dict[str, Any]:
        """Reopen an archived session as a new tab (history preserved via switch_session)."""
        return await self.create_tab({"sessionFile": str(file), "title": title or None})

    def set_ref_deep(self, tab_id: str, path: str, deep: bool) -> dict[str, Any]:
        """Toggle a repository reference's 'read everything' mode — the next prompt re-injects
        the full content (the signature change invalidates the once-per-session guard)."""
        tab = self._tab(tab_id)
        resolved = str(Path(path).expanduser())
        if resolved not in tab.refs:
            raise ChatError("Cette référence n'est pas dans la liste.")
        if deep and resolved not in tab.deep_refs:
            tab.deep_refs.append(resolved)
        elif not deep:
            tab.deep_refs = [d for d in tab.deep_refs if d != resolved]
        self._save_tabs()
        return tab.to_json()

    def add_ref(self, tab_id: str, path: str) -> dict[str, Any]:
        tab = self._tab(tab_id)
        path = str(path).strip()
        if not path:
            raise ChatError("Chemin vide.")
        resolved = str(Path(path).expanduser())
        if not Path(resolved).exists():
            raise ChatError(f"Chemin introuvable: {resolved}")
        if resolved not in tab.refs:
            tab.refs.append(resolved)
            self._save_tabs()
        return tab.to_json()

    def upload_ref(self, tab_id: str, name: str, data: str) -> dict[str, Any]:
        """A dropped file (browser files carry no absolute path): stored under the app's chat
        refs dir with its real name, then attached as a persistent reference the agent reads."""
        import binascii

        tab = self._tab(tab_id)
        safe = re.sub(r"[^A-Za-z0-9._ -]", "_", str(name or "fichier"))[:120] or "fichier"
        try:
            blob = base64.b64decode(str(data), validate=False)
        except (binascii.Error, ValueError) as error:
            raise ChatError(f"Fichier illisible : {error}") from None
        if len(blob) > 20 * 1024 * 1024:
            raise ChatError("Fichier trop lourd (max 20 Mo) — donne plutôt un chemin/dossier.")
        folder = self._root / "refs"
        folder.mkdir(parents=True, exist_ok=True)
        target = folder / safe
        stem, dot, ext = safe.rpartition(".")
        counter = 2
        while target.exists():
            target = folder / f"{stem or safe}-{counter}{dot and '.' + ext}"
            counter += 1
        target.write_bytes(blob)
        if str(target) not in tab.refs:
            tab.refs.append(str(target))
            self._save_tabs()
        return tab.to_json()

    def remove_ref(self, tab_id: str, path: str) -> dict[str, Any]:
        tab = self._tab(tab_id)
        tab.refs = [r for r in tab.refs if r != str(path)]
        self._save_tabs()
        return tab.to_json()

    async def history(self, tab_id: str) -> dict[str, Any]:
        """Pi's own messages, normalized for first render after a reload.

        Fast path: when the process is dead (stopped after a server restart), read the
        session file directly instead of respawning pi + switch_session (which can take
        20-45s with extension-heavy setups and times out the caller)."""
        tab = self._tab(tab_id)
        if tab.process is None or tab.process.returncode is not None:
            messages = self._read_session_file(tab)
            if messages is not None:
                return {"id": tab_id, "messages": messages}
        await self._ensure_process(tab)
        state = await self._command(tab, {"type": "get_state"})
        session_file = ((state or {}).get("sessionFile")) or ""
        if session_file:
            tab.session_file = session_file
            self._save_tabs()
        messages = await self._command(tab, {"type": "get_messages"})
        return {"id": tab_id, "messages": _normalize_messages(
            (messages or {}).get("messages", []))}

    def _read_session_file(self, tab: _Tab) -> list[dict[str, Any]] | None:
        """Parse the session JSONL directly — instant history for dead tabs."""
        if not tab.session_file:
            return None
        path = Path(tab.session_file)
        if not path.is_file():
            return None
        messages: list[dict[str, Any]] = []
        try:
            for line in path.open(encoding="utf-8", errors="replace"):
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if entry.get("type") != "message":
                    continue
                message = entry.get("message") or {}
                role = message.get("role", "")
                if role not in ("user", "assistant"):
                    continue
                normalized = _normalize_message(message)
                normalized["entryId"] = str(entry.get("id", ""))
                messages.append(normalized)
        except OSError:
            return None
        return messages

    # --- process management --------------------------------------------------------------------

    def _tab(self, tab_id: str) -> _Tab:
        tab = self._tabs.get(str(tab_id))
        if tab is None:
            raise ChatError(f"No chat tab {tab_id!r}.")
        # Zombie recovery: a streaming state with a dead process can never receive its
        # agent_end - the tab would wedge forever and every new message would queue.
        # A Core restart kills the Pi children exactly this way.
        if (
            tab.state == "streaming"
            and (tab.process is None or tab.process.returncode is not None)
        ):
            tab.state = "stopped"
            self._save_tabs()
        return tab

    async def _ensure_process(self, tab: _Tab) -> None:
        if tab.process is not None and tab.process.returncode is None:
            return
        tab.state = "starting"
        tab.last_error = ""
        self._emit(tab, {"kind": "state"})
        env = dict(os.environ)
        # The openchar Pi extension targets this very server; the tab id lets it rename its tab.
        port = os.environ.get("INLINE_PORT", "8848")
        env.setdefault("INLINE_CORE_URL", f"http://127.0.0.1:{port}")
        env.setdefault("INLINE_CHAT_TAB_ID", tab.id)
        args = [_pi_bin(), "--mode", "rpc", "--name", tab.title,
                "--session-dir", str(self._sessions),
                "--append-system-prompt", _CHAT_SYSTEM_PROMPT]
        if tab.model:
            args += ["--model", tab.model]
        tab.process = await asyncio.create_subprocess_exec(
            *args, cwd=tab.cwd, env=env, limit=_STREAM_LIMIT,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        tab.reader = asyncio.create_task(self._read_loop(tab))
        try:
            state = await asyncio.wait_for(
                self._command(tab, {"type": "get_state"}), timeout=_STARTUP_TIMEOUT)
            session_file = ((state or {}).get("sessionFile")) or ""
            # A tab with a previous session switches back to it (history continuity).
            if tab.session_file and session_file and tab.session_file != session_file:
                await self._command(tab, {"type": "switch_session",
                                          "sessionPath": tab.session_file})
            elif session_file:
                tab.session_file = session_file
            # Re-apply the tab's chosen model + thinking after a (re)spawn.
            if tab.model and "#" not in tab.model:
                provider, _, model_id = tab.model.partition("/")
                await self._command(tab, {"type": "set_model", "provider": provider,
                                          "modelId": model_id})
            if tab.thinking:
                await self._command(tab, {"type": "set_thinking_level", "level": tab.thinking})
            self._save_tabs()
        except (asyncio.TimeoutError, ChatError) as error:
            tab.state = "error"
            tab.last_error = f"pi n'a pas démarré: {error}"
            self._emit(tab, {"kind": "state"})
            raise ChatError(tab.last_error) from None
        # A freshly (re)spawned process cannot be mid-stream: if the tab kept a streaming
        # state from the dead process, the respawn settles it here.
        tab.state = "idle"
        self._emit(tab, {"kind": "state"})

    async def _stop(self, tab: _Tab) -> None:
        if tab.reader is not None:
            tab.reader.cancel()
            tab.reader = None
        if tab.process is not None and tab.process.returncode is None:
            try:
                tab.process.terminate()
                await asyncio.wait_for(tab.process.wait(), timeout=5)
            except (ProcessLookupError, asyncio.TimeoutError):
                with contextlib.suppress(Exception):
                    tab.process.kill()
        tab.process = None
        tab.state = "stopped"
        self._emit(tab, {"kind": "state"})

    async def _send(self, tab: _Tab, command: dict[str, Any]) -> None:
        if tab.process is None or tab.process.stdin is None:
            raise ChatError("Le processus pi n'est pas démarré.")
        tab.process.stdin.write((json.dumps(command) + "\n").encode())
        await tab.process.stdin.drain()

    async def _command(self, tab: _Tab, command: dict[str, Any]) -> Any:
        """Send a command and wait for its correlated response frame."""
        cid = uuid.uuid4().hex[:8]
        command = {"id": cid, **command}
        future: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        tab.pending[cid] = future
        try:
            await self._send(tab, command)
            return await asyncio.wait_for(future, timeout=_STARTUP_TIMEOUT)
        finally:
            tab.pending.pop(cid, None)

    # --- event pump ----------------------------------------------------------------------------

    async def _read_loop(self, tab: _Tab) -> None:
        assert tab.process and tab.process.stdout
        while True:
            try:
                line = await tab.process.stdout.readline()
            except (ValueError, asyncio.LimitOverrunError) as error:
                # A frame larger than the limit: drain what we can and keep the loop alive
                # rather than silently killing the tab's event pump.
                tab.last_error = f"frame ignoré (trop grand): {error}"
                logger.warning("chat %s: %s", tab.id, tab.last_error)
                continue
            except Exception:  # noqa: BLE001 - the pump must survive anything
                logger.exception("chat %s: reader crashed", tab.id)
                tab.state = "error"
                tab.last_error = "flux d'événements interrompu"
                self._emit(tab, {"kind": "state"})
                return
            if not line:
                # pi exited: surface it and let the next prompt respawn.
                tab.state = "stopped"
                tab.last_error = "session pi arrêtée"
                self._emit(tab, {"kind": "state"})
                return
            text = line.decode("utf-8", "replace").strip()
            if not text:
                continue
            try:
                event = json.loads(text)
            except json.JSONDecodeError:
                logger.debug("chat %s: non-JSON line %r", tab.id, text[:120])
                continue
            tab.last_activity = time.time()
            try:
                self._handle_frame(tab, event)
            except Exception:  # noqa: BLE001 - one bad frame must not kill the pump
                logger.exception("chat %s: bad frame %s", tab.id, text[:120])

    def _handle_frame(self, tab: _Tab, frame: dict[str, Any]) -> None:
        kind = frame.get("type", "")
        if kind == "extension_ui_request":
            # Dialog requests (select/confirm/input/editor) block the extension until answered;
            # headless, answer "cancelled" so nothing ever wedges. Fire-and-forget methods
            # (notify/setStatus/setWidget) need no response.
            if frame.get("method") in ("select", "confirm", "input", "editor"):
                asyncio.get_running_loop().create_task(self._send(tab, {
                    "type": "extension_ui_response", "id": frame.get("id"), "cancelled": True,
                }))
            return
        if kind == "response":
            future = tab.pending.get(str(frame.get("id", "")))
            if future is not None and not future.done():
                future.set_result(frame.get("data") if frame.get("success") else None)
            return
        if kind == "agent_start":
            tab.state = "streaming"
            self._emit(tab, {"kind": "state"})
            return
        if kind in ("agent_end", "agent_settled"):
            tab.state = "idle"
            self._emit(tab, {"kind": "state"})
            return
        if kind == "compaction_end":
            # The session summary may have dropped the persistent-refs block: re-inject it on
            # the next prompt so a long conversation never loses its folder context.
            tab.refs_sent = ""
            return
        if kind == "message_update":
            delta = frame.get("assistantMessageEvent", {}) or {}
            if delta.get("type") == "text_delta":
                self._emit(tab, {"kind": "delta", "text": str(delta.get("delta", ""))})
            elif delta.get("type") == "tool_call":
                call = delta.get("toolCall", {}) or {}
                self._emit(tab, {"kind": "toolCall", "tool": str(call.get("name", "?")),
                                 "input": call.get("arguments", call.get("input"))})
            return
        if kind == "message_end":
            message = frame.get("message", {}) or {}
            if message.get("role") == "assistant":
                self._emit(tab, {"kind": "message", "message": _normalize_message(message)})
            return
        if kind == "tool_execution_start":
            self._emit(tab, {"kind": "toolStart", "tool": frame.get("toolName"),
                             "args": frame.get("args")})
            return
        if kind == "tool_execution_end":
            self._emit(tab, {"kind": "toolEnd", "tool": frame.get("toolName"),
                             "result": _summarize_result(frame.get("result"))})
            return
        if kind in ("error", "extension_error"):
            tab.last_error = json.dumps(frame)[:400]
            self._emit(tab, {"kind": "error", "error": tab.last_error})
            return

    def _emit(self, tab: _Tab, payload: dict[str, Any]) -> None:
        if self._events is not None:
            self._events.broadcast("events:chat", {"tabId": tab.id, **payload})

    def _ref_context(self, ref: str, deep: bool = False) -> str:
        """One persistent reference: a directory becomes a bounded tree, a file a header line.
        A "deep" reference injects the repository's whole text content instead — the agent
        must not pick and choose what it reads."""
        path = Path(ref).expanduser()
        if path.is_dir():
            if deep:
                return self._deep_repo_context(path)
            return self._folder_context(str(path))
        if path.is_file():
            return f"[Référence fichier: {path} ({path.stat().st_size // 1024} KB)]"
        return f"[Référence introuvable: {ref}]"

    #: Text extensions whose content is injected in deep mode; anything else is skipped.
    _DEEP_TEXT_EXTS = {
        ".md", ".txt", ".rst", ".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json",
        ".yaml", ".yml", ".toml", ".ini", ".cfg", ".csv", ".tsv", ".html", ".css", ".scss",
        ".sh", ".bash", ".zsh", ".sql", ".graphql", ".env", ".gitignore", ".dockerfile",
    }
    _DEEP_SKIP_DIRS = {"node_modules", ".git", "venv", ".venv", "__pycache__", "dist",
                       "build", "out", "target", ".mypy_cache", ".pytest_cache", "site"}

    def _deep_repo_context(self, root: Path, budget_kb: int | None = None) -> str:
        """A repository flagged 'deep': every text file's content rides in the context —
        the agent gets the WHOLE repo, not a tree to browse at its discretion. Bounded by a
        total budget (files are added in tree order; the remainder is named, not read)."""
        budget = (budget_kb or int(os.environ.get("INLINE_CHAT_DEEP_BUDGET_KB", "150"))) * 1024
        chunks: list[str] = [f"[DÉPÔT COMPLET : {root} — contenu intégral injecté]"]
        used = 0
        skipped: list[str] = []
        for path in sorted(root.rglob("*")):
            rel = path.relative_to(root)
            if any(part in self._DEEP_SKIP_DIRS or part.startswith(".") for part in rel.parts):
                continue
            if not path.is_file():
                continue
            if path.suffix.lower() not in self._DEEP_TEXT_EXTS and path.name.lower() not in {
                "dockerfile", "makefile", "procfile",
            }:
                continue
            try:
                size = path.stat().st_size
                if size > 512 * 1024:
                    skipped.append(f"{rel} (trop gros : {size // 1024} Ko)")
                    continue
                content = path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            if used + len(content) > budget:
                skipped.append(f"{rel} (+ le reste — budget {budget // 1024} Ko atteint)")
                break
            chunks.append(f"==== {rel} ====\n{content}")
            used += len(content)
        if skipped:
            chunks.append(
                "[Non injecté — lis-les avec tes outils si besoin :\n  " + "\n  ".join(skipped[:30]) + "]"
            )
        return "\n\n".join(chunks)

    def _folder_context(self, folder: str, max_entries: int = 300, max_depth: int = 3) -> str:
        """A bounded tree listing, so the agent knows what a referenced folder holds. It explores
        the real files afterwards with its own read/bash tools."""
        root = Path(folder).expanduser()
        if not root.is_dir():
            raise ChatError(f"Dossier introuvable: {folder}")
        lines = [f"[Contexte dossier: {root}]"]
        count = 0
        for path in sorted(root.rglob("*")):
            if count >= max_entries:
                lines.append("… (tronqué: explore avec tes outils read/bash)")
                break
            depth = len(path.relative_to(root).parts)
            if depth > max_depth:
                continue
            rel = path.relative_to(root)
            if any(part.startswith(".") for part in rel.parts):
                continue
            size = f" ({path.stat().st_size // 1024} KB)" if path.is_file() else "/"
            lines.append(f"{'  ' * (depth - 1)}{rel}{size}")
            count += 1
        return "\n".join(lines[:max_entries + 2])

    def _resolve_image(self, image: Any) -> dict[str, Any] | None:
        """{assetId} from /v1/assets, or {data, mimeType} already base64."""
        if not isinstance(image, dict):
            return None
        asset_id = image.get("assetId")
        if asset_id and self._assets is not None:
            path = self._assets.path(str(asset_id))
            if path is None:
                raise ChatError(f"Asset inconnu: {asset_id}")
            suffix = path.suffix.lower().lstrip(".") or "png"
            mime = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
                    "webp": "image/webp", "gif": "image/gif"}.get(suffix, "image/png")
            return {"type": "image", "data": base64.b64encode(path.read_bytes()).decode(),
                    "mimeType": mime}
        data, mime = image.get("data"), image.get("mimeType", "image/png")
        if isinstance(data, str) and data:
            return {"type": "image", "data": data, "mimeType": str(mime)}
        return None


# --- message normalization ----------------------------------------------------------------------

def _normalize_messages(messages: list[Any]) -> list[dict[str, Any]]:
    return [_normalize_message(m) for m in messages if isinstance(m, dict)]


def _normalize_message(message: dict[str, Any]) -> dict[str, Any]:
    role = message.get("role", "?")
    blocks = message.get("content", [])
    if isinstance(blocks, str):
        return {"role": role, "text": blocks, "tools": [], "images": []}
    text_parts: list[str] = []
    tools: list[dict[str, Any]] = []
    images: list[str] = []
    for block in blocks if isinstance(blocks, list) else []:
        if not isinstance(block, dict):
            continue
        btype = block.get("type")
        if btype == "text":
            text_parts.append(str(block.get("text", "")))
        elif btype == "image":
            images.append(str(block.get("source", "") or block.get("data", ""))[:64])
        elif btype == "toolCall":
            tools.append({"tool": block.get("name", "?"),
                          "input": block.get("arguments", block.get("input"))})
    return {"role": role, "text": "\n".join(text_parts), "tools": tools, "images": images}


def _summarize_result(result: Any) -> Any:
    if isinstance(result, dict):
        content = result.get("content")
        if isinstance(content, list):
            texts = [str(c.get("text", "")) for c in content if isinstance(c, dict)]
            return "\n".join(texts)[:4000]
        return result
    return str(result)[:4000] if result is not None else ""


def register_chat_handlers(rpc: Any, chat: ChatBridge) -> None:
    """The ``chat:*`` channels. The router hands each handler the raw args list; unpack here
    (same wrapper shape as register_studio_handlers) and await async callables."""

    import inspect

    def reg(channel: str, fn: Any) -> None:
        async def handler(args: list[Any]) -> Any:
            result = fn(*args)
            if inspect.isawaitable(result):
                result = await result
            return result

        rpc.register(channel, handler)

    reg("chat:tabs", lambda: chat.list_tabs())
    reg("chat:createTab", lambda inp=None: chat.create_tab(inp))
    reg("chat:closeTab", lambda tab_id, kill=True: chat.close_tab(tab_id, kill))
    reg("chat:renameTab", lambda tab_id, title, auto=False: chat.rename_tab(tab_id, title, auto))
    reg("chat:prompt", lambda tab_id, message, images=None, folder="":
        chat.prompt(tab_id, message, images or [], folder))
    reg("chat:steer", lambda tab_id, message: chat.steer(tab_id, message))
    reg("chat:cancel", lambda tab_id: chat.cancel(tab_id))
    reg("chat:history", lambda tab_id: chat.history(tab_id))
    reg("chat:setModel", lambda tab_id, model: chat.set_model(tab_id, model))
    reg("chat:setThinking", lambda tab_id, level: chat.set_thinking(tab_id, level))
    reg("chat:models", lambda tab_id: chat.models(tab_id))
    reg("chat:stats", lambda tab_id: chat.stats(tab_id))
    reg("chat:transcribe", lambda inp: chat.transcribe(inp))
    reg("chat:forkResend", lambda tab_id, entry_id, message: chat.fork_resend(tab_id, entry_id, message))
    reg("chat:forkables", lambda tab_id: chat.forkables(tab_id))
    reg("chat:forkRewind", lambda tab_id, entry_id: chat.fork_rewind(tab_id, entry_id))
    reg("chat:archivedSessions", lambda limit=50: chat.archived_sessions(int(limit)))
    reg("chat:restoreSession", lambda file, title="": chat.restore_session(file, title))
    reg("chat:addRef", lambda tab_id, path: chat.add_ref(tab_id, path))
    reg("chat:removeRef", lambda tab_id, path: chat.remove_ref(tab_id, path))
    reg("chat:uploadRef", lambda tab_id, name, data: chat.upload_ref(tab_id, name, data))
    reg("chat:setRefDeep", lambda tab_id, path, deep: chat.set_ref_deep(tab_id, path, deep))
