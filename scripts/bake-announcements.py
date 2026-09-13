#!/usr/bin/env python3
"""Bake the Phrase Bank: every fragment the PA can say, in Marathi and English.

Announcements are assembled at runtime from fragments, the way real Indian
railway announcements are assembled — see
docs/adr/0002-announcements-are-baked-synthetic-speech.md, which also explains
why the voice is synthetic and why there is no Hindi. Read it before adding a
language or proposing recordings.

Output, both committed so a clone runs with no bake step:

  public/audio/speech/<lang>.m4a   one sprite per language, every fragment
                                   end to end
  src/data/phrase-bank.json        offsets into it, plus the templates that
                                   say what order the fragments go in

Re-baking needs Piper and ffmpeg, in the same way re-baking the timetable
needs Python:

  python3 -m venv .venv && .venv/bin/pip install -r scripts/requirements-announcements.txt
  .venv/bin/python scripts/bake-announcements.py

Deterministic by construction: the voices are pinned, the speaker is pinned,
and synthesis runs with both noise scales at zero, so a re-bake is
byte-identical rather than merely similar. (VITS is otherwise stochastic —
identical text gives a slightly different waveform every run, which would
churn a committed binary on every bake for no audible gain.)
"""

from __future__ import annotations

import json
import subprocess
import sys
import wave
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from piper import PiperVoice, SynthesisConfig

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "scripts" / ".cache" / "piper-voices"
SPEECH_OUT = ROOT / "public" / "audio" / "speech"
INDEX_OUT = ROOT / "src" / "data" / "phrase-bank.json"
NETWORK = ROOT / "src" / "data" / "western.json"

VOICE_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main"


@dataclass(frozen=True)
class Voice:
    """A pinned Piper voice, with where it came from and what it costs us."""

    name: str
    path: str  # inside the piper-voices repo
    speaker_id: int
    licence: str
    dataset: str


# Marathi is the only cleanly licensed Indian-language voice available (ADR
# 0002); English is a British voice trained on public-domain LibriVox audio,
# which is the nearest thing to the clipped RP-inflected English of a real
# station PA that comes without a licence problem.
VOICES = {
    "mr": Voice(
        name="mr_IN-google-medium",
        path="mr/mr_IN/google/medium",
        # One of nine OpenSLR-64 speakers; pinned so a re-bake keeps the voice.
        speaker_id=0,
        licence="CC BY-SA 4.0",
        dataset="https://openslr.org/64/",
    ),
    "en": Voice(
        name="en_GB-cori-high",
        path="en/en_GB/cori/high",
        speaker_id=0,
        licence="public domain (LibriVox)",
        dataset="https://librivox.org",
    ),
}

# Fixed words and phrases. Keys are shared across languages; the words are not,
# and neither is the order they go in — see TEMPLATES.
WORDS = {
    "mr": {
        "attention": "कृपया लक्ष द्या",
        "arriving": "येत आहे",
        "departing": "सुटत आहे",
        "next-station": "पुढील स्थानक",
        "arriving-at": "स्थानक येत आहे",
        "last-station": "शेवटचे स्थानक, कृपया सर्व प्रवाशांनी उतरावे",
        "local": "लोकल",
        "towards": "कडे जाणारी",
        "oclock": "वाजून",
        "minutes": "मिनिटांनी",
        "type-slow": "धीमी",
        "type-fast": "जलद",
        "type-ac": "वातानुकूलित",
    },
    "en": {
        "attention": "Attention please.",
        "arriving": "is arriving.",
        "departing": "is departing.",
        "next-station": "Next station,",
        "arriving-at": "Arriving at",
        "last-station": "Last station. All passengers please alight.",
        "local": "local to",
        "towards": "",  # English puts the destination after "local to"
        "oclock": "",  # "nine fifteen", not "nine o'clock fifteen"
        "minutes": "",
        "type-slow": "slow",
        "type-fast": "fast",
        "type-ac": "air conditioned",
    },
}

