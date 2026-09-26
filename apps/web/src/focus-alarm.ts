/**
 * Break-end tone (ADR 0029). Played only when the owner enabled the
 * preference; a short synthesized tone, so no audio asset or autoplay is
 * involved. Browsers may still require a prior user gesture; a rejected
 * playback is ignored.
 */
export const playBreakEndAlarm = (): void => {
  if (typeof window === "undefined" || !("AudioContext" in window)) return;
  try {
    const context = new AudioContext();
    const gain = context.createGain();
    gain.gain.value = 0.15;
    gain.connect(context.destination);
    const start = context.currentTime;
    for (const [index, frequency] of [660, 880, 660].entries()) {
      const oscillator = context.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      oscillator.connect(gain);
      oscillator.start(start + index * 0.25);
      oscillator.stop(start + index * 0.25 + 0.2);
    }
    window.setTimeout(() => void context.close(), 1_200);
  } catch {
    // Audio is optional; a blocked or missing context is not an error.
  }
};
