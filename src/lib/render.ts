import {
  DEFAULT_DUCKING_LEVEL,
  DEFAULT_FADE_IN,
  DEFAULT_FADE_OUT,
  DEFAULT_MUSIC_VOLUME,
  DEFAULT_VOICE_VOLUME,
  getMusicTrack,
  type ExportAudioMode,
  type Project,
  type Scene,
} from "./projects";

export const W = 1080;
export const H = 1920;

export function getVideoDimensions(aspectRatio?: "9:16" | "16:9"): { width: number; height: number } {
  return aspectRatio === "16:9" ? { width: 1920, height: 1080 } : { width: 1080, height: 1920 };
}
const FADE = 0.6;
export const VOICE_DELAY = 0.25;

export async function loadImages(scenes: Scene[]) {
  return Promise.all(
    scenes.map(
      (s) =>
        new Promise<HTMLImageElement | null>((res) => {
          if (!s.image) return res(null);
          const img = new Image();
          img.onload = () => res(img);
          img.onerror = () => res(null);
          img.src = s.image;
        }),
    ),
  );
}

function drawCover(ctx: CanvasRenderingContext2D, img: HTMLImageElement, zoom: number, pan: number, cw = W, ch = H) {
  const r = Math.max(cw / img.width, ch / img.height) * zoom;
  const w = img.width * r;
  const h = img.height * r;
  ctx.drawImage(img, (cw - w) / 2 + pan, (ch - h) / 2, w, h);
}

function splitCaptionIntoPhrases(caption: string): string[] {
  const clean = caption.trim().replace(/\s+/g, " ");
  if (!clean) return [];
  if (clean.includes("|")) {
    const parts = clean.split("|").map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) return parts.slice(0, 2);
  }
  const commaIdx = clean.indexOf(",");
  if (commaIdx > 0) {
    const left = clean.slice(0, commaIdx).trim();
    const right = clean.slice(commaIdx + 1).trim();
    if (left.split(" ").length >= 2 && right.split(" ").length >= 2) {
      return [left, right];
    }
  }
  const words = clean.split(" ");
  if (words.length >= 8) {
    const mid = Math.floor(words.length / 2);
    for (const offset of [0, -1, 1, -2, 2]) {
      const pos = mid + offset;
      const w = words[pos]?.toLowerCase() ?? "";
      if (pos >= 2 && pos <= words.length - 2 && ["when", "because", "and", "but", "that", "to", "is", "will", "into", "before"].includes(w)) {
        return [words.slice(0, pos).join(" "), words.slice(pos).join(" ")];
      }
    }
  }
  return [clean];
}

function wrap(ctx: CanvasRenderingContext2D, text: string, max: number) {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const t = line ? line + " " + w : w;
    if (ctx.measureText(t).width > max && line) {
      lines.push(line);
      line = w;
    } else line = t;
  }
  if (line) lines.push(line);
  return lines;
}

let grain: HTMLCanvasElement | null = null;
function grainTex() {
  if (grain) return grain;
  grain = document.createElement("canvas");
  grain.width = grain.height = 256;
  const g = grain.getContext("2d")!;
  const d = g.createImageData(256, 256);
  for (let i = 0; i < d.data.length; i += 4) {
    const v = Math.random() * 255;
    d.data[i] = d.data[i + 1] = d.data[i + 2] = v;
    d.data[i + 3] = 26;
  }
  g.putImageData(d, 0, 0);
  return grain;
}

