/**
 * Little sounds for motivation (his wish, 30/10: "zoals Duolingo en Quizlet"):
 * a bright two-note chime for a right answer, a soft low note for a wrong one,
 * a light tick for a known card, a rising arpeggio when a list or quiz is done
 * and a short fanfare for a great score.
 *
 * Made on the spot with the Web Audio API, so there are no sound files to
 * download. iOS only lets a page make sound after a tap, and every sound here
 * follows one; the phone's silent switch mutes them as well. Profiel →
 * Geluiden turns them off on this device.
 */

const STORAGE = 'studyflow.sound';

let context: AudioContext | null = null;

export function soundOn(): boolean {
  try {
    return localStorage.getItem(STORAGE) !== 'uit';
  } catch {
    return true;
  }
}

export function setSound(on: boolean): void {
  try {
    localStorage.setItem(STORAGE, on ? 'aan' : 'uit');
  } catch {
    // Blocked storage: the switch simply does not stick.
  }
}

function audio(): AudioContext | null {
  if (!soundOn() || typeof window === 'undefined') return null;
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    context ??= new Ctor();
    if (context.state === 'suspended') void context.resume();
    return context;
  } catch {
    return null;
  }
}

interface Note {
  freq: number;
  /** Seconds after the start. */
  at: number;
  /** Seconds. */
  dur: number;
  type?: OscillatorType;
  /** 0..1 within the sound. */
  gain?: number;
}

function play(notes: readonly Note[], volume = 0.22): void {
  const ac = audio();
  if (!ac) return;
  try {
    const t0 = ac.currentTime + 0.01;
    const master = ac.createGain();
    master.gain.value = volume;
    master.connect(ac.destination);
    for (const n of notes) {
      const osc = ac.createOscillator();
      const env = ac.createGain();
      const start = t0 + n.at;
      const end = start + n.dur;
      osc.type = n.type ?? 'sine';
      osc.frequency.setValueAtTime(n.freq, start);
      env.gain.setValueAtTime(0.0001, start);
      env.gain.exponentialRampToValueAtTime(n.gain ?? 0.9, start + 0.012);
      env.gain.exponentialRampToValueAtTime(0.0001, end);
      osc.connect(env);
      env.connect(master);
      osc.start(start);
      osc.stop(end + 0.03);
    }
  } catch {
    // A sound is never worth an error.
  }
}

const C5 = 523.25;
const E5 = 659.25;
const G5 = 783.99;
const C6 = 1046.5;
const E6 = 1318.51;
const G6 = 1567.98;

export const sounds = {
  /** A right answer in a quiz: two bright rising notes. */
  right: () =>
    play([
      { freq: G5 * 1.125, at: 0, dur: 0.12, type: 'triangle' },
      { freq: E6, at: 0.09, dur: 0.24, type: 'triangle' },
    ]),
  /** A wrong answer: two soft low notes, never harsh. */
  wrong: () =>
    play(
      [
        { freq: 220, at: 0, dur: 0.16, gain: 0.7 },
        { freq: 174.61, at: 0.11, dur: 0.26, gain: 0.6 },
      ],
      0.2,
    ),
  /** A card known in a review list: one light tick. */
  tick: () => play([{ freq: C6, at: 0, dur: 0.1, type: 'triangle', gain: 0.6 }], 0.16),
  /** A list or a quiz done: a rising arpeggio. */
  done: () => play([C5, E5, G5, C6].map((freq, i) => ({ freq, at: i * 0.09, dur: 0.24, type: 'triangle' as OscillatorType }))),
  /** A great score, or every mistake fixed: the arpeggio and a held chord. */
  fanfare: () =>
    play([
      ...[C5, E5, G5].map((freq, i) => ({ freq, at: i * 0.08, dur: 0.2, type: 'triangle' as OscillatorType })),
      ...[C6, E6, G6].map((freq) => ({ freq, at: 0.26, dur: 0.6, type: 'triangle' as OscillatorType, gain: 0.55 })),
    ]),
};
