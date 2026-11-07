import { getMusicTrack, type Project, type ExportAudioMode, type FFprobeReport, type SceneImageVersion } from "@/lib/projects";
import type { StructuredScriptOutput } from "@/lib/studio.functions";

const DEFAULT_BASE_URL = "http://127.0.0.1:5005";
const BASE_URL_KEY = "cinematic-studio.local-tts-url";

export type LocalTtsStatus = {
  ok: boolean;
  status: string;
  message: string;
  connected?: boolean;
  voices?: number;
  [key: string]: unknown;
};

export type LocalVoice = {
  id: string;
  name?: string;
  gender?: string;
  engine?: "gemini" | "piper" | string;
  hasReferenceAudio?: boolean;
  description?: string;
  language: string;
  languageName?: string;
  [key: string]: unknown;
};

export type PlatformStatus = {
  gemini: { status: string; connected: boolean; model: string; message: string };
  flow: { status: string; flowUrl?: string; [key: string]: unknown };
  piper: LocalTtsStatus;
  ffmpeg: { available: boolean; [key: string]: unknown };
};

export type FlowQueueJob = Record<string, unknown> & {
  id?: string;
  job_id?: string;
  scene_id: string;
  status?: string;
  error_message?: string;
  result?: SceneImageVersion & { data_url: string };
};

function baseUrl(custom?: string): string {
  return (custom ?? getLocalTtsBaseUrl()).replace(/\/+$/, "");
}

export function getLocalTtsBaseUrl(): string {
  if (typeof window === "undefined") return DEFAULT_BASE_URL;
  return localStorage.getItem(BASE_URL_KEY) || DEFAULT_BASE_URL;
}

export function setLocalTtsBaseUrl(url: string): void {
  const normalized = url.trim().replace(/\/+$/, "");
  if (typeof window !== "undefined") localStorage.setItem(BASE_URL_KEY, normalized || DEFAULT_BASE_URL);
}

