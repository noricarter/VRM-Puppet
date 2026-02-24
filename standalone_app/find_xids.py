import os
import subprocess
import time
import webview

def find_xids():
    window = webview.create_window('XID Finder', 'about:blank')
    
    def on_loaded():
        print("--- X11 Window ID Search ---")
        # Give X11 a moment to map things
        time.sleep(1)
        
        # 1. Find main XID via xwininfo
        res = subprocess.run(['xwininfo', '-name', 'XID Finder', '-children'], capture_output=True, text=True)
        print(res.stdout)
        
        window.destroy()

    window.events.loaded += on_loaded
    webview.start(gui='qt')

if __name__ == '__main__':
    find_xids()
