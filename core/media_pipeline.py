import subprocess
import os
import json
import sys
import time

def process_audio_for_lipsync(input_file, output_visemes_file):
    """
    1. Converts MP3/Audio to WAV (PCM 16-bit) using ffmpeg if needed.
    2. Runs Rhubarb to generate viseme data.
    3. Returns the viseme JSON structure.
    """
    start_total = time.time()
    perf_metrics = {}

    # 1. Ensure file is a WAV (Rhubarb requirement)
    base, ext = os.path.splitext(input_file)
    wav_file = base + ".wav"
    
    if ext.lower() == ".mp3":
        start_conv = time.time()
        print(f"Converting {input_file} to {wav_file}...")
        cmd_ffmpeg = [
            "ffmpeg", "-i", input_file, 
            "-ar", "16000", "-ac", "1", "-y", wav_file
        ]
        subprocess.run(cmd_ffmpeg, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        perf_metrics['conversion_time'] = time.time() - start_conv
    else:
        wav_file = input_file

    # 2. Run Rhubarb
    print(f"Running Rhubarb on {wav_file}...")
    start_rhubarb = time.time()
    
    # Path logic: Look in project root / bin / rhubarb
    # We try siblings/parents to find the project root robustly
    possible_roots = [
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), # ../../
        os.getcwd(), # Current working directory
    ]
    
    rhubarb_path = None
    for root in possible_roots:
        test_path = os.path.join(root, "bin", "rhubarb")
        if os.path.exists(test_path):
            rhubarb_path = test_path
            break
            
    if not rhubarb_path:
        # Fallback to system PATH
        rhubarb_path = "rhubarb"

    print(f"Using Rhubarb binary at: {rhubarb_path}")
    
    cmd_rhubarb = [rhubarb_path, "-f", "json", "-r", "phonetic", wav_file]
    result = subprocess.run(cmd_rhubarb, capture_output=True, text=True, check=True)
    
    viseme_data = json.loads(result.stdout)
    perf_metrics['rhubarb_time'] = time.time() - start_rhubarb
    
    # 3. Save to output file
    with open(output_visemes_file, 'w') as f:
        json.dump(viseme_data, f, indent=2)
        
    # Cleanup temp wav if we created one
    if ext.lower() == ".mp3" and os.path.exists(wav_file):
        os.remove(wav_file)
        
    perf_metrics['total_time'] = time.time() - start_total

    # --- Performance Report ---
    print("\n" + "="*30)
    print(" ⏱️ PERFORMANCE METRICS")
    print("="*30)
    if 'conversion_time' in perf_metrics:
        print(f"Audio Conversion (MP3->WAV): {perf_metrics['conversion_time']:.3f}s")
    print(f"Rhubarb Analysis:           {perf_metrics['rhubarb_time']:.3f}s")
    print(f"Total Pipeline Duration:    {perf_metrics['total_time']:.3f}s")
    print("="*30 + "\n")
    
    return viseme_data

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python media_pipeline.py <input_audio_file>")
        sys.exit(1)
        
    input_audio = sys.argv[1]
    output_json = os.path.splitext(input_audio)[0] + "_visemes.json"
    
    try:
        process_audio_for_lipsync(input_audio, output_json)
    except Exception as e:
        print(f"Error processing lipsync: {e}")