async function request<T>(path: string, init?: RequestInit, customUrl?: string): Promise<T> {
  const response = await fetch(`${baseUrl(customUrl)}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await response.json().catch(() => ({}))) as T & { detail?: string; error?: string };
  if (!response.ok) throw new Error(body.error || body.detail || `Local service request failed (${response.status}).`);
  return body;
}

export async function fetchPlatformStatus(customUrl?: string): Promise<PlatformStatus> {
  return request<PlatformStatus>("/api/status", undefined, customUrl);
}

export async function updatePlatformSettings(
  settings: Record<string, unknown>,
  customUrl?: string,
): Promise<PlatformStatus> {
  return request<PlatformStatus>("/api/settings", { method: "POST", body: JSON.stringify(settings) }, customUrl);
}

export async function checkLocalTtsStatus(customUrl?: string): Promise<LocalTtsStatus> {
  try {
    return await request<LocalTtsStatus>("/local-tts/status", undefined, customUrl);
  } catch (error) {
    return {
      ok: false,
      status: "unreachable",
      message: error instanceof Error ? error.message : "Local TTS service is unreachable.",
    };
  }
}

export async function fetchLocalTtsVoices(customUrl?: string): Promise<{ voices: LocalVoice[] }> {
  return request<{ voices: LocalVoice[] }>("/local-tts/voices", undefined, customUrl);
}

export async function synthesizeLocalSpeech(input: {
  text: string;
  voice: string;
  speed?: number;
  sentenceSilence?: number;
  referenceAudioDataUrl?: string;
}): Promise<
  { ok: true; wavDataUrl: string; duration: number } | { ok: false; wavDataUrl: string; duration: number; error: string }
> {
  try {
    const response = await fetch(`${baseUrl()}/local-tts/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      const raw = await response.text();
      let msg = raw;
      try {
        const j = JSON.parse(raw) as { detail?: unknown; error?: string };
        msg = typeof j.detail === "string" ? j.detail : j.error ?? raw;
      } catch {
        /* plain text */
      }
      throw new Error(msg || `TTS request failed (${response.status}).`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const dataUrl = `data:audio/wav;base64,${bytesToBase64(bytes)}`;
    return { ok: true, wavDataUrl: dataUrl, duration: await wavDuration(dataUrl) };
  } catch (error) {
    return { ok: false, wavDataUrl: "", duration: 0, error: error instanceof Error ? error.message : "TTS request failed." };
  }
}

export async function generateScriptViaLocalService(input: Record<string, unknown>): Promise<
  | { ok: true; script: StructuredScriptOutput }
  | { ok: false; code: string; error: string }
> {
  try {
    return await request<{ ok: true; script: StructuredScriptOutput } | { ok: false; code: string; error: string }>(
      "/api/gemini/script",
      { method: "POST", body: JSON.stringify(input) },
    );
  } catch (error) {
    return { ok: false, code: "BACKEND_UNREACHABLE", error: error instanceof Error ? error.message : "Local service is unreachable." };
  }
}

export function buildCombinedNarrationWav(
  scenes: Array<{ voice?: string; voiceDuration?: number }>,
): { wavDataUrl: string; duration: number } | undefined {
  const voiced = scenes.map((scene) => scene.voice).filter((voice): voice is string => Boolean(voice));
  if (!voiced.length) return undefined;
  const chunks = voiced.map((dataUrl) => decodeWav(dataUrl));
  const first = chunks[0];
  if (!first) return undefined;
  const pcm = concatBytes(chunks.map((chunk) => chunk.pcm));
  const wav = createWav(pcm, first.sampleRate, first.channels, first.bitsPerSample);
  const duration = scenes.reduce((total, scene) => total + (scene.voiceDuration ?? 0), 0);
  return { wavDataUrl: `data:audio/wav;base64,${bytesToBase64(wav)}`, duration };
}

export async function connectFlowBrowser(headless = false) {
  return request<{ ok: boolean; error?: string; browser: Record<string, unknown> & { status?: string; message?: string } }>("/api/flow/connect", {
    method: "POST",
    body: JSON.stringify({ headless }),
  });
}

export async function verifyFlowSignin() {
  return request<{ ok: boolean; error?: string; browser: Record<string, unknown> & { status?: string; message?: string } }>("/api/flow/verify-signin", { method: "POST" });
}

export async function checkFlowAccount() {
  return request<{ ok: boolean; account: Record<string, unknown> }>("/api/flow/account-check", { method: "POST" });
}

export async function discoverFlowUi(page = "main") {
  return request<{ ok: boolean; status?: string; elements?: Record<string, unknown>; error?: string }>("/api/flow/discover-ui", {
    method: "POST",
    body: JSON.stringify({ page }),
  });
}

export async function fetchReferenceVoice() {
  try {
    return await request<{ ok: boolean; exists: boolean; name?: string; audioDataUrl?: string }>("/api/gemini/reference-voice");
  } catch {
    return { ok: false, exists: false };
  }
}

export async function uploadReferenceVoiceToBackend(audioDataUrl: string, name = "Custom Cloned Voice") {
  return request<{ ok: boolean; name: string; sizeBytes: number; voiceId: string }>("/api/gemini/upload-reference-voice", {
    method: "POST",
    body: JSON.stringify({ audio_data_url: audioDataUrl, name }),
  });
}

export async function fetchFlowQueueStatus(projectId?: string) {
  return request<{ ok: boolean; jobs: FlowQueueJob[] }>(`/api/flow/status${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ""}`);
}

export async function enqueueFlowSceneJob(input: Record<string, unknown>) {
  return request<{ ok: boolean; job: FlowQueueJob; error?: string }>("/api/flow/enqueue", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function uploadManualSceneImageToBackend(input: Record<string, unknown>) {
  const res = await request<{ ok: boolean; error?: string; record?: SceneImageVersion; version?: SceneImageVersion }>(
    "/api/flow/upload-manual",
    { method: "POST", body: JSON.stringify(input) },
  );
  const version = res.version ?? res.record;
  return version
    ? { ok: true as const, version }
    : { ok: false as const, error: res.error ?? "Upload failed." };
}

export async function renderProjectWithFFmpegService(project: Project, mode: ExportAudioMode) {
  try {
    const res = await request<{ ok: boolean; fileName?: string; validation?: FFprobeReport; videoBase64?: string; error?: string }>(
      "/api/ffmpeg/render",
      { method: "POST", body: JSON.stringify(await buildFFmpegRequest(project, mode)) },
    );
    if (!res.ok || !res.videoBase64 || !res.validation) {
      return { ok: false as const, error: res.error ?? "FFmpeg render failed." };
    }
    const bytes = Uint8Array.from(atob(res.videoBase64), (c) => c.charCodeAt(0));
    return {
      ok: true as const,
      blob: new Blob([bytes], { type: "video/mp4" }),
      fileName: res.fileName ?? "video.mp4",
      validation: res.validation,
    };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : "FFmpeg render failed." };
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeWav(dataUrl: string): { pcm: Uint8Array; sampleRate: number; channels: number; bitsPerSample: number } {
  const raw = atob(dataUrl.split(",", 2)[1] ?? "");
  const bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);
  const dataOffset = findChunk(bytes, "data");
  const dataSize = view.getUint32(dataOffset + 4, true);
  return { pcm: bytes.slice(dataOffset + 8, dataOffset + 8 + dataSize), sampleRate, channels, bitsPerSample };
}

function findChunk(bytes: Uint8Array, name: string): number {
  for (let offset = 12; offset + 8 <= bytes.length; ) {
    const chunkName = String.fromCharCode(...bytes.slice(offset, offset + 4));
    const size = new DataView(bytes.buffer).getUint32(offset + 4, true);
    if (chunkName === name) return offset;
    offset += 8 + size + (size % 2);
  }
  throw new Error("Invalid WAV data: missing data chunk.");
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function createWav(pcm: Uint8Array, sampleRate: number, channels: number, bitsPerSample: number): Uint8Array {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const write = (offset: number, value: string) => value.split("").forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  const blockAlign = channels * (bitsPerSample / 8);
  write(0, "RIFF");
  view.setUint32(4, 36 + pcm.length, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  write(36, "data");
  view.setUint32(40, pcm.length, true);
  return concatBytes([new Uint8Array(header), pcm]);
}

async function wavDuration(dataUrl: string): Promise<number> {
  const audio = new Audio(dataUrl);
  await new Promise<void>((resolve) => {
    audio.addEventListener("loadedmetadata", () => resolve(), { once: true });
    audio.addEventListener("error", () => resolve(), { once: true });
  });
  return Number.isFinite(audio.duration) ? audio.duration : 0;
}

async function buildFFmpegRequest(p: Project, mode: ExportAudioMode) {
  let music: string | undefined = p.music;
  let musicFormat = "mp3";
  if (p.musicEnabled !== false && p.selectedMusicId) {
    const track = await getMusicTrack(p.selectedMusicId);
    if (track) {
      music = (track as { dataUrl?: string }).dataUrl ?? music;
      musicFormat = track.format.toLowerCase();
    }
  }
  return {
    project_id: p.id,
    title: p.title || "Motivational_Video",
    aspect_ratio: p.aspectRatio ?? "9:16",
    watermark: p.watermark ?? "",
    scenes: p.scenes.map((s, i) => ({
      id: s.id,
      scene_number: s.sceneNumber ?? i + 1,
      caption: s.caption,
      narration: s.narration ?? "",
      visual: s.visual,
      duration: Math.min(30, Math.max(1, s.duration)),
      camera_movement: s.cameraMovement ?? "slow zoom in",
      transition: s.transition ?? "cut",
      image_data_url: s.image ?? null,
      voice_data_url: p.voiceEnabled === false ? null : (s.voice ?? null),
      voice_duration: s.voiceDuration ?? null,
    })),
    music_data_url: p.musicEnabled === false ? null : (music ?? null),
    music_format: musicFormat,
    voice_volume: p.voiceVolume ?? 100,
    music_volume: p.musicVolume ?? 18,
    music_fade_in: p.musicFadeIn ?? 1.5,
    music_fade_out: p.musicFadeOut ?? 2,
    music_start_offset: p.musicStartOffset ?? 0,
    short_track_behavior: p.shortTrackBehavior ?? "loop",
    ducking_enabled: p.duckingEnabled ?? true,
    ducking_level: Math.min(20, Math.max(5, p.duckingLevel ?? 10)),
    export_audio_mode: mode,
  };
}
