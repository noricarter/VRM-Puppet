import os
import sys
import threading
import json
import urllib.request
import time
import tempfile
import speech_recognition as sr
import mss
import base64
import io
import multiprocessing
from PIL import Image
from faster_whisper import WhisperModel

# 🚀 STABILITY FLAGS
os.environ['QTWEBENGINE_CHROMIUM_FLAGS'] = '--no-sandbox --disable-setuid-sandbox --disable-vulkan --enable-gpu-rasterization --ignore-gpu-blocklist --disable-web-security --use-fake-ui-for-media-stream --enable-speech-dispatcher'
os.environ['QT_QPA_PLATFORM'] = 'xcb' 
os.environ['QT_STYLE_OVERRIDE'] = 'fusion'
os.environ['QT_OPENGL'] = 'desktop' 

import webview
from pynput import keyboard

# Determine paths relative to Project Root
MAIN_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(MAIN_DIR)

sys.path.append(os.path.join(PROJECT_ROOT, "core"))
import db_manager

# --- MONITOR CAPTURE CONFIG ---
# Set to the monitor you want the Observer to watch.
# Run `xrandr --query | grep connected` to find your monitor names and positions.
# Format: (display_name, x_offset, y_offset, width, height)
CAPTURE_MONITOR = ('DP-1', 1920, 0, 1920, 1080)  # Primary monitor (right screen)

# --- WHISPER STT CONFIG ---
# Model sizes: tiny, base, small, medium, large-v2, large-v3
# large-v3 = best quality; medium = good balance of speed/accuracy
WHISPER_MODEL_SIZE = 'large-v3'
# int8_float16 = ~3 GB VRAM (recommended when sharing GPU with TTS + LLM)
# float16      = ~6.5 GB VRAM (full precision, use only if GPU has 16+ free GB)
WHISPER_COMPUTE_TYPE = 'int8_float16'


# Ensure launcher bridge exists
BRIDGE_HTML_PATH = os.path.join(PROJECT_ROOT, "hud_launcher.html")
BRIDGE_HTML_CONTENT = """
<!DOCTYPE html>
<html>
<body style="background: transparent; margin: 0; overflow: hidden;">
    <script>location.href = 'standalone_app/hud.html';</script>
</body>
</html>
"""
    
def _capture_worker(queue):
    """Worker function for screenshot subprocess to avoid OpenGL conflicts.
    Uses scrot or ImageMagick (import) instead of mss — these CLI tools bypass
    the XCB assertion errors that mss triggers when Qt owns the display."""
    import os
    import io
    import base64
    import subprocess
    import tempfile
    from PIL import Image

    if 'DISPLAY' not in os.environ:
        os.environ['DISPLAY'] = ':0'

    try:
        with tempfile.NamedTemporaryFile(suffix='.jpg', delete=False) as tmp:
            tmp_path = tmp.name

        captured = False
        display = os.environ.get('DISPLAY', ':0')
        xauth  = os.environ.get('XAUTHORITY', os.path.expanduser('~/.Xauthority'))
        env = {**os.environ, 'DISPLAY': display, 'XAUTHORITY': xauth}

        # Method 1: ffmpeg x11grab — most reliable from a subprocess context
        mon_name, mon_x, mon_y, mon_w, mon_h = CAPTURE_MONITOR
        try:
            subprocess.run(
                [
                    'ffmpeg', '-y',
                    '-f', 'x11grab',
                    '-video_size', f'{mon_w}x{mon_h}',
                    '-i', f'{display}+{mon_x},{mon_y}',
                    '-frames:v', '1',
                    '-vf', 'scale=1024:-1',
                    '-qscale:v', '4',
                    tmp_path
                ],
                check=True, timeout=8, env=env,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
            )
            captured = True
        except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired):
            pass

        # Method 2: ImageMagick import
        if not captured:
            try:
                subprocess.run(
                    ['import', '-window', 'root', '-resize', '1024x1024>', tmp_path],
                    check=True, timeout=5, env=env,
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
                )
                captured = True
            except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired):
                pass

        # Method 3: scrot (if installed)
        if not captured:
            try:
                subprocess.run(
                    ['scrot', '-z', '--quality', '80', tmp_path],
                    check=True, timeout=5, env=env,
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
                )
                captured = True
            except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired):
                pass

        # Method 3: mss (last resort, may fail on some configs)
        if not captured:
            import mss
            with mss.mss() as sct:
                monitor = sct.monitors[1]
                img = sct.grab(monitor)
                pil_img = Image.frombytes("RGB", img.size, img.bgra, "raw", "BGRX")
                pil_img.thumbnail((1024, 1024))
                buf = io.BytesIO()
                pil_img.save(buf, format='JPEG', quality=80)
                queue.put(base64.b64encode(buf.getvalue()).decode('utf-8'))
                return

        # Read and encode the file written by scrot/import
        pil_img = Image.open(tmp_path)
        pil_img.thumbnail((1024, 1024))
        buf = io.BytesIO()
        pil_img.save(buf, format='JPEG', quality=80)
        queue.put(base64.b64encode(buf.getvalue()).decode('utf-8'))
        os.unlink(tmp_path)

    except Exception as e:
        queue.put(f"ERROR:{str(e)}")


