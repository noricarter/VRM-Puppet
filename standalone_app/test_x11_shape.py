import os
import sys
import ctypes
import webview
from PySide6.QtWidgets import QWidget

# Basic flags for Linux stability
os.environ['QT_QPA_PLATFORM'] = 'xcb'

def test_x11_passthrough():
    window = webview.create_window('X11 Shape Test', 'https://google.com')
    
    def on_loaded():
        print("--- X11 Shape Passthrough Test ---")
        try:
            # 1. Load X11 libraries
            x11 = ctypes.cdll.LoadLibrary("libX11.so.6")
            xext = ctypes.cdll.LoadLibrary("libXext.so.6")
            
            # 2. Get XID from Qt
            # window.native is webview.platforms.qt.BrowserView
            qt_widget = window.native
            xid = qt_widget.winId()
            print(f"Window XID: {xid}")
            
            # 3. Open Display
            display = x11.XOpenDisplay(None)
            if not display:
                print("Failed to open X display")
                return

            # Shape constants
            ShapeInput = 1
            ShapeSet = 0
            
            # 4. Set Empty Input Region
            # XShapeCombineRectangles(display, window, dest_kind, x_off, y_off, rectangles, count, op, ordering)
            # Passing count=0 with null rectangles makes it empty
            xext.XShapeCombineRectangles(display, xid, ShapeInput, 0, 0, None, 0, ShapeSet, 0)
            x11.XFlush(display)
            x11.XCloseDisplay(display)
            
            print("Successfully set empty input shape via X11!")
            print("Try clicking 'through' the window now. It should be ghosted.")
            
        except Exception as e:
            print(f"X11 Shape Fail: {e}")

    window.events.loaded += on_loaded
    webview.start(gui='qt')

if __name__ == '__main__':
    test_x11_passthrough()
