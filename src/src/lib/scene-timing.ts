/** Reference reels hold each image for its spoken phrase plus a short breath, never shorter than 2.2s. */
export function sceneDurationForVoice(voiceSeconds: number): number {
  return Math.round(Math.max(2.2, voiceSeconds + 0.6) * 100) / 100;
}
