#!/usr/bin/env python3
"""Modern Apple-style notification sounds, synthesized from scratch (CC0).

Design language of current macOS/iOS notification sounds: pristine
sine-based partials with physical (inharmonic) mode ratios, soft precise
attacks, smooth exponential decays, gentle pitch envelopes instead of
static tones, and an airy room/hall tail (convolution reverb). No harsh
noise, no square waves, no 8-bit character.

Engine: 44.1 kHz mono, modal synthesis + FFT-convolution reverb
(exponentially decaying noise impulse, progressively lowpassed),
soft-clip glue, peak normalize.
"""
import numpy as np

SR = 44100


# ------------------------------------------------------------------ utils

def t_axis(n):
    return np.arange(n) / SR


def adsr_decay(n, attack_ms, decay_rate):
    """Soft attack then exponential decay to -60 dB-ish by end."""
    t = t_axis(n)
    a = np.minimum(1.0, t / max(attack_ms / 1000.0, 1e-4))
    return a * np.exp(-decay_rate * t)


def mode(freq, n, attack_ms, decay_rate, level=1.0, phase=0.0):
    return level * np.sin(2 * np.pi * freq * t_axis(n) + phase) * \
        adsr_decay(n, attack_ms, decay_rate)


def chirp(f0, f1, n, attack_ms, decay_rate, level=1.0, curve='exp'):
    """Sine gliding f0 -> f1 (exponential or linear)."""
    t = t_axis(n)
    dur = n / SR
    if curve == 'exp':
        k = np.log(max(f1, 1) / max(f0, 1)) / dur
        phase = 2 * np.pi * f0 * (np.exp(k * t) - 1) / k
    else:
        k = (f1 - f0) / dur
        phase = 2 * np.pi * (f0 * t + 0.5 * k * t * t)
    return level * np.sin(phase) * adsr_decay(n, attack_ms, decay_rate)


def noise_sweep(n, f0, f1, q_smooth=64, attack_ms=60, decay_rate=5.0,
                level=1.0, seed=11):
    """Airy whoosh: white noise through a smoothly sweeping lowpass."""
    rng = np.random.default_rng(seed)
    x = rng.standard_normal(n)
    x = np.convolve(x, np.ones(q_smooth) / q_smooth, mode='same')
    cutoff = np.logspace(np.log10(f0), np.log10(f1), n)
    rc = 1.0 / (2 * np.pi * cutoff)
    alpha = 1.0 / (1.0 + rc * SR)
    y = np.empty(n)
    last = 0.0
    for i in range(n):
        last += alpha[i] * (x[i] - last)
        y[i] = last
    return level * y * adsr_decay(n, attack_ms, decay_rate)


def reverb(x, rt60=0.9, wet=0.22, seed=5):
    """Convolve with an exponentially decaying noise impulse (mono room)."""
    m = int(min(len(x), rt60 * SR))
    rng = np.random.default_rng(seed)
    ir = rng.standard_normal(m) * np.exp(-6.9 * np.arange(m) / SR / rt60)
    # progressively darker tail: cumulative smoothing
    w = 24
    ir = np.convolve(ir, np.ones(w) / w, mode='same')
    tail = np.convolve(x, ir, mode='full')[:len(x)]
    tail *= wet / max(np.max(np.abs(tail)), 1e-6) * np.max(np.abs(x))
    return x + tail


def glue(x, drive=1.4):
    return np.tanh(x * drive) / np.tanh(drive)


def finalize(x, peak=0.89):
    p = np.max(np.abs(x))
    if p > 0:
        x = x / p * peak
    return np.clip(x, -1.0, 1.0)


def save(name, x):
    import wave
    import subprocess
    x = finalize(glue(x))
    pcm = (x * 32767).astype(np.int16)
    wav = f'/tmp/opencode/modern_{name}.wav'
    with wave.open(wav, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    subprocess.run(
        ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', wav,
         '-c:a', 'libvorbis', '-q:a', '4', '-ac', '1', '-ar', '44100',
         f'/home/ubai/Projects/Gnome/Appchime/appchime@ubai.dev/{name}.oga'],
        check=True)
    rms = float(np.sqrt(np.mean(x ** 2)))
    print(f'{name}.oga: {len(x) / SR:.2f}s rms={rms:.3f}')


# ---------------------------------------------------------------- sounds

def s_chime():
    """Default: modern glass-bar chime (G6), inharmonic modes + room."""
    n = int(0.85 * SR)
    f = 1567.98
    y = (mode(f, n, 4, 3.2, 1.0) +
         mode(f * 2.76, n, 3, 5.0, 0.35) +
         mode(f * 5.40, n, 2, 7.5, 0.16) +
         mode(f * 8.93, n, 2, 10.0, 0.08))
    return reverb(y, rt60=0.8, wet=0.20)