class HUDAPI:
    def __init__(self):
        self.window = None
        self.hud_visible = True
        self.hands_free_enabled = False
        self.is_speaking = False  # True while TTS audio is actively playing
        
        self.observer_role = "off" # "off", "generic", "stream_companion"
        self._hands_free_thread = None
        self._observer_audio_thread = None
        self._observer_heartbeat_thread = None
        # Add new dedicated Discord stream listener thread
        self._discord_stream_thread = None
        self._audio_buffer = []  # List of strings captured from system audio
        self._last_interaction_time = time.time()

        # Load Whisper model once — shared across all STT uses
        print(f"[HUD] Loading Whisper STT model '{WHISPER_MODEL_SIZE}' ({WHISPER_COMPUTE_TYPE}) on GPU...")
        self._whisper = WhisperModel(WHISPER_MODEL_SIZE, device='cuda', compute_type=WHISPER_COMPUTE_TYPE)
        print(f"[HUD] Whisper model ready.")

        self.list_devices()

    def _transcribe_audio(self, audio: sr.AudioData, label: str = 'STT') -> str:
        """Transcribe an sr.AudioData object using local faster-whisper."""
        wav_bytes = audio.get_wav_data()
        with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as f:
            f.write(wav_bytes)
            tmp_path = f.name
        try:
            segments, _ = self._whisper.transcribe(
                tmp_path,
                beam_size=5,
                language='en',
                vad_filter=True,           # Skip silent segments automatically
                vad_parameters=dict(min_silence_duration_ms=300),
            )
            text = ' '.join(seg.text.strip() for seg in segments).strip()
            return text
        finally:
            os.unlink(tmp_path)

    def list_devices(self):
        """Prints all audio devices to terminal for debugging."""
        import pyaudio
        p = pyaudio.PyAudio()
        print("\n[HUD][DEBUG] --- AUDIO DEVICE LIST ---")
        for i in range(p.get_device_count()):
            info = p.get_device_info_by_index(i)
            print(f"Device {i}: {info.get('name')} (Inputs: {info.get('maxInputChannels')})")
        print("[HUD][DEBUG] --------------------------\n")
        p.terminate()

    def quit(self):
        print("[HUD] Quitting...")
        if self.window: self.window.destroy()
        os._exit(0)

    def open_settings(self):
        if self.window: self.window.evaluate_js("showSettingsModal()")

    def toggle_hud(self):
        self.hud_visible = not self.hud_visible
        if self.window:
            self.window.evaluate_js(f"toggleHUDVisibility({str(self.hud_visible).lower()})")
        print(f"[HUD] Visibility Toggled: {self.hud_visible}")

    def move_character(self, axis, amount):
        if self.window:
            self.window.evaluate_js(f"applyPositionDelta('{axis}', {amount})")

    def get_actors(self):
        return db_manager.get_all_actors()

    def get_available_vrms(self):
        """Scans assets/vrms for .vrm files and returns relative paths."""
        vrms = []
        vrms_dir = os.path.join(PROJECT_ROOT, "assets", "vrms")
        if not os.path.exists(vrms_dir):
            return []
            
        for root, dirs, files in os.walk(vrms_dir):
            for file in files:
                if file.lower().endswith(".vrm"):
                    # Create internal path like /assets/vrms/...
                    full_path = os.path.join(root, file)
                    rel_path = "/" + os.path.relpath(full_path, PROJECT_ROOT)
                    vrms.append(rel_path)
        return sorted(vrms)

    def get_available_models(self):
        """Fetches available models from Ollama API."""
        try:
            req = urllib.request.Request("http://localhost:11434/api/tags")
            with urllib.request.urlopen(req) as response:
                data = json.loads(response.read().decode('utf-8'))
                return [m.get('name') for m in data.get('models', [])]
        except Exception as e:
            print(f"[HUD] Failed to fetch Ollama models: {e}")
            return ["fimbulvetr-v2.1:latest"] # Fallback

    def save_actor_profile(self, actor_id, vrm_path, manifest_data):
        print(f"[HUD] Saving Actor Profile: {actor_id}")
        # manifest_data comes as a dict from JS
        db_manager.register_actor(actor_id, vrm_path, manifest_data)
        return True

    def load_actor(self, actor_id):
        actor = db_manager.get_actor(actor_id)
        if actor:
            print(f"[HUD] Loading Actor: {actor_id}")
            self.window.evaluate_js(f"loadCharacterProfile({json.dumps(actor)})")
            return True
        return False

    def listen_to_mic(self):
        """Records from mic and returns transcription via local Whisper STT."""
        print("[HUD] Listening...")
        r = sr.Recognizer()
        r.pause_threshold = 1.5
        with sr.Microphone() as source:
            r.adjust_for_ambient_noise(source, duration=0.5)
            try:
                audio = r.listen(source, timeout=5, phrase_time_limit=15)
                print("[HUD] Transcribing (Whisper)...")
                text = self._transcribe_audio(audio, label='MicButton')
                print(f"[HUD] Heard: {text}")
                return text
            except sr.WaitTimeoutError:
                print("[HUD] Listening timeout.")
                return ""
            except Exception as e:
                print(f"[HUD] STT Error: {e}")
                return f"Error: {str(e)}"

    def toggle_hands_free(self, enabled):
        """Starts or stops the continuous background listener."""
        self.hands_free_enabled = enabled
        print(f"[HUD] Hands-Free Mode: {'ENABLED' if enabled else 'DISABLED'}")
        
        if enabled:
            if not self._hands_free_thread or not self._hands_free_thread.is_alive():
                self._hands_free_thread = threading.Thread(target=self._continuous_listen_loop, daemon=True)
                self._hands_free_thread.start()
        return True

    def set_speaking(self, speaking):
        """Called by JS before/after TTS playback to mute the hands-free mic."""
        self.is_speaking = bool(speaking)
        print(f"[HUD] Speaking state: {'SPEAKING (mic muted)' if speaking else 'SILENT (mic active)'}")
        return True

    def _continuous_listen_loop(self):
        """Persistent loop for hands-free mode."""
        print("[HUD][HandsFree] Starting continuous listener...")
        r = sr.Recognizer()
        r.dynamic_energy_threshold = True
        r.pause_threshold = 1.5  # Seconds of silence before considering speech done
        
        try:
            with sr.Microphone() as source:
                print("[HUD][HandsFree] Calibrating for ambient noise...")
                r.adjust_for_ambient_noise(source, duration=1)
                print("[HUD][HandsFree] Listening for YOU...")
                
                while self.hands_free_enabled:
                    try:
                        audio = r.listen(source, timeout=1, phrase_time_limit=20)

                        # Discard anything heard while she was speaking (feedback loop guard)
                        if self.is_speaking:
                            print("[HUD][HandsFree] Discarding audio — AI is speaking (feedback suppressed)")
                            continue

                        print("[HUD][HandsFree] Transcribing (Whisper)...")
                        text = self._transcribe_audio(audio, label='HandsFree')

                        # Double-check after inference (Whisper takes a moment)
                        if self.is_speaking:
                            print("[HUD][HandsFree] Discarding transcript — AI started speaking mid-transcription")
                            continue

                        if text and len(text.strip()) > 1:
                            print(f"[HUD][HandsFree] Heard: {text}")
                            if self.window:
                                self.window.evaluate_js(f"autoSubmitTranscription({json.dumps(text)})")
                    except sr.WaitTimeoutError:
                        continue
                    except Exception as e:
                        if self.hands_free_enabled:
                            print(f"[HUD][HandsFree] Audio Capture Error: {e}")
                            time.sleep(2)
        except Exception as e:
            print(f"[HUD][HandsFree] FATAL MIC ERROR: {e}")

        print("[HUD][HandsFree] Loop Exited.")

    def notify_activity(self):
        """Called by JS when user types or interacts to reset the 60-second timer."""
        self._last_interaction_time = time.time()
        return True

    def capture_screen(self):
        """Captures primary monitor using a subprocess to avoid OpenGL thread errors."""
        q = multiprocessing.Queue()
        p = multiprocessing.Process(target=_capture_worker, args=(q,))
        p.start()
        
        # Wait up to 5s for the screenshot
        try:
            result = q.get(timeout=5)
            p.join()
            if isinstance(result, str) and result.startswith("ERROR:"):
                raise Exception(result)
            return result
        except Exception as e:
            if p.is_alive():
                p.terminate()
            raise e

    def set_observer_role(self, role):
        """Starts or stops the autonomous observer threads based on role."""
        self.observer_role = role
        print(f"[HUD] Observer Role updated to: {role}")
        
        if role == "off":
            return True

        self._last_interaction_time = time.time()

        if role in ["observer", "audiobook"]:
            # Standard Observer (30s heartbeat + monitor recording)
            if not self._observer_heartbeat_thread or not self._observer_heartbeat_thread.is_alive():
                self._observer_heartbeat_thread = threading.Thread(target=self._observer_heartbeat_loop, daemon=True)
                self._observer_heartbeat_thread.start()
            
            if not self._observer_audio_thread or not self._observer_audio_thread.is_alive():
                self._observer_audio_thread = threading.Thread(target=self._observer_audio_loop, daemon=True)
                self._observer_audio_thread.start()
        
        elif role == "stream_companion":
            # Discord Streamer Role (Voice-Activated, immediate screenshot capture)
            if not self._discord_stream_thread or not self._discord_stream_thread.is_alive():
                self._discord_stream_thread = threading.Thread(target=self._discord_stream_loop, daemon=True)
                self._discord_stream_thread.start()

        return True

    def _observer_audio_loop(self):
        """Captures system audio (monitor) while observer mode is enabled."""
        print("[HUD][Observer] Audio Loop Thread Starting...")
        r = sr.Recognizer()
        r.pause_threshold = 0.8
        
        # Try to find a monitor/loopback device index
        monitor_index = None
        import pyaudio
        p = pyaudio.PyAudio()
        try:
            # First try a smart hunt for common monitor strings
            for i in range(p.get_device_count()):
                info = p.get_device_info_by_index(i)
                name = info.get('name', '').lower()
                if 'monitor' in name or 'loopback' in name or 'virm_loop' in name:
                    monitor_index = i
                    print(f"[HUD][Observer] FOUND NATIVE MONITOR: {info.get('name')} (id {i})")
                    break
            
            if monitor_index is None:
                # Fallback: Find anything named 'pulse' or 'default' with inputs
                for i in range(p.get_device_count()):
                    info = p.get_device_info_by_index(i)
                    if info.get('maxInputChannels') > 0 and ('pulse' in info.get('name').lower() or 'default' in info.get('name').lower()):
                        monitor_index = i
                        print(f"[HUD][Observer] FALLBACK to generic pulse/default input: {info.get('name')} (id {i})")
                        break
        finally:
            p.terminate()

        # PERSISTENT SESSION: Open mic once outside the loop for stability
        try:
            with sr.Microphone(device_index=monitor_index) as source:
                print(f"[HUD][Observer] Listening for show dialogue on device {monitor_index}...")
                
                class FeedbackGuardStream:
                    def __init__(self, stream, hud):
                        self._stream = stream
                        self._hud = hud
                        self.heard_while_speaking = False
                        
                    def __getattr__(self, name):
                        return getattr(self._stream, name)
                        
                    def close(self):
                        self._stream.close()
                        
                    def stop_stream(self):
                        self._stream.stop_stream()
                        
                    def read(self, size):
                        chunk = self._stream.read(size)
                        if self._hud.is_speaking:
                            self.heard_while_speaking = True
                        return chunk

                guarded_stream = FeedbackGuardStream(source.stream, self)
                source.stream = guarded_stream

                while self.observer_role in ["observer", "audiobook"]:
                    try:
                        guarded_stream.heard_while_speaking = False
                        audio = r.listen(source, timeout=3, phrase_time_limit=15)

                        # Discard monitor audio captured while the AI is speaking (feedback guard)
                        if guarded_stream.heard_while_speaking or self.is_speaking:
                            print("[HUD][Observer] Discarding transcript — AI is speaking (feedback suppressed)")
                            continue

                        text = self._transcribe_audio(audio, label='Observer')

                        # Double-check: discard if she started speaking during inference
                        if self.is_speaking:
                            print("[HUD][Observer] Discarding transcript — AI started speaking mid-transcription")
                            continue

                        if text and len(text.strip()) > 3:
                            print(f"[HUD][Observer] TRANSCRIPT: {text}")
                            self._audio_buffer.append(text)
                            if len(self._audio_buffer) > 20:
                                self._audio_buffer.pop(0)
                    except sr.WaitTimeoutError:
                        continue
                    except Exception as e:
                        if self.observer_role in ["observer", "audiobook"]:
                            print(f"[HUD][Observer] Audio Capture Error: {e}")
                            time.sleep(2)
        except Exception as e:
             print(f"[HUD][Observer] FATAL AUDIO LOOP ERROR (Check device index {monitor_index}): {e}")

        print("[HUD][Observer] Audio Loop Thread Exited.")

    def _observer_heartbeat_loop(self):
        """Wait for silence, then trigger observation pulse."""
        print("[HUD][Observer] Autonomous Heartbeat Started")
        while self.observer_role in ["observer", "audiobook"]:
            time.sleep(5) # Check Every 5s
            
            idle_time = time.time() - self._last_interaction_time
            if idle_time >= 30: # 30s for responsiveness
                print(f"[HUD][Observer] Idle Threshold ({int(idle_time)}s). Starting Pulse sequence...")
                
                # 1. Capture Vision
                print("[HUD][Observer] Step 1: Capturing Screen...")
                try:
                    b64_vision = self.capture_screen()
                    print("[HUD][Observer] Step 1 SUCCESS: Screen captured.")
                except Exception as e:
                    print(f"[HUD][Observer] Step 1 FAILURE (Screenshot): {e}")
                    b64_vision = None
                
                # 2. Collect System Audio Transcript
                print("[HUD][Observer] Step 2: Collecting transcripts...")
                transcript = " ".join(self._audio_buffer)
                self._audio_buffer = [] 
                
                # 3. Notify Frontend
                if self.window:
                    print(f"[HUD][Observer] Step 3: Dispatching Pulse to JS (Transcript Length: {len(transcript)})...")
                    try:
                        self.window.evaluate_js(f"triggerObserverPulse({json.dumps(b64_vision)}, {json.dumps(transcript)})")
                        print("[HUD][Observer] Step 3 SUCCESS: JS Evaluated.")
                    except Exception as e:
                        print(f"[HUD][Observer] Step 3 FAILURE (JS Eval): {e}")
                
                # 4. Reset timer
                self._last_interaction_time = time.time()
                print("[HUD][Observer] Pulse complete. Timer reset.")

    def _discord_stream_loop(self):
        """Voice-Activated Discord Stream Companion Loop."""
        print("[HUD][Discord] Stream Listener Starting...")
        r = sr.Recognizer()
        r.pause_threshold = 1.0
        r.dynamic_energy_threshold = True

        monitor_index = None
        import pyaudio
        import math
        p = pyaudio.PyAudio()
        monitor_name = "Unknown"
        try:
            for i in range(p.get_device_count()):
                info = p.get_device_info_by_index(i)
                name = info.get('name', '').lower()
                if 'monitor' in name or 'loopback' in name or 'virm_loop' in name:
                    monitor_index = i
                    monitor_name = info.get('name')
                    break
            if monitor_index is None:
                for i in range(p.get_device_count()):
                    info = p.get_device_info_by_index(i)
                    dev_name = info.get('name', '').lower()
                    if info.get('maxInputChannels') > 0 and ('pulse' in dev_name or 'default' in dev_name):
                        monitor_index = i
                        monitor_name = info.get('name')
                        break
        finally:
            p.terminate()

        def _instant_screenshot_worker(result_container):
            """Captures the screen instantly in a daemon thread."""
            try:
                print("[HUD][Discord] 📸 Speech detected! Snapping instant screenshot...")
                b64 = self.capture_screen()
                result_container.append(b64)
            except Exception as e:
                print(f"[HUD][Discord] Instant screenshot failed: {e}")
                result_container.append(None)

        try:
            with sr.Microphone(device_index=monitor_index) as source:
                print(f"[HUD][Discord] Calibrating to device {monitor_index} ({monitor_name})...")
                r.adjust_for_ambient_noise(source, duration=1.0)
                print(f"[HUD][Discord] Energy Threshold settled at: {r.energy_threshold}")
                print("[HUD][Discord] Listening purely for voice activity on Discord stream...")

                class DiscordGuardStream:
                    def __init__(self, stream, hud, recognizer):
                        self._stream = stream
                        self._hud = hud
                        self._r = recognizer
                        self.heard_while_speaking = False
                        self.screenshot_triggered = False
                        self.screenshot_results = []

                    def __getattr__(self, name):
                        return getattr(self._stream, name)

                    def close(self):
                        self._stream.close()
                        
                    def stop_stream(self):
                        self._stream.stop_stream()

                    def read(self, size):
                        chunk = self._stream.read(size)
                        try:
                            if self._hud.is_speaking:
                                self.heard_while_speaking = True
                                
                            import audioop
                            rms = audioop.rms(chunk, source.SAMPLE_WIDTH)
                            
                            # Muted to prevent log spam

                            if not self.screenshot_triggered and not self._hud.is_speaking:
                                if rms > self._r.energy_threshold:
                                    print(f"[HUD][Discord] RMS {rms} crossed threshold {self._r.energy_threshold}!")
                                    self.screenshot_triggered = True
                                    threading.Thread(target=_instant_screenshot_worker, args=(self.screenshot_results,), daemon=True).start()
                        except Exception as e:
                            print(f"[HUD][Discord/Debug] Hook Error: {e}")
                        return chunk

                discord_stream = DiscordGuardStream(source.stream, self, r)
                source.stream = discord_stream

                while self.observer_role == "stream_companion":
                    try:
                        # Reset flags for the new phrase
                        discord_stream.heard_while_speaking = False 
                        discord_stream.screenshot_triggered = False
                        discord_stream.screenshot_results.clear()

                        # This blocks until phrase is finished
                        print("[HUD][Discord] Waiting for speech...")
                        audio = r.listen(source, timeout=1, phrase_time_limit=15)

                        # Discard anything heard while she was speaking to prevent feedback
                        if discord_stream.heard_while_speaking or self.is_speaking:
                            print("[HUD][Discord] Discarding audio — she was speaking")
                            continue

                        print("[HUD][Discord] Transcribing phrase...")
                        text = self._transcribe_audio(audio, label='DiscordStream')
                        
                        if self.is_speaking:
                             continue

                        if text and len(text.strip()) > 3:
                            print(f"[HUD][Discord] Heard: {text}")
                            
                            # Grab the screenshot that was secretly taken at the start of the phrase
                            b64_vision = None
                            if len(discord_stream.screenshot_results) > 0:
                                b64_vision = discord_stream.screenshot_results[0]
                                
                            if self.window:
                                print("[HUD][Discord] Pushing Voice-Activated Pulse to Chat Bridge...")
                                self.window.evaluate_js(f"triggerObserverPulse({json.dumps(b64_vision)}, {json.dumps(text)})")
                                
                    except sr.WaitTimeoutError:
                        continue
                    except Exception as e:
                        if self.observer_role == "stream_companion":
                            print(f"[HUD][Discord] Capture error: {e}")
                            time.sleep(2)
        except Exception as e:
             print(f"[HUD][Discord] FATAL LOOP ERROR: {e}")

        print("[HUD][Discord] Stream Listener Exited.")

