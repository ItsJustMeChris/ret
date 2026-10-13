"""Synthesizes public/soundtrack.wav, cut to the video's timeline (30 fps).

python scripts/soundtrack.py

Everything is generated here (no samples), so the track is ours to use.
Event frames mirror the scene timings in src/Promo.tsx and the scenes' own frame numbers.
"""
import os

import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, sosfilt, fftconvolve

SR = 48000
FPS = 30
TOTAL_FRAMES = 1690
N = int(TOTAL_FRAMES / FPS * SR) + SR  # a second of tail room, trimmed at the end
rng = np.random.default_rng(7)

L = np.zeros(N)
R = np.zeros(N)


def t_of(frame):
    return frame / FPS


def idx(sec):
    return int(sec * SR)


def add(sig, at_sec, gain=1.0, pan=0.0):
    """Mixes a mono or (2, n) signal in at a time, with equal-power pan (-1..1)."""
    i = idx(at_sec)
    if i >= N:
        return
    if sig.ndim == 1:
        a = (pan + 1) * np.pi / 4
        l, r = sig * np.cos(a), sig * np.sin(a)
    else:
        l, r = sig[0], sig[1]
    n = min(len(l), N - i)
    L[i : i + n] += l[:n] * gain
    R[i : i + n] += r[:n] * gain


def lp(x, hz, order=2):
    return sosfilt(butter(order, hz, "low", fs=SR, output="sos"), x)


def hp(x, hz, order=2):
    return sosfilt(butter(order, hz, "high", fs=SR, output="sos"), x)


def bp(x, lo, hi, order=2):
    return sosfilt(butter(order, [lo, hi], "band", fs=SR, output="sos"), x)


def env(n, a, d):
    """Linear attack, exponential decay (seconds)."""
    t = np.arange(n) / SR
    e = np.exp(-np.maximum(t - a, 0) / max(d, 1e-4))
    if a > 0:
        e *= np.minimum(t / a, 1)
    return e


