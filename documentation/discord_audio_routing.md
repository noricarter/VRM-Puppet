# Discord OBS/Virtual Microphone Audio Routing

To enable VRM-Puppet to act as a "Discord Stream Companion," her text-to-speech audio must be routed into a virtual microphone mixed with your physical microphone so that Discord users can hear her natively without a feedback loop.

## Linux PulseAudio / PipeWire Setup

Discord actively filters out desktop audio monitors (to prevent echoing). To bypass this, we must build an invisible Virtual Audio Pipeline using `pactl`.

### Step 1: Create the Virtual Pipeline
Run these commands in your Linux terminal to construct a Null Sink, a Loopback cable to your headset, and a Remap Source that Discord will accept as a valid microphone.

*(Replace `TATYBO WT3` with your actual physical microphone if you wish to mix your own voice into the exact same Discord audio stream as her!)*

```bash
# 1. Create a raw virtual audio bucket for her TTS
pactl load-module module-null-sink sink_name=Virtual_Mic sink_properties=device.description="Virtual_Microphone"

# 2. Wire the bucket to perfectly duplicate back to your physical headset (So you can hear her!)
pactl load-module module-loopback source=Virtual_Mic.monitor sink=@DEFAULT_SINK@

# 3. Create a Mix bucket
pactl load-module module-null-sink sink_name=Mixed_Mic sink_properties=device.description="Mixed_Microphone"

# 4. Wire your Physical Microphone INTO the Mix bucket
pactl load-module module-loopback source=@DEFAULT_SOURCE@ sink=Mixed_Mic

# 5. Wire her Virtual Mic INTO the Mix bucket
pactl load-module module-loopback source=Virtual_Mic.monitor sink=Mixed_Mic

# 6. DISCORD BYPASS: Wrap the Mix bucket in a "Fake Microphone" profile so Discord allows you to select it
pactl load-module module-remap-source source_name=Virtual_Mic_For_Discord master=Mixed_Mic.monitor master_channel_map=front-left,front-right source_properties=device.description="Virtual_Microphone_For_Discord"
```

### Step 2: Route the Python App to the Pipeline
If `main.py` is running:
1. Open **PulseAudio Volume Control** (`pavucontrol`).
2. Go to the **Playback** tab.
3. Find the `main.py` / `ALSA plug-in [python]` application.
4. Change its output device destination from your headset to **Virtual_Microphone**.

### Step 3: Tell Discord to Listen
1. Open **Discord User Settings > Voice & Video**.
2. Change your **Input Device (Microphone)** to **Virtual_Microphone_For_Discord**.
3. *Done!* Whenever she speaks, Discord will broadcast her alongside you.

### Reverting
If you ever need to destroy these virtual cables, simply restart the PulseAudio server:
```bash
pulseaudio -k
```
