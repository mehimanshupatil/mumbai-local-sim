#!/usr/bin/env python3
"""Take the horns out of a Bed clip without taking the street with them.

Every daytime Bed was recorded in an Indian street, so every daytime Bed is
full of horns — `day-street` had one sounding a quarter of the time, at sixty
events a minute. Under a sim that runs for an hour that is not ambience, it is
a drill.

The obvious fix, a compressor keyed on the horn band, cannot win: to pull the
horn down it has to pull the whole band down with it, so the blast becomes a
dip and the street breathes in and out. Measured, the best such filter reached
−5 dB and left the bed pumping.

A horn is not a band, though — it is a fundamental and a few harmonics, six
narrow bins in a spectrum of a thousand. So this finds those bins and lowers
only them. What is between the partials — road, crowd, air — is never touched,
because it was never in them. Measured the same way, this reaches −7.6 dB with
the bed's own level unchanged to a tenth of a decibel.

A horn is separable from a bird, a cricket or a voice by three facts at once:

  * its fundamental sits low, 250–750 Hz, where birds and crickets do not go;
  * it is a harmonic stack, not one tone — 2f and 3f are both there;
  * it is held, 0.15 s or more, at a steady pitch, where a chirp slides.

Deterministic: same input bytes, same output bytes. Called by fetch-beds.sh
between the trim and the loudness match; the results are committed, so a clone
needs neither this script nor numpy.

    python3 scripts/dehonk-beds.py in.wav out.wav
"""
import sys
import wave

import numpy as np

# The detector was tuned at 22.05 kHz. Window and hop scale with the real rate
# so the frequency resolution stays put: a 2048-point window at 44.1 kHz has
# half the resolution and loses most of the horns at their fundamental.
BASE_SR, BASE_N, BASE_HOP = 22050, 2048, 512

F0_LO, F0_HI = 250.0, 750.0
HARMONICS = 6          # beyond the sixth a horn has nothing left worth cutting
CUT_DB = -20.0         # the knee: −28 measures the same, for more artefact risk
WIDTH = 2              # bins either side of a partial that go down with it
TAPER = (1.0, 0.75, 0.4)   # how far the cut reaches, per bin of distance
MIN_RUN_S = 0.15       # a horn is held; anything shorter is a transient
SMOOTH_FRAMES = 3      # so a partial fades rather than switches


def read_wav(path):
    with wave.open(path, "rb") as w:
        sr, channels, frames = w.getframerate(), w.getnchannels(), w.getnframes()
        raw = np.frombuffer(w.readframes(frames), dtype=np.int16)
    return raw.astype(np.float64).reshape(-1, channels) / 32768.0, sr


def write_wav(path, x, sr):
    with wave.open(path, "wb") as w:
        w.setnchannels(x.shape[1])
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())


def stft(x, n, hop, win):
    frames = 1 + max(0, (len(x) - n) // hop)
    idx = np.arange(n)[None, :] + hop * np.arange(frames)[:, None]
    return np.fft.rfft(x[idx] * win, axis=1)


def istft(spec, n, hop, win, length):
    frames = np.fft.irfft(spec, n=n, axis=1) * win
    out = np.zeros(length + n)
    norm = np.zeros(length + n)
    for i in range(frames.shape[0]):
        start = i * hop
        out[start:start + n] += frames[i]
        norm[start:start + n] += win ** 2
    return out[:length] / np.maximum(norm[:length], 1e-9)


def held_runs(hit, need):
    """Keep only stretches of `hit` at least `need` frames long."""
    keep = np.zeros_like(hit)
    i = 0
    while i < len(hit):
        if not hit[i]:
            i += 1
            continue
        j = i
        while j < len(hit) and hit[j]:
            j += 1
        if j - i >= need:
            keep[i:j] = True
        i = j
    return keep


def horn_gain(mono, sr, n, hop):
    """A gain per frame and bin: 1 everywhere except on a horn's partials."""
    win = np.hanning(n)
    mag = np.abs(stft(mono, n, hop, win))
    freqs = np.fft.rfftfreq(n, 1 / sr)
    n_frames, n_bins = mag.shape

    # Each frame against its own spectral floor, so a quiet passage and a loud
    # one are judged the same way.
    floor = np.median(mag[:, (freqs >= 200) & (freqs <= 6000)], axis=1) + 1e-12
    db = 20 * np.log10(mag / floor[:, None] + 1e-12)

    band = np.where((freqs >= F0_LO) & (freqs <= F0_HI))[0]
    cand = band[np.argmax(db[:, band], axis=1)]
    f0 = freqs[cand]
    rows = np.arange(n_frames)
    f0_db = db[rows, cand]

    def partial_db(multiple):
        k = np.clip(np.round(f0 * multiple / (sr / n)).astype(int), 0, n_bins - 1)
        # best of the bin and its neighbours, so a slightly inharmonic stack
        # — which every real horn is — still counts
        return np.max(np.stack([db[rows, np.clip(k + d, 0, n_bins - 1)]
                                for d in (-1, 0, 1)]), axis=0)

    # A peak on the edge of the search band means the real fundamental is
    # outside it: a rumble below 250 Hz reported as 250 Hz because that is as
    # low as we looked. Notching those would cut the road, not a horn.
    edge = (cand <= band[0]) | (cand >= band[-1])
    tonal = (f0_db > 8) & (partial_db(2) > 4) & (partial_db(3) > 4) & ~edge

    steady = np.ones(n_frames, bool)
    steady[1:] = np.abs(np.log2(f0[1:] / np.maximum(f0[:-1], 1e-9))) < 1 / 12

    keep = held_runs(tonal & steady, int(MIN_RUN_S * sr / hop))

    gain = np.ones((n_frames, n_bins))
    cut = 10 ** (CUT_DB / 20)
    for frame in np.where(keep)[0]:
        for multiple in range(1, HARMONICS + 1):
            centre = int(round(f0[frame] * multiple / (sr / n)))
            if centre >= n_bins:
                break
            for offset in range(-WIDTH - 1, WIDTH + 2):
                b = centre + offset
                if 0 <= b < n_bins:
                    weight = TAPER[min(abs(offset), len(TAPER) - 1)]
                    gain[frame, b] = min(gain[frame, b], 1 - weight * (1 - cut))

    if SMOOTH_FRAMES > 1:
        kernel = np.ones(SMOOTH_FRAMES) / SMOOTH_FRAMES
        gain = np.apply_along_axis(
            lambda v: np.convolve(v, kernel, mode="same"), 0, gain)
    return gain, keep


def main(src, dst):
    x, sr = read_wav(src)
    scale = max(1, int(round(sr / BASE_SR)))
    n, hop = BASE_N * scale, BASE_HOP * scale
    win = np.hanning(n)

    # The mask comes from the mono sum, then applies to both channels, so the
    # stereo image of the street survives the surgery.
    gain, keep = horn_gain(x.mean(axis=1), sr, n, hop)

    out = np.zeros_like(x)
    for channel in range(x.shape[1]):
        spec = stft(x[:, channel], n, hop, win)
        rows = min(spec.shape[0], gain.shape[0])
        spec[:rows] *= gain[:rows]
        out[:, channel] = istft(spec, n, hop, win, len(x))

    write_wav(dst, out, sr)
    print(f"  de-honked {100 * keep.mean():.1f}% of frames "
          f"({CUT_DB:.0f} dB on {HARMONICS} partials)", file=sys.stderr)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
