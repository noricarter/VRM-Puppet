import os
import webview

# Basic flags
os.environ['QT_QPA_PLATFORM'] = 'xcb'

def inspect_window():
    window = webview.create_window('Diagnostic', 'https://google.com', hidden=True)
    
    def on_loaded():
        print("--- Window Object Inspection ---")
        print(f"Window type: {type(window)}")
        print(f"Has gui: {hasattr(window, 'gui')}")
        if hasattr(window, 'gui'):
            print(f"Gui type: {type(window.gui)}")
            # Common pywebview internal paths for Qt
            # Usually window.gui.window or window.gui.view
            for attr in ['window', 'view', 'main_window', 'browser']:
                if hasattr(window.gui, attr):
                    print(f"Found window.gui.{attr}: {type(getattr(window.gui, attr))}")
        
        window.destroy()

    window.events.loaded += on_loaded
    webview.start(gui='qt')

if __name__ == '__main__':
    inspect_window()
