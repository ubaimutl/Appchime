#!/usr/bin/env python3
"""Build Appchime's bundled sounds from CC0 sources + one original layer.

Sources (all CC0, see CREDITS.md):
- Kenney "Interface Sounds" (kenney.nl): confirmation_002, confirmation_003,
  glass_004, maximize_002, drop_001
- Robin Lamb "UI Sound Effects" (OpenGameArt): Ding.ogg
- Original (this script, CC0): noise-swell layer in mail-swoosh, marimba.

Processing: silence trim, 25 ms fade-out, peak normalize to 0.89 with
loose RMS matching, encode Ogg Vorbis q3, 44.1 kHz mono.
"""
import subprocess

import numpy as np

SR = 44100
SFX = '/tmp/opencode/sfx'
OUT = '/home/ubai/Projects/Gnome/Appchime/appchime@ubai.dev'


def decode(path):
    p = subprocess.run(
        ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', path,
         '-ac', '1', '-ar', str(SR), '-f', 'f32le', '-'],
        capture_output=True, check=True)
    return np.frombuffer(p.stdout, dtype=np.float32).astype(np.float64)


def trim(x, thresh_db=-60.0):
    thresh = 10 ** (thresh_db / 20)
    idx = np.nonzero(np.abs(x) > thresh)[0]
    if len(idx) == 0:
        return x[:SR // 10]
    return x[idx[0]:idx[-1] + 1]


def fade_out(x, ms=25.0):
    n = min(len(x), int(ms * SR / 1000))
    if n > 1:
        x[-n:] *= np.linspace(1.0, 0.0, n)
    # 2 ms fade-in to avoid clicks on abrupt starts
    m = min(len(x), int(2 * SR / 1000))
    if m > 1:
        x[:m] *= np.linspace(0.0, 1.0, m)
    return x


def normalize(x, peak=0.89):
    p = np.max(np.abs(x))
    if p > 0:
        x = x / p * peak
    return x


def rms(x):
    return float(np.sqrt(np.mean(x ** 2)))


def encode(name, x):
    pcm = (np.clip(x, -1.0, 1.0) * 32767).astype(np.int16)
    wav = f'/tmp/opencode/sfx_build_{name}.wav'
    import wave
    with wave.open(wav, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    subprocess.run(
        ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', wav,
         '-c:a', 'libvorbis', '-q:a', '3', '-ac', '1', '-ar', '44100',
         f'{OUT}/{name}.oga'], check=True)
    print(f'{name}.oga: {len(x) / SR:.2f}s rms={rms(x):.3f}')


def load(name):
    x = trim(decode(f'{SFX}/{name}'))
    return fade_out(normalize(x))


def noise_swell(n, seed=11):
    """Soft airy riser bed for the mail swoosh."""
    rng = np.random.default_rng(seed)
    x = rng.standard_normal(n)
    # smooth (lowpass-ish) via moving average
    w = 64
    x = np.convolve(x, np.ones(w) / w, mode='same')
    env = np.linspace(0.0, 1.0, n) ** 1.5
    env *= np.minimum(1.0, np.linspace(0.0, 1.0, n)[::-1] * 8 + 0.0)
    return x * env


def marimba_modern():
    """Original warm marimba-style tone with a subtle synthetic room."""
    n = int(0.65 * SR)
    t = np.arange(n) / SR
    dry = (np.sin(2 * np.pi * 659.25 * t) * np.exp(-4.5 * t / 0.65) +
           0.30 * np.sin(2 * np.pi * 1318.5 * t) * np.exp(-9.0 * t / 0.65) +
           0.12 * np.sin(2 * np.pi * 1975.5 * t) * np.exp(-14.0 * t / 0.65))
    a = min(n, int(0.003 * SR))
    dry[:a] *= np.linspace(0.0, 1.0, a)
    # tiny mallet click
    rng = np.random.default_rng(3)
    m = int(0.005 * SR)
    dry[:m] += rng.standard_normal(m) * np.hanning(m * 2)[:m] * 0.25
    # synthetic room: 3 lowpassed taps
    wet = np.zeros(n)
    for delay_ms, gain in [(18, 0.20), (37, 0.10), (63, 0.05)]:
        d = int(delay_ms * SR / 1000)
        tap = np.zeros(n)
        tap[d:] = dry[:n - d] * gain
        tw = 32
        tap = np.convolve(tap, np.ones(tw) / tw, mode='same')
        wet += tap
    return dry * 0.85 + wet


def main():
    chime = load('kenney/Audio/confirmation_002.ogg')
    message = load('kenney/Audio/confirmation_003.ogg')
    glass = load('kenney/Audio/glass_004.ogg')
    bell = load('ui/ui_ogg/Ding.ogg')
    pop = load('kenney/Audio/drop_001.ogg')

    base = load('kenney/Audio/maximize_002.ogg')
    bed = noise_swell(len(base)) * 0.22 * np.max(np.abs(base))
    swoosh = fade_out(normalize(base + bed))
    # The swoosh is transient-heavy: match it by RMS instead of peak so
    # it does not stick out as louder than the tonal sounds.

    mar = fade_out(normalize(marimba_modern()))

    sounds = {'chime': chime, 'message-chime': message, 'glass-ping': glass,
              'soft-bell': bell, 'pop': pop, 'mail-swoosh': swoosh,
              'marimba': mar}
    med = float(np.median([rms(x) for x in sounds.values()]))
    for name, x in sounds.items():
        if name == 'mail-swoosh':
            # RMS-match the transient swoosh, then guard the peak.
            x = x / max(rms(x), 1e-6) * med
            if np.max(np.abs(x)) > 0.95:
                x = normalize(x, peak=0.89)
            encode(name, x)
            continue
        g = med / max(rms(x), 1e-6)
        g = min(3.0, max(0.5, g))  # clamp loudness match (+9.5/-6 dB)
        encode(name, normalize(x * g))
    print(f'median rms target: {med:.3f}')


if __name__ == '__main__':
    main()
