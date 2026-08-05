/**
 * Procedural sound effects, plus the bus the streamed music rides on.
 *
 * Every effect is a short oscillator or noise burst built on demand, so the
 * whole effects layer costs no download at all. No effect is a persistent
 * voice — each is a transient fired by an event and scheduled to stop. The
 * AudioContext itself is created lazily on the first user gesture, because
 * browsers suspend one constructed before then.
 *
 * Music is the one thing here that is not synthesised — see `music.ts`. It is
 * routed through this module's master gain rather than played independently,
 * so the M key mutes it for free and effects can duck it.
 */

import { createMusic, type Music, type MusicTrack } from './music'

export type { MusicTrack }

const MASTER_GAIN = 0.5

export interface Audio {
  readonly muted: boolean
  /** Must be called from a user gesture (the hangar Launch click). */
  resume(): void
  toggleMute(): boolean
  /** Crossfade the background track, or pass null to fade to silence. */
  setMusic(track: MusicTrack | null): void
  laser(accent: 'player' | 'enemy'): void
  hit(): void
  hullHit(): void
  explosion(big: boolean): void
  warp(): void
  dash(): void
  overheat(): void
  alarm(): void
  uiSelect(): void
  uiLaunch(): void
  fanfare(win: boolean): void
  dispose(): void
}

export function createAudio(): Audio {
  let ctx: AudioContext | null = null
  let master: GainNode | null = null
  let noiseBuffer: AudioBuffer | null = null
  let music: Music | null = null
  let muted = false
  /** Held until the AudioContext exists, which needs a user gesture. */
  let wantedTrack: MusicTrack | null = null

  function ensure(): AudioContext | null {
    if (ctx) return ctx
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return null

    ctx = new Ctor()
    master = ctx.createGain()
    master.gain.value = muted ? 0 : MASTER_GAIN
    master.connect(ctx.destination)

    // One second of white noise, reused by every impact and explosion.
    noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate)
    const data = noiseBuffer.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1

    music = createMusic(ctx, master)
    if (wantedTrack) music.play(wantedTrack)

    return ctx
  }

  function noise(duration: number, gain: number, filterType: BiquadFilterType, from: number, to: number) {
    const c = ensure()
    if (!c || !master || !noiseBuffer) return
    const src = c.createBufferSource()
    src.buffer = noiseBuffer
    src.loop = true

    const flt = c.createBiquadFilter()
    flt.type = filterType
    flt.frequency.setValueAtTime(from, c.currentTime)
    flt.frequency.exponentialRampToValueAtTime(Math.max(40, to), c.currentTime + duration)
    flt.Q.value = 1.2

    const g = c.createGain()
    g.gain.setValueAtTime(gain, c.currentTime)
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + duration)

    src.connect(flt)
    flt.connect(g)
    g.connect(master)
    src.start()
    src.stop(c.currentTime + duration + 0.02)
  }

  function tone(
    type: OscillatorType,
    from: number,
    to: number,
    duration: number,
    gain: number,
    delay = 0,
  ) {
    const c = ensure()
    if (!c || !master) return
    const t0 = c.currentTime + delay
    const osc = c.createOscillator()
    osc.type = type
    osc.frequency.setValueAtTime(from, t0)
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t0 + duration)

    const g = c.createGain()
    g.gain.setValueAtTime(0.0001, t0)
    g.gain.exponentialRampToValueAtTime(gain, t0 + Math.min(0.012, duration * 0.2))
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration)

    osc.connect(g)
    g.connect(master)
    osc.start(t0)
    osc.stop(t0 + duration + 0.02)
  }

  return {
    get muted() {
      return muted
    },

    resume() {
      const c = ensure()
      if (!c) return
      // The gesture that unlocks the context is also what releases any track
      // whose autoplay was refused before it.
      if (c.state === 'suspended') void c.resume().then(() => music?.flush())
      else music?.flush()
    },

    setMusic(track) {
      wantedTrack = track
      music?.play(track)
    },

    toggleMute() {
      muted = !muted
      if (master) master.gain.value = muted ? 0 : MASTER_GAIN
      return muted
    },

    laser(accent) {
      // Player lasers sit higher so your own fire is distinguishable in a swarm.
      const base = accent === 'player' ? 1500 : 900
      tone('square', base, base * 0.28, 0.11, 0.1)
      tone('sawtooth', base * 1.6, base * 0.5, 0.07, 0.045)
    },

    hit() {
      noise(0.07, 0.16, 'bandpass', 2600, 900)
    },

    hullHit() {
      noise(0.2, 0.3, 'lowpass', 1400, 160)
      tone('triangle', 190, 70, 0.22, 0.16)
    },

    explosion(big) {
      const d = big ? 1.15 : 0.6
      noise(d, big ? 0.5 : 0.32, 'lowpass', big ? 2200 : 1500, 90)
      tone('sine', big ? 110 : 150, 26, d * 0.9, big ? 0.34 : 0.2)
      tone('sawtooth', big ? 300 : 420, 60, d * 0.4, 0.09)
      // Only the big ones duck the music. Ducking on every kill in a busy
      // fight would leave the track permanently pumping.
      if (big) music?.duck()
    },

    warp() {
      tone('sine', 120, 1400, 0.5, 0.11)
      tone('triangle', 240, 2100, 0.42, 0.06, 0.04)
    },

    dash() {
      tone('sine', 300, 1500, 0.24, 0.12)
      noise(0.28, 0.12, 'highpass', 900, 4200)
    },

    overheat() {
      tone('square', 620, 180, 0.3, 0.13)
      tone('square', 460, 130, 0.34, 0.09, 0.08)
    },

    alarm() {
      tone('square', 880, 880, 0.09, 0.075)
      tone('square', 660, 660, 0.09, 0.075, 0.13)
    },

    uiSelect() {
      tone('triangle', 720, 1080, 0.07, 0.07)
    },

    uiLaunch() {
      tone('sawtooth', 180, 720, 0.4, 0.11)
      tone('sine', 90, 360, 0.55, 0.12, 0.05)
    },

    fanfare(win) {
      const notes = win ? [523, 659, 784, 1047] : [440, 392, 330, 247]
      notes.forEach((f, i) => tone('triangle', f, f, 0.34, 0.12, i * 0.16))
      if (!win) tone('sine', 110, 40, 1.3, 0.16, 0.1)
    },

    dispose() {
      music?.dispose()
      music = null
      void ctx?.close()
      ctx = null
    },
  }
}
