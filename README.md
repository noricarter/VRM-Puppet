# VRM Puppet

A real-time AI character system. You create a VRM avatar, give her a voice, connect her to a local LLM, and she talks, reacts, lip-syncs, and responds with physical animations. There are two surfaces: a **Devtool** (browser-based mixer for testing) and a **Standalone HUD App** (an always-on companion window that can observe your screen and listen to ambient audio).

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Installation](#installation)
3. [Creating Your Character](#creating-your-character)
   - [VRM model (VRoid Studio)](#vrm-model-vroid-studio)
   - [Voice reference file](#voice-reference-file)
   - [Registering the character](#registering-the-character)
4. [The Devtool — `launch.py`](#the-devtool--launchpy)
   - [What it does](#what-it-does)
   - [Tabs overview](#tabs-overview)
   - [Character Editor (Persona + Knowledge)](#character-editor-persona--knowledge)
5. [The Standalone HUD App](#the-standalone-hud-app)
   - [Why the weird launch command](#why-the-weird-launch-command)
   - [The transparent window caveat](#the-transparent-window-caveat)
   - [Hands-Free mode](#hands-free-mode)
   - [Observer mode](#observer-mode)
   - [Discord Audio Puppeteering](#discord-audio-puppeteering)
6. [Configuration Quick Reference](#configuration-quick-reference)
7. [Project Structure](#project-structure)
8. [Troubleshooting](#troubleshooting)

---

## Prerequisites

| Requirement | Notes |
|---|---|
| Python 3.10+ | 3.12 recommended; must match your venv |
| [Ollama](https://ollama.ai) | Running locally, any model loaded |
| NVIDIA GPU | CUDA required for Whisper STT + TTS. CPU fallback is slow. |
| Linux (X11) | The standalone app uses `pywebview` + Qt + X11. Wayland not yet supported. |
| `ffmpeg` | Screen capture in Observer mode: `sudo apt install ffmpeg` |
| `scrot` | Fallback screenshot tool: `sudo apt install scrot` |
| `rhubarb` | Lipsync binary — already included in `bin/` |

---

## Installation

```bash
# Clone the repo
git clone https://github.com/noricarter/VRM-Puppet.git
cd VRM-Puppet

# Create and activate a virtual environment
python -m venv venv
source venv/bin/activate

# Install Python dependencies
pip install -r requirements.txt   # (or install manually — see below)

# Key packages:
# pip install faster-whisper pywebview pynput speechrecognition pillow torch torchvision
```

> **Note:** `venv/` is gitignored. You must create it locally.
> Binary assets (VRM models, FBX animations, voice WAVs) are also gitignored — see [Creating Your Character](#creating-your-character).

---

## Creating Your Character

### VRM model (VRoid Studio)

1. Download [VRoid Studio](https://vroid.com/en/studio) (free, Windows/Mac)
2. Design your character and export as `.vrm`
3. Place the `.vrm` file here:

```
assets/vrms/<YourCharacterName>/<YourCharacterName>.vrm
```

Example:
```
assets/vrms/Laura_Stevens/Laura.vrm
```

4. Register the character in the database (see [Registering the character](#registering-the-character)).

> **VRM format:** VRoid Studio exports `.vroid` project files and `.vrm` runtime files. You want the `.vrm` — it's the game-ready version.

---

### Voice reference file

The TTS system (StyleTTS2-based) clones a voice from a short reference clip. You need:

- A clean `.wav` file of the voice you want (5–30 seconds is ideal)
- No background noise, no music
- Clear speech at a neutral pace

Place it here:
```
assets/voices/<name>.wav
```

Example:
```
assets/voices/jessica.wav
```

The voice is selected per-actor in the database via the `voice_description` trait. You set this through the devtool or directly in the DB.

---

### Registering the character

Once you have the VRM placed, register the actor in the database using Python:

```python
# From the project root with venv active:
python -c "
import sys; sys.path.insert(0, 'core')
import db_manager

db_manager.init_db()
db_manager.create_actor(
    actor_id='YourCharacter',
    manifest_data={
        'label': 'Your Character Name',
        'persona': 'She is curious, warm, and direct.',
        'voice_description': 'A warm female voice.',
    },
    vrm_path='assets/vrms/YourCharacter/YourCharacter.vrm'
)
print('Done.')
"
```

Then run the migration script to set up the full modular persona system. This script seeds the database with the character's core identity, moods, and mode prompts. It also accepts your name so the character knows who they are talking to from the start:

```bash
# Usage: python core/migrate_actor.py <CharacterName> <YourName>
python core/migrate_actor.py YourCharacter Nori
```

> The migration seeds your character with a default set of moods and mode prompts tailored to your name. You can then edit everything through the Character Editor in the devtool.

---

## The Devtool — `launch.py`

### What it does

```bash
python launch.py
```

This single command starts **three things** simultaneously:

| Service | Port | What it is |
|---|---|---|
| Headless Engine (`chat_bridge.py`) | 8001 | Handles all AI chat, TTS, lipsync, DB access |
| Web Server | 8000 | Serves the mixer frontend |
| Browser | — | Auto-opens `http://localhost:8000/web/index.html` |

Press `CTRL+C` to shut everything down cleanly.

---

### Tabs overview

The bottom of the devtool has a mixing board with tabs:

| Tab | What it controls |
|---|---|
| **Morph_eye** | Eye morph sliders (blinking, wide, squint) |
| **Morph_ha** | Head/face morphs |
| **Morph_mm** | Mouth morphs |
| **Neck** | Neck rotation X/Y/Z |
| **Presets** | Saved poses and preset combos |
| **Scene** | Character selection — pick your VRM and Apply |
| **Animations** | Idle loop selection + oneshot triggers |
| **Chat 💬** | Send chat messages, pick the Ollama model, reset memory |
| **Actions 🎬** | Browse the registered animation library |

**Apply / Reset** buttons send the current slider mix to the VRM in real time.

---

### Character Editor (Persona + Knowledge)

Click the **✏️ button** in the top-left of the devtool after loading a character.

A panel slides out with two tabs:

#### 🎭 Persona Tab

| Section | What you edit |
|---|---|
| **Identity Core** | Name, core traits (who she is), speech style (how she talks), values (what she won't do) |
| **Moods** | 8 mood cards in a grid. Each mood has behavioral instructions that change how she responds. Click **Activate** to set her live mood immediately. Edit the instructions and **Save**. |
| **Mode Prompts** | Instructions for each environment (user dialogue, observer, audiobook, NPC, idle). Expand with ▾, edit, Save. |

> **Moods** affect *how* she speaks. **Modes** affect *what context* she's in.

#### 🧠 Knowledge Tab

This is the knowledge graph — what she knows about the world.

- **Add Subject** — add any entity (character, place, concept, event)
- **Add Relation** — connect two subjects with a verb: `Mongo → has_been_seen_at → the casino`
- **Confidence slider** — how certain the knowledge is (shown as green/yellow/red badge)
- **Search** — filter subjects by name
- **Delete** — removes the subject and all its relations

When you chat, the system scans your message for known subject names and automatically injects relevant context into the prompt before the AI responds.

---

## The Standalone HUD App

The standalone app is a floating companion window — it sits on your desktop, renders the VRM character, listens to your microphone, and can watch your screen.

### Why the weird launch command

```bash
cd standalone_app
LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libstdc++.so.6 python main.py
```

The `LD_PRELOAD` is required because `pywebview` on Linux uses Qt's WebEngine, which bundles its own copy of `libstdc++`. On some Linux systems this bundled version conflicts with the system version used by PyTorch and Whisper, causing a crash at launch. By preloading the system `libstdc++`, we force both Qt and PyTorch to share the same library, eliminating the conflict.

Without it you'll see something like:
```
version `GLIBCXX_3.4.30' not found
```

---

### The transparent window caveat

The standalone HUD window is **transparent** — the character appears to float on your desktop. However, the window still occupies a physical rectangle. **You cannot click through it** to applications underneath.

This is a fundamental limitation of how `pywebview` + Qt handle transparent windows on X11. The click-through area would require native X11 input shape masks (not yet implemented).

**Workaround:** Position the character on a monitor edge or corner where it doesn't overlap your primary working area.

---

### Hands-Free mode

Activate via the HUD toggle. The app:
1. Continuously listens to your microphone using Whisper (local, GPU-accelerated)
2. Detects speech using silence thresholds
3. Automatically sends transcripts to the AI and plays back the response

The mic is automatically **muted while the AI is speaking** to prevent the AI from hearing and responding to its own voice.

**Config in `main.py`:**
```python
WHISPER_MODEL_SIZE = 'large-v3'      # STT model (tiny/base/small/medium/large-v3)
WHISPER_COMPUTE_TYPE = 'int8_float16' # VRAM mode (float16 = quality, int8 = efficiency)
```

---

### Observer mode

The AI watches your screen and listens to system audio, reacting like a co-viewer.

**How it works:**
1. A background thread captures system audio (select the right device in your system audio settings — e.g. a monitor/loopback input)
2. Whisper transcribes the audio continuously
3. Every ~30 seconds of inactivity, a "pulse" fires: screenshots the configured monitor + sends the rolling transcript to the AI
4. The AI reacts as a viewing companion

**Configuring which monitor to capture:**

In `standalone_app/main.py`:
```python
CAPTURE_MONITOR = ('DP-1', 1920, 0, 1920, 1080)
# Format: (xrandr display name, x_offset, y_offset, width, height)
```

Find your monitor names with:
```bash
xrandr --query | grep connected
```

**Audio device:** The Observer listens on a specific device index. List devices from the HUD or run:
```bash
python -c "import speech_recognition as sr; [print(i, sr.Microphone.list_microphone_names()[i]) for i in range(len(sr.Microphone.list_microphone_names()))]"
```

> Observer mode transcripts while the AI is speaking are automatically discarded to prevent feedback loops.

---

### Discord Audio Puppeteering

If you want to use the Standalone HUD App to puppeteer the AI inside a Discord voice call (so that your friends can hear her native text-to-speech engine mixed alongside your own physical microphone), you must bypass Discord's aggressive monitor filtering. Please see the dedicated [Discord OBS/Virtual Microphone Audio Routing Guide](documentation/discord_audio_routing.md) for the exact Linux PulseAudio commands required to configure the virtual mixer pipeline.

---

## Configuration Quick Reference

| File | Setting | Default | Effect |
|---|---|---|---|
| `standalone_app/main.py` | `WHISPER_MODEL_SIZE` | `large-v3` | STT accuracy vs speed |
| `standalone_app/main.py` | `WHISPER_COMPUTE_TYPE` | `int8_float16` | VRAM usage (~3 GB vs ~6.5 GB) |
| `standalone_app/main.py` | `CAPTURE_MONITOR` | `('DP-1', 1920, 0, 1920, 1080)` | Which screen Observer watches |
| `launch.py` | `BRIDGE_CMD` | `core/chat_bridge.py` | Headless engine entrypoint |
| `launch.py` | `WEB_URL` | `http://localhost:8000/web/index.html` | Devtool URL |

---

## Project Structure

```
VRM-Puppet/
├── launch.py                   # ← Start here for the devtool
│
├── standalone_app/
│   ├── main.py                 # Standalone HUD app (pywebview + Qt)
│   ├── hud.html                # HUD frontend HTML
│   └── hud.js                  # HUD frontend logic
│
├── core/
│   ├── chat_bridge.py          # HTTP server: AI chat, TTS, lipsync pipeline
│   ├── db_manager.py           # SQLite schema + all CRUD operations
│   ├── prompt_composer.py      # Assembles layered system prompts
│   ├── tts_engine.py           # StyleTTS2 voice synthesis
│   ├── media_pipeline.py       # Audio → lipsync pipeline (Rhubarb)
│   ├── brain_tool.py           # Background memory + reasoning
│   ├── migrate_actor.py        # Seed a new actor's persona into the DB
│   └── persistence.db          # SQLite DB (gitignored — auto-created)
│
├── web/
│   ├── index.html              # Devtool frontend
│   ├── app.js                  # Devtool logic (tabs, sliders, chat)
│   ├── persona_editor.js       # Character editor panel (Persona + Knowledge tabs)
│   ├── styles.css              # Devtool styles
│   ├── viewer.js               # Three.js VRM renderer
│   └── temp/                   # Runtime TTS audio output (gitignored)
│
├── assets/
│   ├── vrms/                   # VRM character models (gitignored)
│   │   └── <CharacterName>/
│   │       └── <name>.vrm
│   ├── voices/                 # Voice reference WAV files (gitignored)
│   │   └── <name>.wav
│   └── animations/
│       ├── idle/loop/          # Looping idle animations (FBX)
│       └── idle/oneshot/       # One-shot gesture animations (FBX)
│
├── bin/
│   └── rhubarb                 # Lipsync analysis binary
│
└── documentation/              # Extended design docs
```

---

## Troubleshooting

**`GLIBCXX_3.4.30 not found` on launch**
→ Use the full launch command: `LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libstdc++.so.6 python main.py`

**CUDA out of memory (TTS fails)**
→ Reduce Whisper VRAM: set `WHISPER_COMPUTE_TYPE = 'int8_float16'` in `main.py`
→ Or use a smaller model: `WHISPER_MODEL_SIZE = 'medium'`

**ALSA / JACK warnings on startup**
→ Cosmetic. These are audio subsystem probes from PyAudio. They don't affect functionality.

**Observer mode not transcribing**
→ Check the device index in `main.py` — make sure it points to a system monitor/loopback input, not your microphone
→ Run `xrandr --query` to confirm `CAPTURE_MONITOR` matches your actual display name

**Character not appearing in devtool**
→ Make sure `chat_bridge.py` is running (port 8001) before loading the page
→ The VRM path in the DB must match the actual file location

**Persona editor shows "Could not reach bridge"**
→ `chat_bridge.py` is not running or crashed. Check the terminal output for errors.

**`git add -A` hanging**
→ You have large files (FBX animations, VRM models) being staged. Run `git add` on specific directories instead, or delete runtime files in `web/temp/` before staging.

---

> **VRM Puppet** is built on [Three.js](https://threejs.org), [@pixiv/three-vrm](https://github.com/pixiv/three-vrm), [faster-whisper](https://github.com/SYSTRAN/faster-whisper), [Rhubarb Lip Sync](https://github.com/DanielSWolf/rhubarb-lip-sync), and [Ollama](https://ollama.ai).
