import os
import webview

def inspect_hierarchy():
    window = webview.create_window('Hierarchy Test', 'about:blank', hidden=True)
    
    def on_loaded():
        print("--- Native Widget Hierarchy ---")
        native = window.native
        print(f"Native Window: {type(native)}")
        
        def dump_children(obj, indent=0):
            for child in obj.children():
                print("  " * indent + f"- {type(child)} (Name: {child.objectName()})")
                dump_children(child, indent + 1)
        
        dump_children(native)
        window.destroy()

    window.events.loaded += on_loaded
    webview.start(gui='qt')

if __name__ == '__main__':
    inspect_hierarchy()
