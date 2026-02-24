import os
import sys
import webview

# 🚨 NUCLEAR STABILITY FLAGS
# Disabling everything that touches the GPU or complex system integration
os.environ['QTWEBENGINE_CHROMIUM_FLAGS'] = '--no-sandbox --disable-gpu --disable-gpu-compositing --disable-vulkan --disable-software-rasterizer --disable-dev-shm-usage --disable-setuid-sandbox'
os.environ['QT_QUICK_BACKEND'] = 'software'
os.environ['QT_OPENGL'] = 'software'
os.environ['QT_QPA_PLATFORM'] = 'xcb' # Force X11 backend even on Wayland
os.environ['QT_STYLE_OVERRIDE'] = 'fusion' # Disable GTK theme integration (common crash point)

def run_test():
    html = """
    <html>
        <body style="background: transparent; color: white; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; font-family: sans-serif;">
            <div style="text-align: center; background: rgba(0,0,0,0.5); padding: 20px; border-radius: 10px;">
                <h1>STABILITY STEP 4</h1>
                <p>Testing <b>Transparent Window</b> with <b>Normal Frame</b>.</p>
                <p>If this works, only "Frameless" is the enemy.</p>
            </div>
        </body>
    </html>
    """
    
    print("[TEST] Launching Transparent Window (Normal Frame)...")
    window = webview.create_window(
        'Diagnostic HUD',
        html=html,
        transparent=True, # Testing transparency
        fullscreen=False,
        frameless=False,  # DO NOT USE FRAMELESS
        on_top=False,
        width=800,
        height=600,
        background_color='#000000'
    )
    
    webview.start(gui='qt', debug=True)

if __name__ == '__main__':
    run_test()

if __name__ == '__main__':
    run_test()
