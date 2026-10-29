# Synthesizes sounds/countdown.mp3: a 15 s clip, a soft triangle-lead figure over a sine thump, speeding up from 110 to 170 bpm.
# Regenerate: uv run --with numpy mods/cache-gauge/sounds/make_countdown.py mods/cache-gauge/sounds/countdown.mp3
import subprocess
import sys

import numpy as np

RATE = 22_050
SECONDS = 15
FIGURE = [196.00, 233.08, 196.00, 185.00, 196.00, 233.08, 261.63, 233.08]  # G, Bb, G, F#, G, Bb, C, Bb

out = np.zeros(RATE * SECONDS)


def add(start: float, seconds: float, wave: np.ndarray, gain: float) -> None:
    i = int(start * RATE)
    out[i : i + len(wave)] += wave[: len(out) - i] * gain


def triangle(freq: float, x: np.ndarray) -> np.ndarray:
    return 2 * np.abs(2 * ((freq * x) % 1) - 1) - 1


t = 0.0
beat = 0
while t < SECONDS:
    progress = t / SECONDS
    gap = 60 / (110 + 60 * progress)  # one note per beat
    n = int(min(gap, SECONDS - t) * RATE)
    x = np.arange(n) / RATE
    lead = triangle(FIGURE[beat % len(FIGURE)], x) * np.minimum(1, x * 300) * np.exp(-x * 5)
    add(t, gap, lead, 0.35 + 0.2 * progress)
    thump = np.sin(2 * np.pi * (70 - 25 * np.minimum(1, x * 8)) * x) * np.exp(-x * 14)
    add(t, gap, thump, 0.5)
    t += gap
    beat += 1

peak = np.max(np.abs(out))
out *= 0.8 / peak
fade = RATE // 20
out[-fade:] *= np.linspace(1, 0, fade)
pcm = (out * 32767).astype("<i2").tobytes()
subprocess.run(
    ["ffmpeg", "-y", "-loglevel", "error", "-f", "s16le", "-ar", str(RATE), "-ac", "1", "-i", "-", "-b:a", "96k", sys.argv[1]],
    input=pcm,
    check=True,
)
