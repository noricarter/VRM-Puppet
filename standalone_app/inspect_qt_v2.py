import os
import sys
import webview

# Basic flags
os.environ['QT_QPA_PLATFORM'] = 'xcb'

def inspect_qt():
    window = webview.create_window('Diagnostic', 'https://google.com', hidden=True)
    
    def on_loaded():
        print("--- Deep Window Inspection ---")
        print(f"window.native: {getattr(window, 'native', 'Not found')}")
        
        if hasattr(window, 'gui'):
            print(f"window.gui is a: {type(window.gui)}")
            if hasattr(window.gui, 'renderer'):
                print(f"Found window.gui.renderer: {type(window.gui.renderer)}")
                # In newer pywebview, the renderer instance often holds the window
                renderer = window.gui.renderer
                for candidate in ['main_window', 'window', 'view', 'web_view']:
                    if hasattr(renderer, candidate):
                        print(f"Found renderer.{candidate}: {type(getattr(renderer, candidate))}")

        # Final check: search PySide6 QApplication for any top-level windows
        try:
            from PySide6.QtWidgets import QApplication
            app = QApplication.instance()
            if app:
                print(f"Found QApplication. Top level widgets: {len(app.topLevelWidgets())}")
                for i, w in enumerate(app.topLevelWidgets()):
                    print(f"Widget {i}: {type(w)} - Title: '{w.windowTitle()}'")
        except ImportError:
            pass

        window.destroy()

    window.events.loaded += on_loaded
    webview.start(gui='qt')

if __name__ == '__main__':
    inspect_qt()
