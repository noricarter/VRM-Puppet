import mss
import mss.tools

def test_screenshot():
    with mss.mss() as sct:
        # Get the 1st monitor
        monitor = sct.monitors[1]
        # Capture the screen
        sct_img = sct.shot(output="test_screenshot.png")
        print(f"Screenshot saved to {sct_img}")

if __name__ == "__main__":
    test_screenshot()
