# Music

Tracks live here rather than in `src/`. Vite serves `public/` at the site root
and copies it verbatim into `dist/`, so nothing here is bundled into the JS —
these stream on demand instead of inflating the app bundle.

`public/audio/combat.mp3` is served as `/audio/combat.mp3`.

## Tracks

| File | Plays on | Length | Size |
|------|----------|--------|------|
| `hangar.mp3` | Ship select | 2:29 | 3.7 MB |
| `combat.mp3` | The dogfight | 2:18 | 3.3 MB |
| `victory.mp3` | Debrief, run won | 1:17 | 1.8 MB |
| `defeat.mp3` | Debrief, run lost | 1:19 | 1.9 MB |

All four are 64 kbps, 48 kHz stereo MP3, and all four loop. Victory and defeat
are full-length tracks rather than short stings, so they loop on the debrief
screen like any other — in practice you hear the first twenty seconds.

Nothing is fetched at boot. A track downloads the first time the screen that
uses it is reached, so a player who never launches never downloads `combat.mp3`.

## Adding or replacing a track

Keep MP3: Safari's OGG support is unreliable and one universal format is worth
more than a few hundred kilobytes. Loops want no lead-in silence, no tail fade,
and a trim to an exact bar — a fraction of a second of dead air at the loop
point is very audible on a track you hear for a whole run.

Mix around -14 LUFS. The procedural effects in `src/core/audio.ts` sit at a
fixed master gain and music is deliberately mixed under them at `MUSIC_GAIN`
in `src/core/music.ts`; a track mastered hot will bury the lasers, and turning
it down in code only trades that for a track that vanishes under the engine.

## Licensing

AI-generated, released under the WTFPL — see `LICENSE.txt` in this folder.

| File | Author | License |
|------|--------|---------|
| `hangar.mp3` | AI-generated | WTFPL v2 |
| `combat.mp3` | AI-generated | WTFPL v2 |
| `victory.mp3` | AI-generated | WTFPL v2 |
| `defeat.mp3` | AI-generated | WTFPL v2 |
