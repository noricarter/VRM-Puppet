import subprocess
import time
import os
import signal
import sys
import webbrowser

# --- CONFIG ---
BRIDGE_CMD = [sys.executable, "core/chat_bridge.py"]
WEB_SERVER_CMD = [sys.executable, "-m", "http.server", "8000"]
WEB_URL = "http://localhost:8000/web/index.html"

processes = []

def signal_handler(sig, frame):
    print("\n--- Shutting down VRM Puppet Stage... 🌑 ---", flush=True)
    for p in processes:
        p.terminate()
    sys.exit(0)

def main():
    signal.signal(signal.SIGINT, signal_handler)
    
    print("🚀 Initializing Headless Engine (Port 8001)...", flush=True)
    bridge_proc = subprocess.Popen(BRIDGE_CMD)
    processes.append(bridge_proc)
    
    # Wait a moment for bridge to init
    time.sleep(3)
    
    print("🌐 Starting Mixer UI Server (Port 8000)...", flush=True)
    web_proc = subprocess.Popen(WEB_SERVER_CMD)
    processes.append(web_proc)
    
    print(f"✨ System Ready! Opening {WEB_URL}", flush=True)
    time.sleep(2)
    webbrowser.open(WEB_URL)
    
    print("\n--- System Status: RUNNING 🏛️🛡️ ---", flush=True)
    print("Press CTRL+C to stop all services.", flush=True)
    
    try:
        while True:
            # Check if any process died unexpectedly
            if bridge_proc.poll() is not None:
                print("⚠️  Warning: Headless Engine crashed.")
                break
            if web_proc.poll() is not None:
                print("⚠️  Warning: Web Server crashed.")
                break
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        signal_handler(None, None)

if __name__ == "__main__":
    main()
