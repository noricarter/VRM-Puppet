import os
import torch
import numpy as np
import time
import soundfile as sf
import json
from pathlib import Path

try:
    from chatterbox import ChatterboxTTS
    CHATTERBOX_AVAILABLE = True
except ImportError:
    CHATTERBOX_AVAILABLE = False

class TTSEngine:
    def __init__(self, device=None):
        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        self.model = None
        
    def load(self):
        if not CHATTERBOX_AVAILABLE:
            raise RuntimeError("chatterbox-tts not installed in venv.")
            
        if self.model is not None:
            return

        print(f"--- TTSEngine: Loading Chatterbox onto {self.device} ---")
        start = time.time()
        
        # Load the pretrained model
        self.model = ChatterboxTTS.from_pretrained(device=self.device)
        
        # Force move to device just in case from_pretrained didn't get everything
        if hasattr(self.model, 'to'):
            self.model.to(self.device)
            
        print(f"--- TTSEngine: Model loaded and verified on {self.device} in {time.time() - start:.2f}s ---")

    def generate(self, text, output_path, voice_reference_audio=None, exaggeration=0.5):
        """
        Generates audio and saves to output_path.
        If voice_reference_audio is provided, it uses it for cloning.
        Returns the absolute path to the generated file.
        """
        self.load()
        
        print(f"--- TTSEngine: Generating audio for: {text[:50]}... ---")
        if voice_reference_audio:
            print(f"--- TTSEngine: Using reference audio: {voice_reference_audio} ---")
        
        start = time.time()
        
        # Generate audio using Chatterbox
        # wav is a torch tensor
        wav_tensor = self.model.generate(
            text=text,
            audio_prompt_path=voice_reference_audio,
            exaggeration=exaggeration,
            temperature=0.8,
            top_p=1.0,
            repetition_penalty=1.2
        )
        
        # Convert to numpy and save as WAV
        # wav_tensor is (1, num_samples)
        wav_np = wav_tensor.squeeze(0).cpu().numpy()
        
        # Ensure output directory exists
        out_dir = os.path.dirname(output_path)
        if out_dir:
            os.makedirs(out_dir, exist_ok=True)
            
        sf.write(output_path, wav_np, self.model.sr)
        
        print(f"--- TTSEngine: Generation complete in {time.time() - start:.2f}s ---")
        return os.path.abspath(output_path)

    def unload(self):
        """No-op for Chatterbox (stays in VRAM)."""
        pass

if __name__ == "__main__":
    # Quick test
    engine = TTSEngine()
    try:
        # For testing, we need a real ref file if we want to clone, 
        # or it will use built-in voice if model.conds is set.
        engine.generate("Hello, I am now powered by Chatterbox.", "test_chatterbox_result.wav")
    finally:
        pass
