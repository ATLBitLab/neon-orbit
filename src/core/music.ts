/**
 * Streamed background music.
 *
 * Separate from the procedural effects in `audio.ts` because the constraints
 * are opposite: effects are a few hundred bytes of oscillator maths built on
 * demand, while these are multi-megabyte files that must never be decoded into
 * memory all at once. So each track is an `<audio>` element — the browser
 * streams it and throws the buffer away — routed through Web Audio purely for
 * gain, so crossfades and ducking are sample-accurate and the master mute
 * covers music without any extra bookkeeping.
 *
 * Files live in `public/audio/` and are fetched the first time a track is
 * asked for, not at boot. A player who never leaves the hangar never downloads
 * the combat track.
 */

export type MusicTrack = 'hangar' | 'combat' | 'victory' | 'defeat'

const SOURCES: Record<MusicTrack, string> = {
  hangar: '/audio/hangar.mp3',
  combat: '/audio/combat.mp3',
  victory: '/audio/victory.mp3',
  defeat: '/audio/defeat.mp3',
}

/**
 * Music sits well under the effects. The lasers and hull hits are the
 * information channel; the music is the mood, and it loses every conflict.
 */
const MUSIC_GAIN = 0.38
const CROSSFADE = 0.9
/** How far music drops when something loud happens, and for how long. */
const DUCK_TO = 0.35
const DUCK_RELEASE = 1.1

export interface Music {
  /** Crossfade to `track`, or fade everything out when passed null. */
  play(track: MusicTrack | null): void
  /** Momentarily pull the music down so an explosion reads through it. */
  duck(): void
  /** Starts whatever `play` asked for while the context was still suspended. */
  flush(): void
  dispose(): void
}

interface Voice {
  element: HTMLAudioElement
  gain: GainNode
}

export function createMusic(ctx: AudioContext, output: AudioNode): Music {
  const voices = new Map<MusicTrack, Voice>()
  let current: MusicTrack | null = null
  let pending: MusicTrack | null = null
  let disposed = false

  function voiceFor(track: MusicTrack): Voice | null {
    const existing = voices.get(track)
    if (existing) return existing

    const element = new Audio()
    element.src = SOURCES[track]
    element.loop = true
    element.preload = 'none'

    let source: MediaElementAudioSourceNode
    try {
      source = ctx.createMediaElementSource(element)
    } catch {
      // A browser that refuses the graph should lose its music, not its game.
      return null
    }

    const gain = ctx.createGain()
    gain.gain.value = 0
    source.connect(gain)
    gain.connect(output)

    const voice = { element, gain }
    voices.set(track, voice)
    return voice
  }

  function fade(voice: Voice, to: number, seconds: number): void {
    const now = ctx.currentTime
    // setValueAtTime pins the ramp's start to wherever the gain actually is,
    // so interrupting a crossfade mid-flight does not jump.
    voice.gain.gain.cancelScheduledValues(now)
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, now)
    voice.gain.gain.linearRampToValueAtTime(to, now + seconds)
  }

  function start(track: MusicTrack): void {
    const voice = voiceFor(track)
    if (!voice) return

    for (const [id, other] of voices) {
      if (id === track) continue
      fade(other, 0, CROSSFADE)
      // Pausing immediately would cut the outgoing track before its own fade
      // finished, which is audible as a click.
      window.setTimeout(() => {
        if (!disposed && current !== id) other.element.pause()
      }, CROSSFADE * 1000 + 60)
    }

    voice.element.play().catch(() => {
      // Autoplay refused. `flush` retries once there has been a gesture.
      pending = track
    })
    fade(voice, MUSIC_GAIN, CROSSFADE)
  }

  return {
    play(track) {
      if (disposed || track === current) return
      current = track

      if (track === null) {
        for (const voice of voices.values()) fade(voice, 0, CROSSFADE)
        return
      }

      // A suspended context means the player has not clicked anything yet.
      if (ctx.state !== 'running') {
        pending = track
        return
      }
      start(track)
    },

    duck() {
      if (disposed || !current) return
      const voice = voices.get(current)
      if (!voice) return

      // Both ramps have to be scheduled in one block. Calling `fade` twice
      // would cancel the dip on the second call and the duck would never be
      // heard — only the recovery ramp would run.
      const now = ctx.currentTime
      const g = voice.gain.gain
      g.cancelScheduledValues(now)
      g.setValueAtTime(g.value, now)
      g.linearRampToValueAtTime(MUSIC_GAIN * DUCK_TO, now + 0.08)
      g.linearRampToValueAtTime(MUSIC_GAIN, now + 0.08 + DUCK_RELEASE)
    },

    flush() {
      if (disposed || ctx.state !== 'running') return
      const track = pending ?? current
      pending = null
      if (track) start(track)
    },

    dispose() {
      disposed = true
      for (const voice of voices.values()) {
        voice.element.pause()
        voice.element.src = ''
        voice.gain.disconnect()
      }
      voices.clear()
      current = null
      pending = null
    },
  }
}