// Deterministic pseudo-random so dust specks look the same in preview and export.
function rand(n: number) {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/** Old-print dust specks and the odd thin scratch, re-rolled ~8 times per second. */
function drawDust(ctx: CanvasRenderingContext2D, t: number) {
  const tick = Math.floor(t * 8);
  ctx.save();
  for (let i = 0; i < 7; i++) {
    const r = rand(tick * 31 + i);
    if (r < 0.45) continue;
    const x = rand(tick * 17 + i * 3) * W;
    const y = rand(tick * 13 + i * 7) * H;
    const size = 1.5 + rand(tick + i * 11) * 4;
    ctx.fillStyle = rand(i + tick * 5) > 0.5 ? "rgba(10,10,10,0.55)" : "rgba(240,235,225,0.35)";
    ctx.beginPath();
    ctx.ellipse(x, y, size, size * (0.5 + rand(i * 9 + tick)), rand(i + tick) * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  if (rand(tick * 7) > 0.82) {
    const x = rand(tick * 3) * W;
    ctx.strokeStyle = "rgba(230,225,215,0.12)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + (rand(tick) - 0.5) * 30, H);
    ctx.stroke();
  }
  ctx.restore();
}

export type FrameOptions = { watermark?: string | undefined };

/**
 * Reference-reel look: hard cuts between near-static illustrations (very gentle push-in),
 * matte film grain + dust specks, soft vignette, one small centred handwritten caption,
 * and a faint @handle watermark below it. Supports both 9:16 (1080x1920) and 16:9 (1920x1080).
 */
export function drawFrame(
  ctx: CanvasRenderingContext2D,
  scenes: Scene[],
  imgs: (HTMLImageElement | null)[],
  t: number,
  opts: FrameOptions = {},
) {
  const cw = ctx.canvas?.width || W;
  const ch = ctx.canvas?.height || H;
  const maxDim = Math.max(cw, ch);
  const total = scenes.reduce((s, x) => s + x.duration, 0);
  ctx.fillStyle = "#0b0d10";
  ctx.fillRect(0, 0, cw, ch);
  let start = 0;
  scenes.forEach((s, i) => {
    const end = start + s.duration;
    const isLast = i === scenes.length - 1;
    if (t >= start && (t < end || (isLast && t >= end))) {
      const p = Math.min(Math.max((t - start) / s.duration, 0), 1);
      const img = imgs[i] ?? null;
      if (img) drawCover(ctx, img, 1.0 + 0.035 * p, 0, cw, ch);
    }
    start = end;
  });

  // soft vignette
  const v = ctx.createRadialGradient(cw / 2, ch / 2, maxDim * 0.35, cw / 2, ch / 2, maxDim * 0.8);
  v.addColorStop(0, "rgba(0,0,0,0)");
  v.addColorStop(1, "rgba(0,0,0,0.3)");
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, cw, ch);

  // grain
  ctx.fillStyle = ctx.createPattern(grainTex(), "repeat")!;
  ctx.save();
  ctx.translate((Math.floor(t * 24) * 97) % 256, (Math.floor(t * 24) * 61) % 256);
  ctx.fillRect(-256, -256, cw + 512, ch + 512);
  ctx.restore();
  drawDust(ctx, t);

  // caption: small, white, centred, 2-part sequential phrase timing with quick fade in/out (exact @W.hayrs style)
  start = 0;
  for (const s of scenes) {
    const local = t - start;
    if (local >= 0 && local < s.duration && s.caption.trim()) {
      const phrases = splitCaptionIntoPhrases(s.caption);
      const nPhr = Math.max(1, phrases.length);
      const phrDur = s.duration / nPhr;
      const phrIdx = Math.min(nPhr - 1, Math.floor(local / Math.max(0.01, phrDur)));
      const phrLocal = local - phrIdx * phrDur;
      const activePhrase = phrases[phrIdx] ?? s.caption;

      const a = Math.min(1, phrLocal / 0.18, (phrDur - phrLocal) / 0.18);
      ctx.globalAlpha = Math.max(0, a);
      ctx.font = "400 46px Kalam, cursive";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#f7f5ef";
      ctx.shadowColor = "rgba(0,0,0,0.65)";
      ctx.shadowBlur = 10;
      ctx.shadowOffsetY = 2;
      const lines = wrap(ctx, activePhrase, cw * 0.74);
      lines.forEach((l, i) => ctx.fillText(l, cw / 2, ch * 0.5 + (i - (lines.length - 1) / 2) * 60));
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
      ctx.globalAlpha = 1;
    }
    start += s.duration;
  }

  // watermark (default @W.hayrs like the reference videos)
  const mark = (opts.watermark ?? "@W.hayrs").trim();
  if (mark) {
    ctx.globalAlpha = 0.85;
    ctx.font = "italic 400 30px Kalam, cursive";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#f2efe8";
    ctx.shadowColor = "rgba(0,0,0,0.5)";
    ctx.shadowBlur = 6;
    ctx.fillText(mark.startsWith("@") ? mark : `@${mark}`, cw / 2, ch * 0.815);
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
  }

  // ending fade
  if (t > total - 0.6) {
    ctx.fillStyle = `rgba(0,0,0,${Math.min(1, (t - (total - 0.6)) / 0.6)})`;
    ctx.fillRect(0, 0, cw, ch);
  }
}

// ---------- Audio Loading, Timing, Ducking & Mixing ----------

export type AudioBuffers = {
  music: AudioBuffer | null;
  voices: (AudioBuffer | null)[];
  musicTrackDuration: number;
};

export type SpeechInterval = {
  start: number;
  end: number;
};

async function decode(ctx: BaseAudioContext, url?: string) {
  if (!url) return null;
  try {
    const buf = await (await fetch(url)).arrayBuffer();
    return await ctx.decodeAudioData(buf);
  } catch {
    return null;
  }
}

export async function resolveProjectMusicDataUrl(p: Project): Promise<string | undefined> {
  if (p.selectedMusicId) {
    const track = await getMusicTrack(p.selectedMusicId);
    if (track?.dataUrl) return track.dataUrl;
  }
  return p.music;
}

export async function loadAudio(ctx: BaseAudioContext, p: Project): Promise<AudioBuffers> {
  const musicUrl = await resolveProjectMusicDataUrl(p);
  const [music, ...voices] = await Promise.all([
    decode(ctx, musicUrl),
    ...p.scenes.map((s) => decode(ctx, s.voice)),
  ]);
  return {
    music,
    voices,
    musicTrackDuration: music?.duration ?? 0,
  };
}

/**
 * Computes active speech intervals `[start, end]` across the project timeline
 * based on decoded WAV durations (or scene voiceDuration metadata).
 */
export function getSpeechIntervals(p: Project, voices?: (AudioBuffer | null)[]): SpeechInterval[] {
  const intervals: SpeechInterval[] = [];
  let sceneStart = 0;
  p.scenes.forEach((s, idx) => {
    const buf = voices?.[idx] ?? null;
    const dur = buf?.duration ?? s.voiceDuration ?? 0;
    if ((buf || s.voice) && dur > 0.05) {
      const start = sceneStart + VOICE_DELAY;
      const end = Math.min(sceneStart + s.duration, start + dur);
      if (end > start) {
        intervals.push({ start, end });
      }
    }
    sceneStart += s.duration;
  });
  return intervals;
}

/**
 * Calculates the instantaneous music volume (0.0 to 1.0) at timeline position `t`
 * combining:
 * 1. Selected normal music volume (default 18%)
 * 2. Smooth fade-in (`musicFadeIn`, default 1.5s) and fade-out (`musicFadeOut`, default 2.0s)
 * 3. Automatic music ducking (reduces music to ~8-12% when narration is playing,
 *    and gradually restores to normal volume when narration pauses).
 */
export function computeEffectiveMusicGainAtTime(
  t: number,
  totalDurationSec: number,
  p: Project,
  intervals: SpeechInterval[],
  includeVoice = true,
): number {
  if (t < 0 || t > totalDurationSec || totalDurationSec <= 0) return 0;
  const normalVol = Math.max(0, Math.min(1, (p.musicVolume ?? DEFAULT_MUSIC_VOLUME) / 100));
  if (normalVol === 0) return 0;

  // 1. Fade-in & Fade-out envelope
  const fadeIn = Math.max(0, Math.min(totalDurationSec * 0.45, p.musicFadeIn ?? DEFAULT_FADE_IN));
  const fadeOut = Math.max(0, Math.min(totalDurationSec * 0.45, p.musicFadeOut ?? DEFAULT_FADE_OUT));
  let fadeFactor = 1;
  if (fadeIn > 0.01 && t < fadeIn) {
    fadeFactor = Math.min(fadeFactor, Math.max(0, t / fadeIn));
  }
  if (fadeOut > 0.01 && t > totalDurationSec - fadeOut) {
    fadeFactor = Math.min(fadeFactor, Math.max(0, (totalDurationSec - t) / fadeOut));
  }

  // 2. Automatic ducking factor
  const duckEnabled = p.duckingEnabled !== false && includeVoice && intervals.length > 0;
  if (!duckEnabled) {
    return normalVol * fadeFactor;
  }

  const targetDuckVol = Math.max(0.08, Math.min(0.12, (p.duckingLevel ?? DEFAULT_DUCKING_LEVEL) / 100));
  const duckedVol = normalVol > targetDuckVol ? targetDuckVol : normalVol * 0.55;
  const duckRatio = normalVol > 0 ? duckedVol / normalVol : 1;

  const attack = 0.18;
  const release = 0.4;
  let duckFactor = 1;

  for (const iv of intervals) {
    if (t >= iv.start && t <= iv.end) {
      duckFactor = Math.min(duckFactor, duckRatio);
    } else if (t >= iv.start - attack && t < iv.start) {
      // Smooth ramp down into narration
      const prog = (t - (iv.start - attack)) / attack;
      const cur = 1 - prog * (1 - duckRatio);
      duckFactor = Math.min(duckFactor, cur);
    } else if (t > iv.end && t <= iv.end + release) {
      // Gradual ramp back up to normal volume when narration pauses
      const prog = (t - iv.end) / release;
      const cur = duckRatio + prog * (1 - duckRatio);
      duckFactor = Math.min(duckFactor, cur);
    }
  }

  return normalVol * fadeFactor * duckFactor;
}

export type PlayAudioOptions = {
  mode?: ExportAudioMode;
  masterVolume?: number; // 0..1 for preview mute/volume control
};

export type ActiveAudioPlayback = {
  stop: () => void;
  setMasterVolume: (vol: number) => void;
};

/**
 * Schedules background music (fitted to video duration with fade-in, fade-out,
 * short-track handling, and automatic ducking) + local voiceover WAVs starting
 * at timeline offset `from`. Routes through a soft limiter to prevent clipping.
 */
export function playAudioWithControls(
  ctx: AudioContext,
  dest: AudioNode,
  p: Project,
  b: AudioBuffers,
  from: number,
  options?: PlayAudioOptions,
): ActiveAudioPlayback {
  const mode: ExportAudioMode = options?.mode ?? p.exportAudioMode ?? "both";
  const now = ctx.currentTime + 0.04;
  const total = p.scenes.reduce((s, x) => s + x.duration, 0);
  const remaining = Math.max(0.01, total - from);
  const nodes: AudioBufferSourceNode[] = [];

  // Master gain (for preview mute/volume) -> soft limiter compressor -> dest
  const masterGain = ctx.createGain();
  masterGain.gain.setValueAtTime(Math.max(0, Math.min(1.5, options?.masterVolume ?? 1)), now);

  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.setValueAtTime(-2.5, now);
  limiter.knee.setValueAtTime(6, now);
  limiter.ratio.setValueAtTime(14, now);
  limiter.attack.setValueAtTime(0.002, now);
  limiter.release.setValueAtTime(0.12, now);

  masterGain.connect(limiter);
  limiter.connect(dest);

  const hasAnyVoice = b.voices.some(Boolean);
  const allowVoice =
    (mode === "both" || mode === "voice") && p.voiceEnabled !== false && hasAnyVoice;
  const shortBehavior = p.shortTrackBehavior ?? "loop";
  const isTrackShorter = Boolean(b.music && b.music.duration + 0.05 < total);
  const skipShortMusic = isTrackShorter && shortBehavior === "none";
  const allowMusic =
    (mode === "both" || mode === "music") &&
    p.musicEnabled !== false &&
    Boolean(b.music) &&
    !skipShortMusic;

  const speechIntervals = allowVoice ? getSpeechIntervals(p, b.voices) : [];

  // 1. Schedule Background Music with Fade-In, Fade-Out, and Automatic Ducking
  if (allowMusic && b.music) {
    const musicGain = ctx.createGain();
    // Sample the envelope at 25 Hz across `[from, total]` for smooth, collision-free Web Audio automation
    const steps = Math.max(2, Math.min(2000, Math.ceil(remaining * 25)));
    const curve = new Float32Array(steps);
    for (let i = 0; i < steps; i++) {
      const timelineT = from + (i / (steps - 1)) * remaining;
      curve[i] = computeEffectiveMusicGainAtTime(timelineT, total, p, speechIntervals, allowVoice);
    }
    try {
      musicGain.gain.setValueCurveAtTime(curve, now, remaining);
    } catch {
      musicGain.gain.setValueAtTime(curve[0] ?? 0.18, now);
    }
    musicGain.connect(masterGain);

    const src = ctx.createBufferSource();
    src.buffer = b.music;
    const shouldLoop = !isTrackShorter || shortBehavior === "loop";
    src.loop = Boolean(shouldLoop && b.music.duration < total + (p.musicStartOffset ?? 0));

    const baseOffset = Math.max(0, p.musicStartOffset ?? 0);
    const startOffset =
      b.music.duration > 0 ? (baseOffset + from) % b.music.duration : 0;

    src.connect(musicGain);
    if (!shouldLoop && from >= b.music.duration) {
      // Track already ended before seek point when not looping
    } else {
      const playDur = shouldLoop
        ? remaining
        : Math.max(0.01, Math.min(remaining, b.music.duration - from));
      src.start(now, startOffset);
      src.stop(now + playDur);
      nodes.push(src);
    }
  }

  // 2. Schedule Local Voiceover WAVs per scene
  if (allowVoice) {
    const voiceVol = Math.max(0, Math.min(1.5, (p.voiceVolume ?? DEFAULT_VOICE_VOLUME) / 100));
    let sceneStart = 0;
    p.scenes.forEach((s, i) => {
      const buf = b.voices[i] ?? null;
      const at = sceneStart + VOICE_DELAY;
      sceneStart += s.duration;
      if (!buf || at + buf.duration <= from || voiceVol <= 0) return;

      const vGain = ctx.createGain();
      vGain.gain.setValueAtTime(voiceVol, now);
      vGain.connect(masterGain);

      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(vGain);
      if (at >= from) {
        src.start(now + (at - from));
      } else {
        src.start(now, from - at);
      }
      nodes.push(src);
    });
  }

  return {
    stop: () => {
      nodes.forEach((n) => {
        try {
          n.stop();
        } catch {
          /* already stopped */
        }
      });
      try {
        masterGain.disconnect();
        limiter.disconnect();
      } catch {
        /* ignore */
      }
    },
    setMasterVolume: (vol: number) => {
      try {
        masterGain.gain.setTargetAtTime(Math.max(0, Math.min(1.5, vol)), ctx.currentTime, 0.02);
      } catch {
        /* ignore */
      }
    },
  };
}

/** Backwards-compatible wrapper returning a stop function. */
export function playAudio(
  ctx: AudioContext,
  dest: AudioNode,
  p: Project,
  b: AudioBuffers,
  from: number,
  options?: PlayAudioOptions,
): () => void {
  return playAudioWithControls(ctx, dest, p, b, from, options).stop;
}

export async function exportVideo(
  project: Project,
  onProgress: (p: number) => void,
  modeOverride?: ExportAudioMode,
): Promise<{ blob: Blob; ext: string; mimeType: string; audioMode: ExportAudioMode }> {
  const scenes = project.scenes;
  const mode: ExportAudioMode = modeOverride ?? project.exportAudioMode ?? "both";
  await document.fonts.load("500 58px Kalam");

  const actx = new AudioContext();
  const abufs = await loadAudio(actx, project);
  const adest = actx.createMediaStreamDestination();
  const imgs = await loadImages(scenes);

  const dims = getVideoDimensions(project.aspectRatio ?? "9:16");
  const canvas = document.createElement("canvas");
  canvas.width = dims.width;
  canvas.height = dims.height;
  const ctx = canvas.getContext("2d")!;
  const stream = canvas.captureStream(30);

  const hasVoice =
    (mode === "both" || mode === "voice") &&
    project.voiceEnabled !== false &&
    abufs.voices.some(Boolean);
  const hasMusic =
    (mode === "both" || mode === "music") &&
    project.musicEnabled !== false &&
    Boolean(abufs.music) &&
    !(abufs.music && abufs.music.duration + 0.05 < scenes.reduce((s, x) => s + x.duration, 0) && project.shortTrackBehavior === "none");
  const hasAudio = mode !== "none" && (hasVoice || hasMusic);

  if (hasAudio) {
    adest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
  }

  const types = hasAudio
    ? [
        "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
        "video/mp4;codecs=avc1,mp4a.40.2",
        "video/mp4",
        "video/webm;codecs=vp9,opus",
        "video/webm",
      ]
    : [
        "video/mp4;codecs=avc1.42E01E",
        "video/mp4;codecs=avc1",
        "video/mp4",
        "video/webm;codecs=vp9",
        "video/webm",
      ];
  const mime =
    (typeof MediaRecorder !== "undefined" &&
      types.find((m) => MediaRecorder.isTypeSupported(m))) ||
    "video/mp4";

  const rec = new MediaRecorder(stream, {
    mimeType: MediaRecorder.isTypeSupported(mime) ? mime : undefined,
    videoBitsPerSecond: 8_000_000,
    audioBitsPerSecond: hasAudio ? 192_000 : undefined,
  });

  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise<void>((r) => (rec.onstop = () => r()));

  const total = scenes.reduce((s, x) => s + x.duration, 0);
  drawFrame(ctx, scenes, imgs, 0, { watermark: project.watermark });
  await actx.resume();
  rec.start(250);

  const stopAudio = hasAudio ? playAudio(actx, adest, project, abufs, 0, { mode }) : () => {};
  const t0 = performance.now();
  await new Promise<void>((resolve) => {
    const tick = () => {
      const t = (performance.now() - t0) / 1000;
      drawFrame(ctx, scenes, imgs, Math.min(t, total), { watermark: project.watermark });
      onProgress(Math.min(1, t / total));
      if (t >= total) return resolve();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  rec.stop();
  await done;
  stopAudio();
  await actx.close();

  const actualMime = rec.mimeType || mime;
  const ext = actualMime.includes("mp4") ? "mp4" : "webm";
  return {
    blob: new Blob(chunks, { type: actualMime }),
    ext,
    mimeType: actualMime,
    audioMode: mode,
  };
}