def s_mail_swoosh():
    """Mail: bright airy attack settling into a warm descending body.

    Original synthesis that follows the *gesture* of a classic mail
    "shooop" (airy onset, body gliding down, smooth ~0.5 s decay), with
    its own pitches and curves. No Apple audio was used; a public
    sound-button copy served only as a structural reference and never
    ships with the project.
    """
    n = int(0.60 * SR)
    # Airy onset burst.
    air = noise_sweep(n, 2500, 900, q_smooth=48, attack_ms=8,
                      decay_rate=16.0, level=0.55)
    # Warm body gliding down: fundamental + 3rd harmonic + faint 2nd.
    # Slightly delayed onset so the airy attack leads, as in the genre.
    body = (chirp(830, 690, n, 10, 5.2, level=1.0) +
            chirp(2490, 2070, n, 8, 8.0, level=0.28) +
            chirp(1660, 1380, n, 8, 9.5, level=0.10))
    lead = min(n, int(0.030 * SR))
    body[:lead] *= 0.5 * (1 - np.cos(np.pi * np.arange(lead) / lead))
    return reverb(air + body, rt60=0.35, wet=0.14)


def s_message_chime():
    """Message: iOS-like ascending tri-tone (C6-E6-G6) with hall."""
    n = int(0.75 * SR)
    y = np.zeros(n)
    for i, f in enumerate([1046.50, 1318.51, 1567.98]):
        start = int(i * 0.13 * SR)
        m = int(0.36 * SR)
        tone = (mode(f, m, 5, 7.0, 1.0) +
                mode(f * 2.0, m, 4, 10.0, 0.25))
        y[start:start + m] += tone
    return reverb(y, rt60=0.9, wet=0.22)


def s_glass_ping():
    """Sonar ping: gentle downward sine chirp, long glassy tail."""
    n = int(1.1 * SR)
    y = (chirp(1180, 940, n, 6, 3.0, level=1.0) +
         chirp(2360, 1880, n, 5, 5.0, level=0.22))
    return reverb(y, rt60=1.1, wet=0.24)


def s_soft_bell():
    """Bell: warm struck-metal modes, slow blooming decay."""
    n = int(1.2 * SR)
    f = 880.0
    y = (mode(f, n, 6, 2.4, 1.0) +
         mode(f * 2.02, n, 5, 3.8, 0.40) +
         mode(f * 2.94, n, 4, 5.2, 0.22) +
         mode(f * 4.10, n, 3, 7.0, 0.10))
    return reverb(y, rt60=1.0, wet=0.22)


def s_marimba():
    """Marimba bar: true 1/4/10 mode ratios, mallet tap, small room."""
    n = int(0.7 * SR)
    f = 659.26
    y = (mode(f, n, 3, 5.2, 1.0) +
         mode(f * 4.0, n, 2, 11.0, 0.28) +
         mode(f * 9.8, n, 2, 16.0, 0.10))
    rng = np.random.default_rng(3)
    m = int(0.004 * SR)
    y[:m] += rng.standard_normal(m) * np.hanning(m * 2)[:m] * 0.18
    return reverb(y, rt60=0.5, wet=0.18)


def s_pop():
    """Bubble pop: fast pitch-drop tick with micro room."""
    n = int(0.16 * SR)
    y = chirp(1050, 480, n, 2, 22.0, level=1.0, curve='lin')
    rng = np.random.default_rng(9)
    m = int(0.003 * SR)
    y[:m] += rng.standard_normal(m) * 0.3
    return reverb(y, rt60=0.25, wet=0.14)


if __name__ == '__main__':
    sounds = {
        'chime': s_chime(),
        'mail-swoosh': s_mail_swoosh(),
        'message-chime': s_message_chime(),
        'glass-ping': s_glass_ping(),
        'soft-bell': s_soft_bell(),
        'marimba': s_marimba(),
        'pop': s_pop(),
    }
    # Loudness-match the set to the median RMS (reverb tails are clean,
    # so boosting is safe); peak guard after.
    med = float(np.median([np.sqrt(np.mean(x ** 2)) for x in sounds.values()]))
    for name, x in sounds.items():
        r = float(np.sqrt(np.mean(x ** 2)))
        x = x / max(r, 1e-6) * med
        if np.max(np.abs(x)) > 0.95:
            x = x / np.max(np.abs(x)) * 0.89
        save(name, x)
    print(f'median rms: {med:.3f}')