def _screenshot_to_chat(api):
    """Capture screen and inject result into the JS chat as an attached image."""
    try:
        print("[HUD][Hotkey] Capturing screenshot for chat...")
        b64 = api.capture_screen()
        if api.window:
            api.window.evaluate_js(f"injectScreenshot({json.dumps(b64)})")
            print("[HUD][Hotkey] Screenshot injected into chat.")
    except Exception as e:
        print(f"[HUD][Hotkey] Screenshot capture failed: {e}")


def start_hotkey_listener(api):
    print("[HUD] Hotkeys: F8 (Visibility), Ctrl+Shift+S (Screenshot→Chat), Arrows (Pos), Shift+Arrows (Z-Depth)")
    
    current_keys = set()
    
    def on_press(key):
        try:
            current_keys.add(key)
            
            if key == keyboard.Key.f8:
                api.toggle_hud()

            # --- Ctrl+Shift+S: Screenshot to Chat ---
            ctrl_held = keyboard.Key.ctrl_l in current_keys or keyboard.Key.ctrl_r in current_keys
            shift_held = keyboard.Key.shift in current_keys
            is_s = hasattr(key, 'char') and key.char in ('s', 'S')
            if ctrl_held and shift_held and is_s:
                threading.Thread(target=_screenshot_to_chat, args=(api,), daemon=True).start()
                return
            
            # Positioning
            step = 0.05
            if keyboard.Key.shift in current_keys:
                # Z-Axis (In/Out)
                if key == keyboard.Key.up: api.move_character('z', -step)
                if key == keyboard.Key.down: api.move_character('z', step)
            else:
                # X/Y Axis
                if key == keyboard.Key.up: api.move_character('y', step)
                if key == keyboard.Key.down: api.move_character('y', -step)
                if key == keyboard.Key.left: api.move_character('x', -step)
                if key == keyboard.Key.right: api.move_character('x', step)
                
        except AttributeError:
            pass

    def on_release(key):
        if key in current_keys:
            current_keys.remove(key)

    with keyboard.Listener(on_press=on_press, on_release=on_release) as listener:
        listener.join()

def run_app():
    # Force CWD to the project root so Bottle serves correctly
    os.chdir(PROJECT_ROOT)
    
    # Write the launcher to the root so Bridge can find it
    with open("hud_launcher.html", 'w') as f:
        f.write(BRIDGE_HTML_CONTENT)
    
    api = HUDAPI()
    
    # 1920x1080 screen with -35 offset to hide title bar
    width = 1920
    height = 1115
    offset_y = -35
    
    window = webview.create_window(
        'VRM Puppet HUD',
        url='hud_launcher.html',
        js_api=api,
        transparent=True,
        width=width,
        height=height,
        x=0, y=offset_y,
        frameless=False,  
        on_top=True,
        background_color='#000000',
        text_select=False
    )
    api.window = window

    threading.Thread(target=start_hotkey_listener, args=(api,), daemon=True).start()

    print(f"[HUD] Launching Stable Borderless Mode")
    webview.start(debug=False, gui='qt', http_server=True)

if __name__ == '__main__':
    run_app()
