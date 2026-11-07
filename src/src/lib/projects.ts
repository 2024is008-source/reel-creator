import { get, set, del, keys, getMany } from "idb-keyval";

export type VisualBible = {
  character_appearance: string;
  clothing: string;
  hair: string;
  age_range: string;
  body_proportions: string;
  environment: string;
  color_palette: string;
  lighting: string;
  art_style: string;
};

export type SceneImageVersion = {
  version_id: string;
  prompt: string;
  source: string;
  data_url: string;
  created_at: number;
};

export type SceneImageStatus =
  | "idle"
  | "queued"
  | "generating"
  | "waiting_for_signin"
  | "ready"
  | "failed";

export type Scene = {
  id: string;
  sceneNumber?: number | undefined;
  startTime?: number | undefined;
  endTime?: number | undefined;
  caption: string;
  narration?: string | undefined;
  visual: string;
  imagePrompt?: string | undefined;
  cameraMovement?: string | undefined;
  transition?: string | undefined;
  image?: string | undefined;
  imageStatus?: SceneImageStatus | undefined;
  imageError?: string | undefined;
  imageVersions?: SceneImageVersion[] | undefined;
  voice?: string | undefined;
  voiceDuration?: number | undefined;
  duration: number;
};

export type ShortTrackBehavior = "loop" | "change" | "none";
export type ExportAudioMode = "both" | "voice" | "music" | "none";
export type VideoAspectRatio = "9:16" | "16:9";
export type VoiceEngineType = "gemini" | "piper";

export type MusicTrack = {
  id: string;
  name: string;
  mimeType: string;
  format: "MP3" | "WAV" | "M4A";
  sizeBytes: number;
  duration: number;
  dataUrl: string;
  createdAt: number;
};

export type AudioPreferences = {
  selectedVoiceId?: string | undefined;
  voiceEngine?: VoiceEngineType | undefined;
  aspectRatio?: VideoAspectRatio | undefined;
  voiceLanguage?: string | undefined;
  voiceGender?: "all" | "male" | "female" | undefined;
  voiceSpeed?: number | undefined;
  voiceVolume?: number | undefined;
  selectedMusicId?: string | undefined;
  musicVolume?: number | undefined;
  musicFadeIn?: number | undefined;
  musicFadeOut?: number | undefined;
  duckingEnabled?: boolean | undefined;
  duckingLevel?: number | undefined;
  shortTrackBehavior?: ShortTrackBehavior | undefined;
  geminiModel?: string | undefined;
};

export type FFprobeReport = {
  valid: boolean;
  container_format: string;
  video_codec: string;
  pixel_format: string;
  width: number;
  height: number;
  aspect_ratio: string;
  fps: number;
  audio_codec: string | null;
  audio_channels: number | null;
  duration_seconds: number;
  expected_duration_seconds: number;
  faststart_verified: boolean;
  file_size_bytes: number;
  errors: string[];
};

export type Project = {
  id: string;
  title: string;
  topic: string;
  aspectRatio?: VideoAspectRatio | undefined;
  theme?: string | undefined;
  message?: string | undefined;
  story?: string | undefined;
  audience?: string | undefined;
  language?: string | undefined;
  category: string;
  visualStyle?: string | undefined;
  narrationScript?: string | undefined;
  visualBible?: VisualBible | undefined;
  createdAt: number;
  updatedAt: number;
  scenes: Scene[];
  // Legacy/direct music data URL (optional fallback)
  music?: string | undefined;
  musicMood?: string | undefined;
  voiceName?: string | undefined;
  // Gemini TTS Clone & Local Piper TTS Voiceover Settings
  voiceEngine?: VoiceEngineType | undefined;
  voiceId?: string | undefined;
  referenceVoiceDataUrl?: string | undefined;
  referenceVoiceName?: string | undefined;
  voiceLanguage?: string | undefined;
  voiceGender?: "all" | "male" | "female" | undefined;
  voiceSpeed?: number | undefined;
  voiceVolume?: number | undefined;
  voiceEnabled?: boolean | undefined;
  narrationWav?: string | undefined;
  narrationDuration?: number | undefined;
  // User-Uploaded Background Music Settings
  selectedMusicId?: string | undefined;
  musicEnabled?: boolean | undefined;
  musicVolume?: number | undefined;
  musicFadeIn?: number | undefined;
  musicFadeOut?: number | undefined;
  musicStartOffset?: number | undefined;
  shortTrackBehavior?: ShortTrackBehavior | undefined;
  // Audio Mixer & Ducking Settings
  duckingEnabled?: boolean | undefined;
  duckingLevel?: number | undefined;
  exportAudioMode?: ExportAudioMode | undefined;
  /** Small @handle drawn under the caption, like the reference reels. */
  watermark?: string | undefined;
  lastExportReport?: FFprobeReport | undefined;
};

const PROJECT_PREFIX = "project:";
const MUSIC_PREFIX = "music-track:";
const AUDIO_PREFS_KEY = "studio:audio-preferences";

