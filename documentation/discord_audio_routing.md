# Discord OBS/Virtual Microphone Audio Routing

To enable VRM-Puppet to act as a "Discord Stream Companion," her text-to-speech audio must be routed into a virtual microphone mixed with your physical microphone so that Discord users can hear her natively. Crucially, she also needs to hear the Discord desktop audio to respond to your friends, which requires a "Mix-Minus" topology to prevent her from hearing her own voice and entering an infinite loop.

## Linux PulseAudio / PipeWire Setup

Discord actively filters out desktop audio monitors (to prevent echoing). To bypass this and achieve a Mix-Minus, we must build a Four-Part Virtual Audio Pipeline using `pactl`.

### Step 1: Create the Virtual Pipeline (Mix-Minus)
Run these commands in your Linux terminal to construct four distinct buckets that safely isolate her TTS output from her microphone input.

```bash
# 1. Bucket A: What Discord Hears (User + AI)
pactl load-module module-null-sink sink_name=Discord_Out_Mix sink_properties=device.description="What_Discord_Hears"

# 2. Bucket B: What the AI Hears (User + Desktop)
pactl load-module module-null-sink sink_name=AI_In_Mix sink_properties=device.description="What_AI_Hears"

# 3. Route your Physical Mic into BOTH buckets
pactl load-module module-loopback source=@DEFAULT_SOURCE@ sink=Discord_Out_Mix
pactl load-module module-loopback source=@DEFAULT_SOURCE@ sink=AI_In_Mix

# 4. Route Desktop Audio (Discord friends) into AI's ears
pactl load-module module-loopback source=@DEFAULT_SINK@.monitor sink=AI_In_Mix

# 5. Create Fake Mic for Discord
pactl load-module module-remap-source source_name=Virtual_Mic_For_Discord master=Discord_Out_Mix.monitor master_channel_map=front-left,front-right source_properties=device.description="Virtual_Microphone_For_Discord"
```

### Step 2: Route the Applications in Pavucontrol
Once the pipeline is active and `main.py` is running:
1. Open **PulseAudio Volume Control** (`pavucontrol`).

**Playback Tab (Mouths):**
*   **`main.py`** / `ALSA plug-in [python]`: Change to **`What_Discord_Hears`**. (This sends her voice to your friends, but protects her ears).
*   **Discord / Google Chrome**: Change to your **default headphones/speakers**.

**Recording Tab (Ears):**
*   **`main.py`** / `ALSA plug-in [python]`: Change to **`Monitor of What_AI_Hears`**. (This lets her hear you + Discord).
*   **Discord / Google Chrome Input**: Change to **`Virtual_Microphone_For_Discord`**.

### Reverting
If you ever need to destroy these virtual cables, simply restart the PulseAudio server:
```bash
pulseaudio -k
```