def note(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def saw(freq, n, detune=0.0):
    t = np.arange(n) / SR
    out = np.zeros(n)
    for d in (-detune, 0, detune):
        ph = (t * freq * (1 + d) + rng.random()) % 1.0
        out += 2 * ph - 1
    return out / 3


# ---------------------------------------------------------------- instruments


def kick(dur=0.45, f0=130, f1=42, punch=1.0):
    n = idx(dur)
    t = np.arange(n) / SR
    f = f1 + (f0 - f1) * np.exp(-t / 0.045)
    ph = 2 * np.pi * np.cumsum(f) / SR
    body = np.sin(ph) * env(n, 0.002, dur / 3.2)
    click = hp(rng.standard_normal(n), 2500) * env(n, 0, 0.004) * 0.35 * punch
    return np.tanh((body + click) * 1.6) * 0.9


def hat(dur=0.06, bright=7000):
    n = idx(dur)
    return hp(rng.standard_normal(n), bright, 4) * env(n, 0, dur / 4)


def clap(dur=0.25):
    n = idx(dur)
    noise = bp(rng.standard_normal(n), 900, 3500)
    e = np.zeros(n)
    for k, o in enumerate((0, 0.011, 0.022)):
        e += np.roll(env(n, 0, 0.012 if k < 2 else 0.09), idx(o))
    return noise * e * 0.6


def pluck(m, dur=0.5, bright=2600):
    n = idx(dur)
    s = saw(note(m), n, 0.003) * 0.6 + np.sin(2 * np.pi * note(m) * np.arange(n) / SR) * 0.5
    return lp(s, bright) * env(n, 0.003, dur / 4)


def pad_chord(ms, dur, cutoff=1400):
    n = idx(dur)
    l = np.zeros(n)
    r = np.zeros(n)
    for m in ms:
        l += saw(note(m), n, 0.004)
        r += saw(note(m), n, 0.006)
    t = np.arange(n) / SR
    shape = np.minimum(t / 0.9, 1) * np.minimum((dur - t) / 0.9, 1)
    shape = np.clip(shape, 0, 1)
    return np.stack([lp(l, cutoff) * shape, lp(r, cutoff * 1.1) * shape]) / len(ms)


def sub_bass(m, dur):
    n = idx(dur)
    t = np.arange(n) / SR
    s = np.sin(2 * np.pi * note(m) * t) + 0.25 * np.sin(4 * np.pi * note(m) * t)
    shape = np.minimum(t / 0.02, 1) * np.clip((dur - t) / 0.05, 0, 1)
    return s * shape


def whoosh(dur=0.6, lo=300, hi=6000, up=True):
    n = idx(dur)
    noise = rng.standard_normal(n)
    out = np.zeros(n)
    steps = 24
    seg = n // steps
    for k in range(steps):
        p = k / (steps - 1)
        c = lo * (hi / lo) ** (p if up else 1 - p)
        piece = bp(noise[k * seg : (k + 1) * seg + 2000], c * 0.7, min(c * 1.4, SR / 2 - 100))
        out[k * seg : k * seg + len(piece)] += piece[: n - k * seg] * np.hanning(len(piece))[: n - k * seg]
    t = np.arange(n) / SR
    return out * np.sin(np.pi * t / dur) ** 2 * 0.5


def ui_click(bright=1.0):
    n = idx(0.05)
    t = np.arange(n) / SR
    tone = np.sin(2 * np.pi * 2200 * bright * t) * env(n, 0, 0.006)
    tick = hp(rng.standard_normal(n), 3000) * env(n, 0, 0.003)
    return (tone * 0.5 + tick * 0.5) * 0.9


def key_tap():
    n = idx(0.08)
    thock = lp(rng.standard_normal(n), 1800) * env(n, 0, 0.012)
    t = np.arange(n) / SR
    body = np.sin(2 * np.pi * 320 * t) * env(n, 0, 0.02)
    return thock * 0.8 + body * 0.5


def blip(m, dur=0.18):
    n = idx(dur)
    t = np.arange(n) / SR
    return (np.sin(2 * np.pi * note(m) * t) + 0.3 * np.sin(4 * np.pi * note(m) * t)) * env(n, 0.002, 0.05)


def impact(dur=2.5):
    n = idx(dur)
    t = np.arange(n) / SR
    f = 28 + 70 * np.exp(-t / 0.12)
    boom = np.sin(2 * np.pi * np.cumsum(f) / SR) * env(n, 0.003, 0.7)
    air = hp(rng.standard_normal(n), 4000) * env(n, 0.002, 0.5) * 0.18
    return np.tanh(boom * 2.2) * 0.9 + air


def reverb(l, r, seconds=2.2, mix=0.22):
    n = idx(seconds)
    t = np.arange(n) / SR
    irl = rng.standard_normal(n) * np.exp(-t / (seconds / 6))
    irr = rng.standard_normal(n) * np.exp(-t / (seconds / 6))
    irl, irr = lp(irl, 5000), lp(irr, 5000)
    wl = fftconvolve(l, irl)[: len(l)]
    wr = fftconvolve(r, irr)[: len(r)]
    wl *= np.max(np.abs(l)) / (np.max(np.abs(wl)) + 1e-9)
    wr *= np.max(np.abs(r)) / (np.max(np.abs(wr)) + 1e-9)
    return l * (1 - mix) + wl * mix, r * (1 - mix) + wr * mix


# ---------------------------------------------------------------- timeline

BPM = 120
BEAT = 60 / BPM  # 0.5 s = 15 frames
MUSIC_IN = t_of(150)  # logo hit
DRUMS_OUT = t_of(1490)  # outro: drums drop, chord rings
END = t_of(TOTAL_FRAMES)

# Chaos (0–5 s): typing clatter that thickens, a rising noise and a drone that bends up.
for k in range(260):
    p = (k / 260) ** 0.6
    at = 0.9 + p * 3.9
    add(key_tap(), at + rng.random() * 0.03, gain=0.07 + 0.1 * p, pan=rng.uniform(-0.8, 0.8))
n = idx(4.0)
riser = bp(rng.standard_normal(n), 400, 9000) * np.linspace(0, 1, n) ** 2.5
add(riser, 1.0, gain=0.22)
for m, pan in ((38, -0.3), (39, 0.3), (45, 0)):
    n = idx(4.2)
    t = np.arange(n) / SR
    f = note(m) * (1 + 0.5 * (t / 4.2) ** 3)
    s = lp(np.sign(np.sin(2 * np.pi * np.cumsum(f) / SR)) * 0.4, 900) * np.linspace(0, 1, n) ** 1.5
    add(s, 0.8, gain=0.13, pan=pan)
add(whoosh(0.5, 6000, 300, up=False), t_of(128), gain=0.5)  # the collapse
add(impact(), MUSIC_IN, gain=0.95)

# Chords: Fmaj7 – Am7 – Dm9 – Bbmaj9, two bars each.
CHORDS = [
    ([53, 57, 60, 64], 41, [65, 69, 72, 76]),
    ([57, 60, 64, 67], 45, [69, 72, 76, 79]),
    ([50, 57, 60, 64], 38, [62, 65, 69, 76]),
    ([46, 53, 57, 60], 34, [65, 69, 72, 74]),
]
BAR = BEAT * 4
t = MUSIC_IN
ci = 0
while t < END + 0.5:
    pad, root, arp = CHORDS[ci % 4]
    dur = BAR * 2
    add(pad_chord(pad, dur + 0.8, cutoff=1100 if t < t_of(260) else 1500), t - 0.1, gain=0.42)
    if t < DRUMS_OUT:
        for b in range(8):
            add(sub_bass(root, BEAT * 0.9), t + b * BEAT, gain=0.32)
        # Arp from the canvas scene onward.
        if t >= t_of(250):
            for s in range(16):
                m = arp[[0, 2, 1, 3, 2, 0, 3, 1][s % 8]] + (12 if s % 8 == 7 else 0)
                add(pluck(m, 0.35), t + s * BEAT / 2, gain=0.07, pan=0.35 if s % 2 else -0.35)
    else:
        # Outro: one held, brighter chord with a slow sparkle.
        for s in range(6):
            add(pluck(arp[s % 4] + 12, 0.9, 4000), t + s * BEAT, gain=0.06, pan=-0.4 + 0.16 * s)
        break
    t += dur
    ci += 1

# Drums: kick on every beat, hats on the off-beats, a clap on 2 and 4 from the canvas scene on.
beat_t = MUSIC_IN + BAR  # let the logo breathe for a bar
k = 0
while beat_t < DRUMS_OUT - 0.01:
    add(kick(), beat_t, gain=0.55)
    add(hat(0.05), beat_t + BEAT / 2, gain=0.06, pan=0.25)
    if beat_t >= t_of(260) and k % 2 == 1:
        add(clap(), beat_t, gain=0.16)
    if beat_t >= t_of(550):
        add(hat(0.03, 9000), beat_t + BEAT * 0.75, gain=0.03, pan=-0.3)
    beat_t += BEAT
    k += 1
add(impact(3.5), DRUMS_OUT, gain=0.6)

# Scene transitions.
for f in (260, 550, 770, 970, 1150, 1330):
    add(whoosh(0.55), t_of(f - 9), gain=0.28)

# UI moments, frame-accurate to the scenes.
SCENE = {"canvas": 260, "approve": 550, "inbox": 770, "fork": 970, "agents": 1150, "modes": 1330}
for b, m in ((6, 72), (16, 76), (24, 79), (32, 76), (40, 81), (74, 84)):  # windows popping onto the canvas
    add(blip(m, 0.12), t_of(SCENE["canvas"] + b), gain=0.06, pan=(m - 78) / 10)
add(blip(88, 0.2), t_of(SCENE["canvas"] + 96), gain=0.08)  # fork badge
add(blip(84, 0.25), t_of(SCENE["canvas"] + 170), gain=0.08)  # beacon
add(ui_click(), t_of(SCENE["approve"] + 93), gain=0.5)  # Allow once
add(blip(84), t_of(SCENE["approve"] + 97), gain=0.12)
add(blip(91), t_of(SCENE["approve"] + 100), gain=0.1)
add(blip(79, 0.25), t_of(SCENE["approve"] + 128), gain=0.08)  # question dock
add(key_tap(), t_of(SCENE["approve"] + 166), gain=0.55)  # "2"
add(blip(86), t_of(SCENE["approve"] + 168), gain=0.1)
for f in (58, 80, 102):
    add(key_tap(), t_of(SCENE["inbox"] + f), gain=0.5)  # j
add(key_tap(), t_of(SCENE["inbox"] + 140), gain=0.55)  # e
add(blip(84), t_of(SCENE["inbox"] + 142), gain=0.1)
add(blip(91), t_of(SCENE["inbox"] + 145), gain=0.1)
add(ui_click(), t_of(SCENE["fork"] + 58), gain=0.5)  # Fork from here
add(whoosh(0.45, 500, 7000), t_of(SCENE["fork"] + 60), gain=0.3)
add(blip(88, 0.3), t_of(SCENE["fork"] + 78), gain=0.1)
for i in range(7):  # ticks landing in the comparison table
    d = 34 + i * 9
    add(blip(76 + [0, 2, 4, 5, 7, 9, 11][i], 0.1), t_of(SCENE["agents"] + d + 4), gain=0.05, pan=-0.3)
    add(blip(88 + [0, 2, 4, 5, 7, 9, 11][i] - 12, 0.1), t_of(SCENE["agents"] + d + 7), gain=0.05, pan=0.3)
for i in range(4):  # mode switches
    add(key_tap(), t_of(SCENE["modes"] + 22 + i * 34), gain=0.4)
    add(whoosh(0.3, 800, 5000), t_of(SCENE["modes"] + 22 + i * 34), gain=0.12)
add(blip(84, 0.4), t_of(1490 + 54), gain=0.1)  # CTA

# ---------------------------------------------------------------- master

L, R = reverb(L, R)
n_end = idx(END)
L, R = L[:n_end], R[:n_end]
fade = np.ones(n_end)
f_len = idx(1.6)
fade[-f_len:] = np.linspace(1, 0, f_len) ** 1.5
L *= fade
R *= fade
L = hp(L, 25)
R = hp(R, 25)
peak = max(np.max(np.abs(L)), np.max(np.abs(R)))
L, R = np.tanh(L / peak * 1.3) / np.tanh(1.3), np.tanh(R / peak * 1.3) / np.tanh(1.3)
out = np.stack([L, R], axis=1) * 0.89
os.makedirs("public", exist_ok=True)  # not in git (the soundtrack is hosted on the CDN)
wavfile.write("public/soundtrack.wav", SR, (out * 32767).astype(np.int16))
print(f"wrote public/soundtrack.wav, {n_end / SR:.2f}s")
