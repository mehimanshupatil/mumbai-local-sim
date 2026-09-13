# Announcements are baked synthetic speech, in Marathi and English only

Announcements and Callouts are assembled at runtime from a Phrase Bank baked
offline with [Piper](https://github.com/OHF-Voice/piper1-gpl) text-to-speech,
in Marathi and English. They are not recordings, and there is no Hindi — which
is the reverse of what a Mumbai commuter would expect to hear, so both are
worth explaining.

## Why not recordings

Real Western Railway station audio is the authentic answer and is not
licensable for redistribution. Field recordings that happen to capture a
platform announcement do exist under CC-BY — two are used as ambient Beds —
but a recording carries one Station's announcement, not 37, and cutting a
real announcement apart to synthesise the other 36 is both legally murkier
and technically impossible: the fragments are not there.

## Why no Hindi

Real WR announcements run Marathi, then Hindi, then English. Hindi is absent
because every Hindi voice available to us is encumbered, and shipping a voice
we cannot license is worse than shipping two languages:

| Voice | Trained on | Licence | Verdict |
| --- | --- | --- | --- |
| `mr_IN/google` | [OpenSLR-64](https://openslr.org/64/) | CC-BY-SA 4.0 | Usable, with attribution and share-alike on the generated audio |
| `hi_IN/pratham` | AI4Bharat indicnlp | CC BY-**NC**-SA 4.0 | Non-commercial only |
| `hi_IN/priyamvada` | AI4Bharat indicnlp | CC BY-**NC**-SA 4.0 | Non-commercial only |
| `hi_IN/rohan` | IIT Madras IndicTTS | [Bespoke IITM terms](https://www.iitm.ac.in/donlab/indictts/downloads/license.pdf) | Unclear — sources conflict between CC-BY-4.0 and research-only |

English has permissive voices and is not in doubt. The Phrase Bank is keyed by
language, so Hindi is a data addition rather than a code change on the day a
clearly-licensed voice exists, or a licence is clarified.

## Why concatenative rather than whole sentences

There is no size budget forcing this — whole baked sentences per Station per
phrase type would fit. Fragments are chosen because real Indian railway
announcements *are* concatenative, and the audible seams between "पुढील
स्थानक" and a Station name are what they actually sound like. Smooth
end-to-end prosody would be less like the thing being simulated, not more.

## Consequences

- Generated speech inherits CC-BY-SA 4.0 from the Marathi voice's training
  data. That obligation attaches to the audio artefacts, not to the source
  code, and is recorded in `docs/attribution.md` alongside the CC-BY sample
  and existing ODbL data provenance.
- Re-baking needs Piper installed, in the same way re-baking the timetable
  needs Python. The sprites are committed so that a clone runs without either.
- Announcements never say a platform number. That follows ADR 0001, not this
  decision — see its consequences.
