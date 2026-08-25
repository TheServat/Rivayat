"""
Speak one line and write a wav, to prove the voice lane works end to end.

    python tools/scripts/chatterbox-say.py "text" out.wav [--audio-prompt ref.wav]

Loading the weights proves the files are on disk; only generating proves the model
runs. The two failed separately during setup - a watermarker that returned None got
all the way through loading - so this is the check that means something.

Deterministic on purpose: the seed is fixed, because a voice line that differs between
two runs of the same script cannot be diffed when it starts sounding wrong.
"""

import sys
import torch
import torchaudio
from chatterbox.tts import ChatterboxTTS

SEED = 7

text = sys.argv[1] if len(sys.argv) > 1 else "The lamplighter kept one flame burning."
out = sys.argv[2] if len(sys.argv) > 2 else "workspace/voice/probe.wav"

device = "cuda" if torch.cuda.is_available() else "cpu"
torch.manual_seed(SEED)

model = ChatterboxTTS.from_pretrained(device=device)
kwargs = {}
if "--audio-prompt" in sys.argv:
    kwargs["audio_prompt_path"] = sys.argv[sys.argv.index("--audio-prompt") + 1]

wav = model.generate(text, **kwargs)
torchaudio.save(out, wav, model.sr)

seconds = wav.shape[-1] / model.sr
print(f"device     {device}")
print(f"seed       {SEED}")
print(f"text       {text}")
print(f"wrote      {out}  ({seconds:.2f}s @ {model.sr} Hz)")