# What order the fragments go in. Grammar belongs with the language, not with
# the player, so Marathi's destination-then-verb order lives here rather than
# being hardcoded in the scene. {hour} {minute} {type} {station} are filled in
# at play time; a token that resolves to an empty fragment is skipped.
TEMPLATES = {
    "mr": {
        "announce-approach": [
            "attention",
            "{hour}",
            "oclock",
            "{minute}",
            "minutes",
            "{type}",
            "local",
            "{station}",
            "towards",
            "arriving",
        ],
        "announce-departure": [
            "attention",
            "{hour}",
            "oclock",
            "{minute}",
            "minutes",
            "{type}",
            "local",
            "{station}",
            "towards",
            "departing",
        ],
        "callout-departure": ["next-station", "{station}"],
        "callout-approach": ["{station}", "arriving-at"],
        "callout-terminus": ["{station}", "last-station"],
    },
    "en": {
        "announce-approach": [
            "attention",
            "{hour}",
            "{minute}",
            "{type}",
            "local",
            "{station}",
            "arriving",
        ],
        "announce-departure": [
            "attention",
            "{hour}",
            "{minute}",
            "{type}",
            "local",
            "{station}",
            "departing",
        ],
        "callout-departure": ["next-station", "{station}"],
        "callout-approach": ["arriving-at", "{station}"],
        "callout-terminus": ["{station}", "last-station"],
    },
}

# espeak-ng reads Devanagari station names correctly, so Marathi needs no help.
# English is another matter: left alone it says Borivali as "Bo-RYE-vali" and
# Vile Parle as "vile parl". These respellings are pronunciation hints for the
# phonemiser, not alternative names — the UI never shows them. Only the names
# espeak actually gets wrong are listed; the rest go through as written.
EN_RESPELL = {
    "lowerparel": "Lower Pa rell",
    "prabhadevi": "Prubha dayvee",
    "santacruz": "Santa crooz",
    "vileparle": "Veelay Parlay",
    "andheri": "Undheri",
    "jogeshwari": "Jogaysh varee",
    "goregaon": "Goray gaav",
    "borivali": "Boree vaalee",
    "bhayandar": "Bha yandar",
    "naigaon": "Nye gaav",
    "virar": "Veerar",
    "vaitarna": "Vytarna",
    "saphale": "Sapha lay",
    "kelveroad": "Kelvay Road",
    "vangaon": "Van gaav",
}

# Hours are announced on the 24-hour clock, like the timetable and the app's
# own clock; minutes go 0–59. One fragment per number, shared by both.
NUMBERS = range(0, 60)

SAMPLE_RATE = 22050
# A beat between fragments. Real assembled announcements have one, and without
# it "next station" runs into the station name.
GAP_S = 0.09


def fragments_for(lang: str, stations: list[dict]) -> dict[str, str]:
    """Every fragment this language needs, as key → text to synthesise."""
    out: dict[str, str] = {}
    for key, text in WORDS[lang].items():
        if text:
            out[f"word.{key}"] = text
    for n in NUMBERS:
        out[f"num.{n}"] = str(n)
    for station in stations:
        if lang == "mr":
            text = station["nameMr"]
        else:
            text = EN_RESPELL.get(station["id"], station["name"])
        out[f"station.{station['id']}"] = text
    return out


def synthesise(voice: PiperVoice, cfg: SynthesisConfig, text: str) -> np.ndarray:
    chunks = list(voice.synthesize(text, cfg))
    if not chunks:
        raise SystemExit(f"piper produced no audio for {text!r}")
    return np.concatenate([c.audio_float_array for c in chunks])


# Piper pads every utterance with a little silence at each end. Harmless for a
# whole sentence, ruinous for fragments: eleven fragments carry eleven pairs of
# pauses, and a two-language announcement runs twenty seconds when it should
# run twelve. Trim to where the speech actually starts and stops, keeping a
# hair either side so nothing is clipped.
TRIM_THRESHOLD = 0.015
TRIM_PAD_S = 0.02


def trim_silence(samples: np.ndarray) -> np.ndarray:
    peak = float(np.max(np.abs(samples)))
    if peak <= 0:
        return samples
    loud = np.flatnonzero(np.abs(samples) > TRIM_THRESHOLD * peak)
    if loud.size == 0:
        return samples
    pad = int(TRIM_PAD_S * SAMPLE_RATE)
    start = max(0, int(loud[0]) - pad)
    end = min(len(samples), int(loud[-1]) + pad)
    return samples[start:end]


def to_int16(samples: np.ndarray) -> np.ndarray:
    # Normalise each fragment to the same peak: fragments are cut apart and
    # recombined in orders the voice never actually spoke, and one loud word in
    # the middle of a sentence gives the seam away faster than the seam does.
    peak = float(np.max(np.abs(samples))) or 1.0
    levelled = np.clip(samples / peak * 0.89, -1.0, 1.0)
    return (levelled * 32767).astype(np.int16)


