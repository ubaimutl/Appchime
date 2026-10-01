#!/usr/bin/env python3
"""Synthesize Appchime's bundled notification sounds.

All sounds are original (generated here with numpy), released as CC0.
Output: 44100 Hz mono WAV files, peak-normalized with RMS loosely matched,
then converted to Ogg Vorbis (.oga) with ffmpeg (see convert step below).

Apple-style evocation without copying anything: short envelopes, sine-based
partials, soft attacks. Nothing sampled, no recordings, no downloads.
"""
import wave

import numpy as np

SR = 44100
OUT = '/tmp/opencode/synth'


def env_ad(n, attack, decay_curve=3.0):
    """Attack ramp then exponential decay to ~0."""
    t = np.arange(n) / SR
    dur = n / SR
    a = np.minimum(1.0, t / max(attack, 1e-4))
    d = np.exp(-decay_curve * t / dur)
    return a * d


def sine(freq, n, phase=0.0):
    t = np.arange(n) / SR
    return np.sin(2 * np.pi * freq * t + phase)


def sweep(f0, f1, n):
    """Sine with linear frequency sweep f0 -> f1."""
    t = np.arange(n) / SR
    k = (f1 - f0) / (n / SR)
    return np.sin(2 * np.pi * (f0 * t + 0.5 * k * t * t))


def bandpass_sweep_noise(n, f0, f1, q=1.2):
    """White noise through a sweeping resonant lowpass (whoosh body)."""
    rng = np.random.default_rng(7)
    x = rng.standard_normal(n)
    # Time-varying one-pole lowpass cutoff swept f0 -> f1 (log).
    cutoff = np.logspace(np.log10(f0), np.log10(f1), n)
    rc = 1.0 / (2 * np.pi * cutoff)
    alpha = 1.0 / (1.0 + rc * SR)
    y = np.empty(n)
    last = 0.0
    for i in range(n):
        last += alpha[i] * (x[i] - last)
        y[i] = last
    # Crude resonance emphasis around the sweep: differentiate slightly.
    y = y - 0.4 * np.concatenate(([0.0], y[:-1]))
    return y


def save(name, data):
    data = np.asarray(data, dtype=np.float64)
    peak = np.max(np.abs(data))
    if peak > 0:
        data = data / peak * 0.89
    pcm = np.clip(data, -1.0, 1.0)
    pcm = (pcm * 32767).astype(np.int16)
    with wave.open(f'{OUT}/{name}.wav', 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    rms = float(np.sqrt(np.mean(data ** 2)))
    print(f'{name}: {len(data) / SR:.2f}s rms={rms:.3f}')


def mail_swoosh():
    """Soft mail whoosh: airy rising sweep, ~0.55 s."""
    n = int(0.55 * SR)
    body = bandpass_sweep_noise(n, 700, 3600)
    tone = sweep(500, 1400, n) * 0.25
    e = env_ad(n, attack=0.09, decay_curve=4.5)
    save('mail-swoosh', (body * 0.8 + tone) * e)


def message_chime():
    """Short two-tone message chime (B5 -> E6), ~0.5 s."""
    n1, n2 = int(0.14 * SR), int(0.36 * SR)
    t1 = (sine(987.77, n1) + 0.3 * sine(1975.5, n1)) * env_ad(n1, 0.008, 4.0)
    t2 = (sine(1318.5, n2) + 0.3 * sine(2637.0, n2)) * env_ad(n2, 0.008, 3.2)
    save('message-chime', np.concatenate([t1, t2]))


def glass_ping():
    """Glassy ping: bright partials, ~0.9 s decay."""
    n = int(0.9 * SR)
    partials = [(2093.0, 1.0, 3.0), (2793.8, 0.45, 4.2), (3520.0, 0.3, 5.0)]
    y = sum(a * sine(f, n) * env_ad(n, 0.004, d) for f, a, d in partials)
    save('glass-ping', y)


def soft_bell():
    """Soft bell: warm inharmonic partials, ~1.0 s."""
    n = int(1.0 * SR)
    partials = [(523.25, 1.0, 2.6), (1056.5, 0.4, 3.6), (1538.0, 0.22, 4.6)]
    y = sum(a * sine(f, n) * env_ad(n, 0.006, d) for f, a, d in partials)
    save('soft-bell', y)


def marimba():
    """Gentle marimba-style tone (E5) with mallet click, ~0.6 s."""
    n = int(0.6 * SR)
    body = sine(659.25, n) * env_ad(n, 0.004, 4.5)
    harm = 0.35 * sine(2637.0, n) * env_ad(n, 0.002, 9.0)
    rng = np.random.default_rng(3)
    click = np.zeros(n)
    m = int(0.006 * SR)
    click[:m] = rng.standard_normal(m) * np.hanning(m * 2)[:m] * 0.5
    save('marimba', body + harm + click)


def pop():
    """Neutral soft pop: falling blip, ~0.16 s."""
    n = int(0.16 * SR)
    y = sweep(720, 440, n) * env_ad(n, 0.004, 5.0)
    save('pop', y)


def chime():
    """Warm Chime (default): soft struck tone, ~0.7 s."""
    n = int(0.7 * SR)
    y = (sine(880.0, n) + 0.35 * sine(1320.0, n) + 0.15 * sine(1760.0, n))
    y = y * env_ad(n, 0.008, 3.4)
    save('chime', y)


if __name__ == '__main__':
    mail_swoosh()
    message_chime()
    glass_ping()
    soft_bell()
    marimba()
    pop()
    chime()
