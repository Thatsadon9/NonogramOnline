import type { CellValue } from "./nonogram";

const STORAGE_KEY = "nonogram-sfx";
let enabled = readEnabled();
let context: AudioContext | null = null;

function readEnabled() {
  try {
    return typeof localStorage === "undefined" ? true : localStorage.getItem(STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

export function sfxEnabled() {
  return enabled;
}

export function setSfxEnabled(value: boolean) {
  enabled = value;
  try {
    localStorage.setItem(STORAGE_KEY, value ? "1" : "0");
  } catch {
    // Preferences simply won't persist.
  }
}

function audioContext() {
  if (!enabled || typeof window === "undefined") return null;
  if (!context) {
    const ctor = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!ctor) return null;
    context = new ctor();
  }
  if (context.state === "suspended") void context.resume();
  return context;
}

function blip(frequency: number, start: number, duration: number, volume: number, type: OscillatorType = "triangle") {
  const audio = audioContext();
  if (!audio) return;
  const oscillator = audio.createOscillator();
  const gain = audio.createGain();
  const beginAt = audio.currentTime + start;
  oscillator.type = type;
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(volume, beginAt);
  gain.gain.exponentialRampToValueAtTime(0.0001, beginAt + duration);
  oscillator.connect(gain).connect(audio.destination);
  oscillator.start(beginAt);
  oscillator.stop(beginAt + duration);
}

export function playTick(value: CellValue) {
  blip(value === 2 ? 420 : 640, 0, 0.05, 0.025, "square");
}

export function playWin() {
  blip(523, 0, 0.12, 0.05);
  blip(659, 0.1, 0.12, 0.05);
  blip(784, 0.2, 0.22, 0.06);
}

export function vibrateTick() {
  if (!enabled) return;
  try {
    navigator.vibrate?.(8);
  } catch {
    // Vibration is unsupported on many devices.
  }
}
