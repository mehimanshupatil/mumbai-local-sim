# Attribution

Everything in this repo that came from somewhere else, and what its licence
asks of anyone who uses it. The README lists the same sources in one line each;
this is the long form, kept because some of these licences have obligations
that a one-liner cannot discharge.

## Data

| What | Source | Licence |
| --- | --- | --- |
| Track geometry, stations, yards | [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors | ODbL |
| Terrain heightfield | [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (terrarium) | Public domain / per-source, see registry |
| Timetable | Western Railway Public Time Tables, PTT 79, W.E.F. 01.09.2026 | Published by Indian Railways; used as factual schedule data |
| Fonts | Noto Sans, Noto Sans Devanagari | [OFL](../public/fonts/OFL.txt) |

## Ambient Beds

`public/audio/beds/` holds the ambience the sim plays under everything else.
Every clip is a **CC-BY 4.0** field recording from [Freesound](https://freesound.org/),
and most were recorded in India — the Bed is the one place where a real
recording of the actual country beats anything synthetic.

Each is used as a one-minute excerpt, loudness-matched and re-encoded to AAC
(`scripts/fetch-beds.sh`). CC-BY 4.0 permits that, and asks for credit and an
indication of changes in return; this table is both.

| File | Recording | Author | Source |
| --- | --- | --- | --- |
| `dawn-birds.m4a` | Sweet Bird Morning Ambience | tanweraman | [770080](https://freesound.org/people/tanweraman/sounds/770080/) |
| `dawn-suburb.m4a` | Ambient_Padmanabhanagar_Morning | Bheemasena | [430998](https://freesound.org/people/Bheemasena/sounds/430998/) |
| `day-street.m4a` | BR_056_India_Street | kevp888 | [578755](https://freesound.org/people/kevp888/sounds/578755/) |
| `day-traffic.m4a` | Chennai (India) Traffic Ambience 01 | Nielsvdb | [465712](https://freesound.org/people/Nielsvdb/sounds/465712/) |
| `dusk-garden.m4a` | MVI_6965_IN_MahabodhiGarden | kevp888 | [466262](https://freesound.org/people/kevp888/sounds/466262/) |
| `dusk-turning.m4a` | Birds to Crickets | deadmanswill | [568216](https://freesound.org/people/deadmanswill/sounds/568216/) |
| `night-crickets.m4a` | Night Crickets on a Quiet Road – Goa Ambience | Rico_Casazza | [803557](https://freesound.org/people/Rico_Casazza/sounds/803557/) |
| `night-alley.m4a` | Night Crickets in Alleyway – Nature Ambience | Rico_Casazza | [803556](https://freesound.org/people/Rico_Casazza/sounds/803556/) |
| `crowd-kharghar.m4a` | Ambience near Kharghar station Mumbai | sankalp | [181118](https://freesound.org/people/sankalp/sounds/181118/) |
| `crowd-kanpur.m4a` | Kanpur railway station | sankalp | [180428](https://freesound.org/people/sankalp/sounds/180428/) |
| `traffic-jam.m4a` | BR_002_India_TrafficJam | kevp888 | [578743](https://freesound.org/people/kevp888/sounds/578743/) |

All eleven: **CC BY 4.0**, <https://creativecommons.org/licenses/by/4.0/>.
Changes made: trimmed to a one-minute excerpt, loudness-normalised to −23 LUFS,
two-second fades added at both ends, re-encoded to 128 kbps AAC.

## Speech

There is none yet. When there is, it will be synthesised rather than recorded,
and will inherit CC-BY-SA 4.0 from its voice's training data — see
[ADR 0002](adr/0002-announcements-are-baked-synthetic-speech.md), which also
explains why real station announcements are not an option.