def bake_language(lang: str, stations: list[dict]) -> dict:
    voice_spec = VOICES[lang]
    model = ensure_voice(voice_spec)
    voice = PiperVoice.load(str(model))
    cfg = SynthesisConfig(
        speaker_id=voice_spec.speaker_id if voice.config.num_speakers > 1 else None,
        # Zero noise is what makes a re-bake byte-identical. It also flattens
        # the delivery slightly, which for a station PA reads as correct.
        noise_scale=0.0,
        noise_w_scale=0.0,
        length_scale=1.0,
        normalize_audio=False,
    )
    if voice.config.sample_rate != SAMPLE_RATE:
        raise SystemExit(
            f"{voice_spec.name} is {voice.config.sample_rate} Hz, expected {SAMPLE_RATE}"
        )

    wanted = fragments_for(lang, stations)
    gap = np.zeros(int(GAP_S * SAMPLE_RATE), dtype=np.int16)
    pieces: list[np.ndarray] = []
    index: dict[str, list[float]] = {}
    at = 0
    for key in sorted(wanted):
        audio = to_int16(trim_silence(synthesise(voice, cfg, wanted[key])))
        index[key] = [round(at / SAMPLE_RATE, 4), round(len(audio) / SAMPLE_RATE, 4)]
        pieces.append(audio)
        pieces.append(gap)
        at += len(audio) + len(gap)
        print(f"  {lang} {key:<28} {len(audio) / SAMPLE_RATE:5.2f}s", flush=True)

    sprite = np.concatenate(pieces)
    SPEECH_OUT.mkdir(parents=True, exist_ok=True)
    wav_path = SPEECH_OUT / f"{lang}.wav"
    with wave.open(str(wav_path), "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(SAMPLE_RATE)
        f.writeframes(sprite.tobytes())
    m4a_path = SPEECH_OUT / f"{lang}.m4a"
    subprocess.run(
        [
            "ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", str(wav_path),
            # Speech, mono, one voice: 96 kbps is transparent here, and the
            # sprite is one request either way.
            "-c:a", "aac", "-b:a", "96k", "-ar", str(SAMPLE_RATE), "-ac", "1",
            "-movflags", "+faststart", str(m4a_path),
        ],
        check=True,
    )
    wav_path.unlink()
    return {
        "file": f"audio/speech/{lang}.m4a",
        "voice": voice_spec.name,
        "licence": voice_spec.licence,
        "dataset": voice_spec.dataset,
        "sampleRate": SAMPLE_RATE,
        "fragments": index,
        "templates": TEMPLATES[lang],
    }


def ensure_voice(spec: Voice) -> Path:
    """Fetch a pinned voice into the (gitignored) cache if it isn't there."""
    CACHE.mkdir(parents=True, exist_ok=True)
    model = CACHE / f"{spec.name}.onnx"
    for suffix in ("", ".json"):
        target = Path(str(model) + suffix)
        if target.exists():
            continue
        url = f"{VOICE_BASE}/{spec.path}/{spec.name}.onnx{suffix}"
        print(f"fetching {target.name}", flush=True)
        # curl rather than urllib: the system Python's certificate store is
        # not always wired up on macOS, and this is a build script.
        subprocess.run(["curl", "-sfL", "-o", str(target), url], check=True)
    return model


def main() -> None:
    network = json.loads(NETWORK.read_text())
    stations = network["stations"]
    missing = [s["id"] for s in stations if not s.get("nameMr") or not s.get("name")]
    if missing:
        raise SystemExit(f"stations without a name in both languages: {missing}")

    banks = {lang: bake_language(lang, stations) for lang in VOICES}

    # Fail loudly rather than shipping a bank that cannot say a station's name.
    for lang, bank in banks.items():
        for station in stations:
            key = f"station.{station['id']}"
            if key not in bank["fragments"]:
                raise SystemExit(f"{lang}: no fragment for {station['name']}")

    INDEX_OUT.write_text(
        json.dumps(
            {
                "bakedBy": "scripts/bake-announcements.py",
                "languages": banks,
            },
            ensure_ascii=False,
            indent=1,
        )
        + "\n"
    )
    total = sum((SPEECH_OUT / f"{lang}.m4a").stat().st_size for lang in banks)
    print(f"wrote {INDEX_OUT.relative_to(ROOT)} and {len(banks)} sprites, {total / 1e6:.1f} MB")


if __name__ == "__main__":
    sys.exit(main())