export const DEFAULT_VOICE_VOLUME = 100;
export const DEFAULT_MUSIC_VOLUME = 18;
export const DEFAULT_DUCKING_LEVEL = 10; // 10% (within 8-12% range)
export const DEFAULT_FADE_IN = 1.5;
export const DEFAULT_FADE_OUT = 2.0;
export const MAX_MUSIC_FILE_BYTES = 50 * 1024 * 1024; // 50 MB limit

export const uid = () => Math.random().toString(36).slice(2, 10);

export async function listProjects(): Promise<Project[]> {
  const ks = (await keys()).filter((k) => String(k).startsWith(PROJECT_PREFIX));
  const all = (await getMany(ks)) as Project[];
  return all.filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt);
}

export const getProject = (id: string) => get<Project>(PROJECT_PREFIX + id);
export const saveProject = (p: Project) => set(PROJECT_PREFIX + p.id, { ...p, updatedAt: Date.now() });
export const deleteProject = (id: string) => del(PROJECT_PREFIX + id);
export const totalDuration = (p: Project) =>
  Math.round(p.scenes.reduce((s, x) => s + x.duration, 0) * 10) / 10;

// ---------- Background Music Library (IndexedDB) ----------

export async function listMusicTracks(): Promise<MusicTrack[]> {
  const ks = (await keys()).filter((k) => String(k).startsWith(MUSIC_PREFIX));
  if (ks.length === 0) return [];
  const all = (await getMany(ks)) as MusicTrack[];
  return all.filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
}

export const getMusicTrack = (id: string) => get<MusicTrack>(MUSIC_PREFIX + id);
export const saveMusicTrack = (track: MusicTrack) => set(MUSIC_PREFIX + track.id, track);
export const deleteMusicTrack = (id: string) => del(MUSIC_PREFIX + id);

export async function getAudioPreferences(): Promise<AudioPreferences> {
  const prefs = await get<AudioPreferences>(AUDIO_PREFS_KEY);
  if (prefs?.geminiModel === "gemini-2.5-flash") {
    const migrated = { ...prefs, geminiModel: "gemini-3.5-flash" };
    await set(AUDIO_PREFS_KEY, migrated);
    return migrated;
  }
  return (
    prefs ?? {
      selectedVoiceId: "gemini:clone_whayrs_male",
      voiceEngine: "gemini",
      aspectRatio: "9:16",
      voiceSpeed: 1.0,
      voiceVolume: DEFAULT_VOICE_VOLUME,
      musicVolume: DEFAULT_MUSIC_VOLUME,
      musicFadeIn: DEFAULT_FADE_IN,
      musicFadeOut: DEFAULT_FADE_OUT,
      duckingEnabled: true,
      duckingLevel: DEFAULT_DUCKING_LEVEL,
      shortTrackBehavior: "loop",
      geminiModel: "gemini-3.5-flash",
    }
  );
}

export async function saveAudioPreferences(patch: Partial<AudioPreferences>): Promise<AudioPreferences> {
  const current = await getAudioPreferences();
  const next: AudioPreferences = { ...current, ...patch };
  await set(AUDIO_PREFS_KEY, next);
  return next;
}

export function validateMusicFile(file: File): {
  ok: true;
  format: "MP3" | "WAV" | "M4A";
  mimeType: string;
} | {
  ok: false;
  error: string;
} {
  if (!file || file.size === 0) {
    return { ok: false, error: "The selected audio file is empty." };
  }
  if (file.size > MAX_MUSIC_FILE_BYTES) {
    return {
      ok: false,
      error: `File "${file.name}" is too large (${(file.size / (1024 * 1024)).toFixed(1)} MB). Maximum allowed size is 50 MB.`,
    };
  }
  const lower = file.name.toLowerCase();
  const mime = (file.type || "").toLowerCase();

  if (lower.endsWith(".mp3") || mime === "audio/mpeg" || mime === "audio/mp3") {
    return { ok: true, format: "MP3", mimeType: "audio/mpeg" };
  }
  if (
    lower.endsWith(".wav") ||
    mime === "audio/wav" ||
    mime === "audio/x-wav" ||
    mime === "audio/wave"
  ) {
    return { ok: true, format: "WAV", mimeType: "audio/wav" };
  }
  if (
    lower.endsWith(".m4a") ||
    mime === "audio/mp4" ||
    mime === "audio/x-m4a" ||
    mime === "audio/m4a" ||
    mime === "audio/aac"
  ) {
    return { ok: true, format: "M4A", mimeType: "audio/mp4" };
  }
  return {
    ok: false,
    error: `Unsupported file format for "${file.name}". Please upload an MP3 (.mp3), WAV (.wav), or M4A (.m4a) audio file.`,
  };
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const tenths = Math.floor((seconds % 1) * 10);
  if (mins === 0) {
    return tenths > 0 ? `0:${String(secs).padStart(2, "0")}.${tenths}s` : `0:${String(secs).padStart(2, "0")}s`;
  }
  return `${mins}:${String(secs).padStart(2, "0")}`;
}
