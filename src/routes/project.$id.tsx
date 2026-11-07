import { sceneDurationForVoice } from "@/lib/scene-timing";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  CheckCircle2,
  Download,
  FileAudio,
  Film,
  Globe,
  HelpCircle,
  History,
  ImageIcon,
  Loader2,
  Mic,
  Music,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Settings,
  Sliders,
  Sparkles,
  Terminal,
  Trash2,
  Upload,
  Volume2,
  VolumeX,
  Wand2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import { generateSceneImage } from "@/lib/studio.functions";
import {
  DEFAULT_DUCKING_LEVEL,
  DEFAULT_FADE_IN,
  DEFAULT_FADE_OUT,
  DEFAULT_MUSIC_VOLUME,
  DEFAULT_VOICE_VOLUME,
  deleteMusicTrack,
  formatDuration,
  getAudioPreferences,
  getProject,
  listMusicTracks,
  saveAudioPreferences,
  saveMusicTrack,
  saveProject,
  totalDuration,
  uid,
  validateMusicFile,
  type ExportAudioMode,
  type MusicTrack,
  type Project,
  type ShortTrackBehavior,
  type VideoAspectRatio,
  type VisualBible,
} from "@/lib/projects";
import {
  buildCombinedNarrationWav,
  checkLocalTtsStatus,
  connectFlowBrowser,
  enqueueFlowSceneJob,
  fetchFlowQueueStatus,
  fetchLocalTtsVoices,
  fetchPlatformStatus,
  getLocalTtsBaseUrl,
  renderProjectWithFFmpegService,
  setLocalTtsBaseUrl,
  synthesizeLocalSpeech,
  updatePlatformSettings,
  uploadManualSceneImageToBackend,
  uploadReferenceVoiceToBackend,
  verifyFlowSignin,
  type FlowQueueJob,
  type LocalTtsStatus,
  type LocalVoice,
  type PlatformStatus,
} from "@/lib/local-tts";
import {
  computeEffectiveMusicGainAtTime,
  drawFrame,
  exportVideo,
  getSpeechIntervals,
  getVideoDimensions,
  H,
  loadAudio,
  loadImages,
  playAudioWithControls,
  W,
  type ActiveAudioPlayback,
  type AudioBuffers,
} from "@/lib/render";

export const Route = createFileRoute("/project/$id")({
  head: () => ({
    meta: [
      { title: "Scene & Audio Studio — Cinematic Studio" },
      {
        name: "description",
        content:
          "Edit Gemini script & Visual Bible, automate Google Flow / Nano Banana painted scenes, synthesize local Piper TTS voiceover, mix uploaded music, and export FFmpeg MP4.",
      },
      { property: "og:title", content: "Scene & Audio Studio — Cinematic Studio" },
      {
        property: "og:description",
        content:
          "Edit Gemini script & Visual Bible, automate Google Flow / Nano Banana painted scenes, synthesize local Piper TTS voiceover, mix uploaded music, and export FFmpeg MP4.",
      },
    ],
  }),
  component: Studio,
});

const DEFAULT_VISUAL_BIBLE: VisualBible = {
  character_appearance: "Solitary young adult figure with quiet determination, often seen from behind or three-quarter profile",
  clothing: "Dark slate hooded rain jacket over a muted charcoal sweater and weathered backpack",
  hair: "Short tousled dark hair slightly damp from mist and rain",
  age_range: "Young adult (early 20s)",
  body_proportions: "Grounded, realistic 2D anime proportions",
  environment: "Rainy city dusk transitioning to misty mountain trail and golden sunrise ridge",
  color_palette: "Deep muted slate blues, misty forest greens, and warm sunset/sunrise amber-orange highlights",
  lighting: "Soft atmospheric rim lighting, diffused mist glow, and cinematic golden-hour rays",
  art_style:
    "Painted 2D anime still frame (Makoto Shinkai / Studio Ghibli feel), flat cel-shaded brushwork, subtle film grain, vertical 9:16 composition, no photorealism, no 3D, no text or watermarks",
};

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error(`Failed to read file "${file.name}"`));
    reader.readAsDataURL(file);
  });
}

async function decodeAudioDuration(dataUrl: string): Promise<number> {
  const Ctx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctx();
  try {
    const resp = await fetch(dataUrl);
    const buf = await resp.arrayBuffer();
    const decoded = await ctx.decodeAudioData(buf);
    return decoded.duration;
  } finally {
    await ctx.close().catch(() => {});
  }
}

function Studio() {
  const { id } = Route.useParams();
  const [p, setP] = useState<Project | null | undefined>(undefined);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [exporting, setExporting] = useState<number | null>(null);
  const [exportMethod, setExportMethod] = useState<"ffmpeg" | "browser">("ffmpeg");
  const paintFallback = useServerFn(generateSceneImage);

  // Platform & Connection Statuses (Gemini, Flow, Piper, FFmpeg)
  const [platformStatus, setPlatformStatus] = useState<PlatformStatus | null>(null);
  const [ttsStatus, setTtsStatus] = useState<LocalTtsStatus | null>(null);
  const [checkingTts, setCheckingTts] = useState(false);
  const [voices, setVoices] = useState<LocalVoice[]>([]);
  const [serviceUrlInput, setServiceUrlInput] = useState(getLocalTtsBaseUrl());
  const [geminiApiKeyInput, setGeminiApiKeyInput] = useState("");
  const [showSetupGuide, setShowSetupGuide] = useState(false);
  const [showVisualBible, setShowVisualBible] = useState(true);

  // Google Flow / Nano Banana Playwright Queue State
  const [flowConnecting, setFlowConnecting] = useState(false);
  const [flowJobs, setFlowJobs] = useState<Record<string, FlowQueueJob>>({});

  // Local Piper TTS State
  const [voicing, setVoicing] = useState(false);
  const [voicingProgress, setVoicingProgress] = useState<{ current: number; total: number } | null>(null);
  const [sceneVoicing, setSceneVoicing] = useState<Record<string, boolean>>({});
  const [previewingVoice, setPreviewingVoice] = useState(false);
  const [ttsError, setTtsError] = useState<string | null>(null);

  // Background Music Library state (IndexedDB)
  const [musicLibrary, setMusicLibrary] = useState<MusicTrack[]>([]);
  const [uploadingMusic, setUploadingMusic] = useState(false);
  const [musicError, setMusicError] = useState<string | null>(null);
  const [previewTrackId, setPreviewTrackId] = useState<string | null>(null);
  const musicUploadRef = useRef<HTMLInputElement>(null);
  const refVoiceUploadRef = useRef<HTMLInputElement>(null);
  const [uploadingRefVoice, setUploadingRefVoice] = useState(false);

  // Standalone audio preview players
  const [playingNarration, setPlayingNarration] = useState(false);
  const [playingCombinedMix, setPlayingCombinedMix] = useState(false);
  const [videoPlayTrigger, setVideoPlayTrigger] = useState(0);
  const singleAudioRef = useRef<HTMLAudioElement | null>(null);
  const mixCtxRef = useRef<AudioContext | null>(null);
  const mixStopRef = useRef<(() => void) | null>(null);

  const refreshLocalTts = useCallback(async (customUrl?: string) => {
    setCheckingTts(true);
    const url = customUrl ?? getLocalTtsBaseUrl();
    const [plat, st] = await Promise.all([fetchPlatformStatus(url), checkLocalTtsStatus(url)]);
    setPlatformStatus(plat);
    setTtsStatus(st);
    if (st.ok) {
      const vList = await fetchLocalTtsVoices(url);
      setVoices(vList.voices);
      setTtsError(null);
    } else {
      setVoices([]);
    }
    setCheckingTts(false);
    return st;
  }, []);

  useEffect(() => {
    let mounted = true;
    Promise.all([getProject(id), listMusicTracks(), getAudioPreferences(), refreshLocalTts()]).then(
      ([proj, tracks, prefs]) => {
        if (!mounted) return;
        setMusicLibrary(tracks);
        if (!proj) {
          setP(null);
          return;
        }
        const hydrated: Project = {
          ...proj,
          aspectRatio: proj.aspectRatio ?? prefs.aspectRatio ?? "9:16",
          visualStyle: proj.visualStyle ?? "cinematic painted 2D anime",
          visualBible: proj.visualBible ?? DEFAULT_VISUAL_BIBLE,
          narrationScript:
            proj.narrationScript ?? proj.scenes.map((s) => s.narration || s.caption).join(" "),
          voiceId: proj.voiceId ?? prefs.selectedVoiceId ?? "gemini:clone_whayrs_male",
          watermark: proj.watermark ?? "@W.hayrs",
          voiceLanguage: proj.voiceLanguage ?? prefs.voiceLanguage ?? "all",
          voiceGender: proj.voiceGender ?? prefs.voiceGender ?? "all",
          voiceSpeed: proj.voiceSpeed ?? prefs.voiceSpeed ?? 0.9,
          voiceVolume: proj.voiceVolume ?? prefs.voiceVolume ?? DEFAULT_VOICE_VOLUME,
          voiceEnabled: proj.voiceEnabled ?? true,
          selectedMusicId:
            proj.selectedMusicId && tracks.some((t) => t.id === proj.selectedMusicId)
              ? proj.selectedMusicId
              : prefs.selectedMusicId && tracks.some((t) => t.id === prefs.selectedMusicId)
                ? prefs.selectedMusicId
                : proj.selectedMusicId,
          musicEnabled: proj.musicEnabled ?? true,
          musicVolume: proj.musicVolume ?? prefs.musicVolume ?? DEFAULT_MUSIC_VOLUME,
          musicFadeIn: proj.musicFadeIn ?? prefs.musicFadeIn ?? DEFAULT_FADE_IN,
          musicFadeOut: proj.musicFadeOut ?? prefs.musicFadeOut ?? DEFAULT_FADE_OUT,
          musicStartOffset: proj.musicStartOffset ?? 0,
          shortTrackBehavior: proj.shortTrackBehavior ?? prefs.shortTrackBehavior ?? "loop",
          duckingEnabled: proj.duckingEnabled ?? prefs.duckingEnabled ?? true,
          duckingLevel: proj.duckingLevel ?? prefs.duckingLevel ?? DEFAULT_DUCKING_LEVEL,
          exportAudioMode: proj.exportAudioMode ?? "both",
        };
        setP(hydrated);
        saveProject(hydrated);
      },
    );
    return () => {
      mounted = false;
      singleAudioRef.current?.pause();
      mixStopRef.current?.();
      mixCtxRef.current?.close().catch(() => {});
    };
  }, [id, refreshLocalTts]);

  const update = useCallback(
    (np: Project, persistPrefs?: Partial<Parameters<typeof saveAudioPreferences>[0]>) => {
      setP(np);
      saveProject(np);
      if (persistPrefs) {
        saveAudioPreferences(persistPrefs).catch(() => {});
      }
    },
    [],
  );

  // Poll Google Flow queue when any job is queued or running
  useEffect(() => {
    if (!p) return;
    const hasActiveFlowJob = Object.values(flowJobs).some(
      (j) => j.status === "queued" || j.status === "running",
    );
    if (!hasActiveFlowJob) return;

    const timer = window.setInterval(async () => {
      const q = await fetchFlowQueueStatus(p.id);
      if (!q) return;
      const map: Record<string, FlowQueueJob> = {};
      for (const job of q.jobs) {
        map[job.scene_id] = job;
      }
      setFlowJobs(map);

      // Sync completed images into project scenes without overwriting other scenes
      const completedJobs = q.jobs.filter((j) => j.status === "completed" && j.result?.data_url);
      if (completedJobs.length > 0) {
        const fresh = (await getProject(id)) ?? p;
        let changed = false;
        const nextScenes = fresh.scenes.map((sc) => {
          const cj = completedJobs.find((j) => j.scene_id === sc.id);
          if (cj?.result && sc.image !== cj.result.data_url) {
            changed = true;
            const prevVersions = sc.imageVersions ?? [];
            const existsVersion = prevVersions.some((v) => v.version_id === cj.result?.version_id);
            return {
              ...sc,
              image: cj.result.data_url,
              imageStatus: "ready" as const,
              imageError: undefined,
              imageVersions: existsVersion
                ? prevVersions
                : [
                    {
                      version_id: cj.result.version_id,
                      prompt: cj.result.prompt,
                      source: cj.result.source,
                      data_url: cj.result.data_url,
                      created_at: cj.result.created_at,
                    },
                    ...prevVersions,
                  ].slice(0, 10),
            };
          }
          return sc;
        });
        if (changed) {
          update({ ...fresh, scenes: nextScenes });
        }
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [flowJobs, p, id, update]);

  // Auto-select first matching installed voice when voices arrive
  useEffect(() => {
    if (!p || voices.length === 0) return;
    const exists = p.voiceId && voices.some((v) => v.id === p.voiceId);
    if (!exists) {
      const preferred = voices.find((v) => v.id === "gemini:clone_whayrs_male") ?? voices.find((v) => v.id === "gemini:clone_reference") ?? voices.find((v) => v.id.includes("ryan")) ?? voices[0];
      if (preferred) {
        update({ ...p, voiceId: preferred.id }, { selectedVoiceId: preferred.id });
      }
    }
  }, [voices, p, update]);

  const filteredVoices = useMemo(() => {
    if (!p) return voices;
    return voices.filter((v) => {
      const langMatch = !p.voiceLanguage || p.voiceLanguage === "all" || v.language === p.voiceLanguage;
      const genderMatch = !p.voiceGender || p.voiceGender === "all" || v.gender === p.voiceGender;
      return langMatch && genderMatch;
    });
  }, [voices, p]);

  const availableLanguages = useMemo(() => {
    const map = new Map<string, string>();
    for (const v of voices) {
      map.set(v.language, v.languageName || v.language);
    }
    if (!map.has("en_US")) map.set("en_US", "English (United States)");
    if (!map.has("en_GB")) map.set("en_GB", "English (United Kingdom)");
    return Array.from(map.entries());
  }, [voices]);

  const selectedVoiceObj = useMemo(
    () => voices.find((v) => v.id === p?.voiceId) ?? filteredVoices[0] ?? null,
    [voices, filteredVoices, p?.voiceId],
  );

  const selectedMusicTrack = useMemo(
    () => musicLibrary.find((t) => t.id === p?.selectedMusicId) ?? null,
    [musicLibrary, p?.selectedMusicId],
  );

  function stopAllStandaloneAudio() {
    if (singleAudioRef.current) {
      singleAudioRef.current.pause();
      singleAudioRef.current = null;
    }
    setPlayingNarration(false);
    setPreviewTrackId(null);
    if (mixStopRef.current) {
      mixStopRef.current();
      mixStopRef.current = null;
    }
    setPlayingCombinedMix(false);
  }

  // ---------- Visual Bible Sync ----------

  function syncVisualBibleToPrompts() {
    if (!p) return;
    const vb = p.visualBible ?? DEFAULT_VISUAL_BIBLE;
    const prefix = `Consistent protagonist (${vb.age_range}, ${vb.character_appearance}, hair: ${vb.hair}, wearing ${vb.clothing}). Environment & palette: ${vb.environment}, ${vb.color_palette}, lighting: ${vb.lighting}. Style: ${vb.art_style}`;
    const nextScenes = p.scenes.map((s) => ({
      ...s,
      imagePrompt: `${s.visual.replace(/\.$/, "")}. ${prefix}`,
    }));
    update({ ...p, visualBible: vb, scenes: nextScenes });
    toast.success("Synced Visual Bible character & style details into all scene prompts");
  }

  // ---------- Scene Image Generation (Playwright Google Flow / Nano Banana + Manual Upload) ----------

  async function handleConnectFlowBrowser() {
    setFlowConnecting(true);
    const res = await connectFlowBrowser(false);
    setFlowConnecting(false);
    await refreshLocalTts();
    if (!res.ok) {
      toast.error(res.error ?? "Google Flow browser requires setup or sign-in.");
      return;
    }
    if (res.browser?.status === "waiting_for_signin") {
      toast.info("Playwright browser opened. Sign in to your Google account in that window, then click Verify Sign-In.");
    } else {
      toast.success("Google Flow browser connected and ready");
    }
  }

  async function handleVerifySignin() {
    const res = await verifyFlowSignin();
    await refreshLocalTts();
    if (res.ok) {
      toast.success("Google Flow Sign-In verified! Ready to generate Nano Banana scenes.");
    } else {
      toast.error(res.browser?.message ?? "Still waiting for Google Sign-In in the Playwright window.");
    }
  }

  async function paintScene(sid: string) {
    if (!p) return;
    setBusy((b) => ({ ...b, [sid]: true }));
    const cur = (await getProject(id)) ?? p;
    const idx = cur.scenes.findIndex((s) => s.id === sid);
    const scene = cur.scenes[idx];
    if (!scene) {
      setBusy((b) => ({ ...b, [sid]: false }));
      return;
    }

    const targetRatio: VideoAspectRatio = cur.aspectRatio ?? "9:16";

    // 1. If Google Flow Playwright browser is connected and ready, queue via Flow / Nano Banana
    if (platformStatus?.flow.status === "ready" || platformStatus?.flow.status === "generating_images") {
      const qRes = await enqueueFlowSceneJob({
        project_id: cur.id,
        scene_id: scene.id,
        scene_number: scene.sceneNumber ?? idx + 1,
        visual_description: scene.visual,
        image_prompt: scene.imagePrompt || scene.visual,
        visual_bible: cur.visualBible,
        camera_movement: scene.cameraMovement ?? "slow zoom in",
        ratio: targetRatio,
        force: true,
      });
      setBusy((b) => ({ ...b, [sid]: false }));
      if (qRes.ok) {
        setFlowJobs((prev) => ({ ...prev, [sid]: qRes.job }));
        toast.success(`Queued Scene ${idx + 1} (${targetRatio}) in Google Flow (Nano Banana)`);
        return;
      }
    }

    // 2. Otherwise use the studio image adapter with Visual Bible embedded + automatic retry on failure
    const fullPrompt =
      scene.imagePrompt ||
      `${scene.visual}. ${cur.visualBible ? `${cur.visualBible.character_appearance}, wearing ${cur.visualBible.clothing}, ${cur.visualBible.color_palette}` : ""}`;
    let r: { ok: true; image: string } | { ok: false; error: string } = { ok: false, error: "Not started" };
    for (let attempt = 1; attempt <= 2; attempt++) {
      r = await paintFallback({ data: { visual: fullPrompt, aspectRatio: targetRatio } }).catch((e: Error) => ({
        ok: false as const,
        error: e.message,
      }));
      if (r.ok) break;
    }
    setBusy((b) => ({ ...b, [sid]: false }));
    if (!r.ok) {
      toast.error(r.error);
      return;
    }
    const fresh = (await getProject(id))!;
    const versionEntry = {
      version_id: `v_${Date.now()}`,
      prompt: fullPrompt,
      source: "nano_banana_studio",
      data_url: r.image,
      created_at: Date.now() / 1000,
    };
    update({
      ...fresh,
      scenes: fresh.scenes.map((s) =>
        s.id === sid
          ? {
              ...s,
              image: r.image,
              imageStatus: "ready",
              imageError: undefined,
              imageVersions: [versionEntry, ...(s.imageVersions ?? [])].slice(0, 10),
            }
          : s,
      ),
    });
  }

  async function paintAll() {
    if (!p) return;
    const todo = p.scenes.filter((s) => !s.image);
    for (let i = 0; i < todo.length; i += 3) {
      await Promise.all(todo.slice(i, i + 3).map((s) => paintScene(s.id)));
    }
  }

  async function handleManualSceneImageUpload(sid: string, file: File | undefined) {
    if (!file || !p) return;
    if (!file.type.startsWith("image/")) {
      toast.error("Please select a valid PNG, JPEG, or WebP image file.");
      return;
    }
    setBusy((b) => ({ ...b, [sid]: true }));
    try {
      const rawDataUrl = await fileToDataUrl(file);
      const idx = p.scenes.findIndex((s) => s.id === sid);
      const sc = p.scenes[idx];
      const upRes = await uploadManualSceneImageToBackend({
        project_id: p.id,
        scene_id: sid,
        scene_number: sc?.sceneNumber ?? idx + 1,
        image_data_url: rawDataUrl,
        prompt: sc?.imagePrompt || sc?.visual || "Manual upload",
        ratio: p.aspectRatio ?? "9:16",
      });
      setBusy((b) => ({ ...b, [sid]: false }));
      if (!upRes.ok) {
        toast.error(upRes.error);
        return;
      }
      const fresh = (await getProject(id)) ?? p;
      // Only update the targeted scene; preserve all other scenes & audio
      update({
        ...fresh,
        scenes: fresh.scenes.map((s) =>
          s.id === sid
            ? {
                ...s,
                image: upRes.version.data_url,
                imageStatus: "ready",
                imageError: undefined,
                imageVersions: [upRes.version, ...(s.imageVersions ?? [])].slice(0, 10),
              }
            : s,
        ),
      });
      toast.success(`Uploaded & verified scene image for Scene ${idx + 1}`);
    } catch (err) {
      setBusy((b) => ({ ...b, [sid]: false }));
      toast.error(err instanceof Error ? err.message : "Failed to upload scene image.");
    }
  }

  // ---------- Local Piper TTS Voiceover Generation ----------

  async function handlePreviewVoice() {
    if (!p) return;
    stopAllStandaloneAudio();
    setTtsError(null);
    setPreviewingVoice(true);

    const st = await refreshLocalTts();
    if (!st.ok) {
      setPreviewingVoice(false);
      setTtsError(st.message);
      setShowSetupGuide(true);
      toast.error("Local Piper TTS engine is unavailable. See setup instructions below.");
      return;
    }

    const voiceToUse = selectedVoiceObj?.id ?? p.voiceId ?? "";
    const sampleText =
      p.scenes[0]?.narration ||
      p.scenes[0]?.caption ||
      "Stay strong through the quiet days. Your discipline today builds your tomorrow.";

    const res = await synthesizeLocalSpeech({
      text: sampleText,
      voice: voiceToUse,
      speed: p.voiceSpeed ?? 0.9,
      ...(p.referenceVoiceDataUrl ? { referenceAudioDataUrl: p.referenceVoiceDataUrl } : {}),
    });
    setPreviewingVoice(false);

    if (!res.ok) {
      setTtsError(res.error);
      toast.error(res.error);
      return;
    }

    const audio = new Audio(res.wavDataUrl);
    audio.volume = Math.max(0, Math.min(1, (p.voiceVolume ?? DEFAULT_VOICE_VOLUME) / 100));
    singleAudioRef.current = audio;
    audio.play().catch(() => {});
    toast.success(`Previewing ${selectedVoiceObj?.name ?? voiceToUse}`);
  }

  async function generateSceneVoice(sid: string) {
    if (!p) return;
    setTtsError(null);
    const st = await refreshLocalTts();
    if (!st.ok) {
      setTtsError(st.message);
      setShowSetupGuide(true);
      toast.error("Local Piper TTS service is unavailable.");
      return;
    }
    const voiceToUse = selectedVoiceObj?.id ?? p.voiceId ?? "";
    const cur = (await getProject(id)) ?? p;
    const scene = cur.scenes.find((s) => s.id === sid);
    if (!scene) return;

    setSceneVoicing((prev) => ({ ...prev, [sid]: true }));
    const res = await synthesizeLocalSpeech({
      text: scene.narration || scene.caption,
      voice: voiceToUse,
      speed: cur.voiceSpeed ?? 0.9,
      ...(cur.referenceVoiceDataUrl ? { referenceAudioDataUrl: cur.referenceVoiceDataUrl } : {}),
    });
    setSceneVoicing((prev) => ({ ...prev, [sid]: false }));

    if (!res.ok) {
      setTtsError(res.error);
      toast.error(res.error);
      return;
    }

    const fresh = (await getProject(id)) ?? cur;
    const nextScenes = fresh.scenes.map((s) =>
      s.id === sid ? { ...s, voice: res.wavDataUrl, voiceDuration: res.duration } : s,
    );
    const combined = buildCombinedNarrationWav(nextScenes);
    update({
      ...fresh,
      voiceId: voiceToUse,
      scenes: nextScenes,
      narrationWav: combined?.wavDataUrl,
      narrationDuration: combined?.duration,
    });
    toast.success("Scene voiceover updated locally");
  }

  async function generateAllNarration() {
    if (!p) return;
    stopAllStandaloneAudio();
    setTtsError(null);
    setVoicing(true);

    const st = await refreshLocalTts();
    if (!st.ok) {
      setVoicing(false);
      setTtsError(st.message);
      setShowSetupGuide(true);
      toast.error("Local Piper TTS engine is not running. Start local-tts\\start.bat first.");
      return;
    }

    const voiceToUse = selectedVoiceObj?.id ?? p.voiceId ?? "";
    if (!voiceToUse) {
      setVoicing(false);
      setTtsError("No local Piper voice model is selected or installed.");
      toast.error("No local Piper voice model available.");
      return;
    }

    const speed = p.voiceSpeed ?? 0.9;
    const currentProj = (await getProject(id)) ?? p;
    const updatedScenes = [...currentProj.scenes];
    setVoicingProgress({ current: 0, total: updatedScenes.length });

    for (let i = 0; i < updatedScenes.length; i++) {
      const sc = updatedScenes[i]!;
      setVoicingProgress({ current: i + 1, total: updatedScenes.length });
      const res = await synthesizeLocalSpeech({
        text: sc.narration || sc.caption,
        voice: voiceToUse,
        speed,
        ...(currentProj.referenceVoiceDataUrl ? { referenceAudioDataUrl: currentProj.referenceVoiceDataUrl } : {}),
      });
      if (!res.ok) {
        setTtsError(res.error);
        toast.error(res.error);
        setVoicing(false);
        setVoicingProgress(null);
        return;
      }
      updatedScenes[i] = {
        ...sc,
        voice: res.wavDataUrl,
        voiceDuration: res.duration,
      };
    }

    const combined = buildCombinedNarrationWav(updatedScenes);
    const latest = (await getProject(id)) ?? currentProj;
    // Reference-reel timing: each image stays exactly as long as its spoken phrase plus a short breath.
    const mergedScenes = latest.scenes.map((s, idx) => {
      const vd = updatedScenes[idx]?.voiceDuration;
      return {
        ...s,
        voice: updatedScenes[idx]?.voice,
        voiceDuration: vd,
        duration: vd ? sceneDurationForVoice(vd) : s.duration,
      };
    });

    const nextProj: Project = {
      ...latest,
      voiceId: voiceToUse,
      voiceEnabled: true,
      scenes: mergedScenes,
      narrationWav: combined?.wavDataUrl,
      narrationDuration: combined?.duration,
    };
    update(nextProj, { selectedVoiceId: voiceToUse, voiceSpeed: speed });
    setVoicing(false);
    setVoicingProgress(null);
    toast.success("Local WAV narration generated");
  }


  async function handleUploadReferenceVoice(file: File | undefined) {
    if (!file || !p) return;
    setUploadingRefVoice(true);
    try {
      const dataUrl = await fileToDataUrl(file);
      await uploadReferenceVoiceToBackend(dataUrl, file.name).catch(() => null);
      const fresh = (await getProject(id)) ?? p;
      update(
        {
          ...fresh,
          voiceId: "gemini:clone_reference",
          referenceVoiceDataUrl: dataUrl,
          referenceVoiceName: file.name,
        },
        { selectedVoiceId: "gemini:clone_reference" },
      );
      toast.success(`Loaded cloned voice reference "${file.name}" for Gemini TTS`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load reference voice clip.");
    } finally {
      setUploadingRefVoice(false);
      if (refVoiceUploadRef.current) refVoiceUploadRef.current.value = "";
    }
  }

  function handlePlayNarrationWav() {
    if (!p?.narrationWav) return;
    if (playingNarration) {
      stopAllStandaloneAudio();
      return;
    }
    stopAllStandaloneAudio();
    const audio = new Audio(p.narrationWav);
    audio.volume = Math.max(0, Math.min(1, (p.voiceVolume ?? DEFAULT_VOICE_VOLUME) / 100));
    audio.onended = () => setPlayingNarration(false);
    singleAudioRef.current = audio;
    setPlayingNarration(true);
    audio.play().catch(() => setPlayingNarration(false));
  }

  function handleDownloadNarrationWav() {
    if (!p) return;
    const wavUrl = p.narrationWav ?? buildCombinedNarrationWav(p.scenes)?.wavDataUrl;
    if (!wavUrl) {
      toast.error("Generate narration first before downloading WAV.");
      return;
    }
    const a = document.createElement("a");
    a.href = wavUrl;
    a.download = `${p.title.replace(/[^\w-]+/g, "_") || "narration"}_voiceover.wav`;
    a.click();
    toast.success("Downloaded voiceover WAV");
  }

  // ---------- Background Music Upload & Library Management ----------

  async function handleUploadMusicFiles(files: FileList | null) {
    if (!files || files.length === 0 || !p) return;
    setMusicError(null);
    setUploadingMusic(true);

    let lastCreated: MusicTrack | null = null;
    for (const file of Array.from(files)) {
      const check = validateMusicFile(file);
      if (!check.ok) {
        setMusicError(check.error);
        toast.error(check.error);
        continue;
      }
      try {
        const dataUrl = await fileToDataUrl(file);
        const duration = await decodeAudioDuration(dataUrl);
        if (!Number.isFinite(duration) || duration <= 0.1) {
          throw new Error(`Could not decode audio stream in "${file.name}".`);
        }
        const track: MusicTrack = {
          id: uid(),
          name: file.name,
          mimeType: check.mimeType,
          format: check.format,
          sizeBytes: file.size,
          duration: Math.round(duration * 10) / 10,
          dataUrl,
          createdAt: Date.now(),
        };
        await saveMusicTrack(track);
        lastCreated = track;
      } catch (err) {
        const msg =
          err instanceof Error
            ? err.message
            : `Audio file "${file.name}" could not be decoded by the browser audio pipeline.`;
        setMusicError(msg);
        toast.error(msg);
      }
    }

    const updatedLibrary = await listMusicTracks();
    setMusicLibrary(updatedLibrary);
    setUploadingMusic(false);
    if (musicUploadRef.current) musicUploadRef.current.value = "";

    if (lastCreated) {
      const fresh = (await getProject(id)) ?? p;
      update(
        {
          ...fresh,
          selectedMusicId: lastCreated.id,
          musicEnabled: true,
          musicStartOffset: 0,
        },
        { selectedMusicId: lastCreated.id },
      );
      toast.success(`Uploaded & selected "${lastCreated.name}" (${formatDuration(lastCreated.duration)})`);
    }
  }

  function handleSelectMusicTrack(trackId: string) {
    if (!p) return;
    update(
      {
        ...p,
        selectedMusicId: trackId,
        musicEnabled: true,
        musicStartOffset: 0,
        shortTrackBehavior: p.shortTrackBehavior === "change" ? "loop" : (p.shortTrackBehavior ?? "loop"),
      },
      { selectedMusicId: trackId },
    );
    const tr = musicLibrary.find((x) => x.id === trackId);
    if (tr) toast.success(`Selected "${tr.name}" for this project`);
  }

  async function handleDeleteMusicTrack(track: MusicTrack) {
    if (previewTrackId === track.id) stopAllStandaloneAudio();
    await deleteMusicTrack(track.id);
    const updatedLibrary = await listMusicTracks();
    setMusicLibrary(updatedLibrary);
    if (p && p.selectedMusicId === track.id) {
      const nextTrack = updatedLibrary[0];
      update({ ...p, selectedMusicId: nextTrack?.id }, { selectedMusicId: nextTrack?.id });
    }
    toast.success(`Removed "${track.name}" from Background Music Library`);
  }

  function handlePreviewLibraryTrack(track: MusicTrack) {
    if (previewTrackId === track.id) {
      stopAllStandaloneAudio();
      return;
    }
    stopAllStandaloneAudio();
    const audio = new Audio(track.dataUrl);
    audio.volume = Math.max(0.05, Math.min(1, (p?.musicVolume ?? DEFAULT_MUSIC_VOLUME) / 100));
    audio.onended = () => setPreviewTrackId(null);
    singleAudioRef.current = audio;
    setPreviewTrackId(track.id);
    audio.play().catch(() => setPreviewTrackId(null));
  }

  // ---------- Combined Audio Mix Preview (with Automatic Ducking) ----------

  async function handleToggleCombinedMix() {
    if (!p) return;
    if (playingCombinedMix) {
      stopAllStandaloneAudio();
      return;
    }
    stopAllStandaloneAudio();
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    mixCtxRef.current = ctx;
    const bufs = await loadAudio(ctx, p);
    if (!bufs.music && !bufs.voices.some(Boolean)) {
      await ctx.close().catch(() => {});
      toast.error("Generate local narration or select a background music track first.");
      return;
    }
    await ctx.resume();
    const total = totalDuration(p);
    setPlayingCombinedMix(true);
    const playback = playAudioWithControls(ctx, ctx.destination, p, bufs, 0, {
      mode: p.exportAudioMode ?? "both",
    });
    const timer = window.setTimeout(() => {
      setPlayingCombinedMix(false);
    }, total * 1000 + 200);
    mixStopRef.current = () => {
      window.clearTimeout(timer);
      playback.stop();
      ctx.close().catch(() => {});
    };
  }

  // ---------- Final Video Export (FFmpeg + FFprobe OR Browser MediaRecorder) ----------

  async function doExport(modeOverride?: ExportAudioMode) {
    if (!p) return;
    stopAllStandaloneAudio();
    const mode = modeOverride ?? p.exportAudioMode ?? "both";
    setExporting(0.1);

    try {
      // 1. Primary path: FFmpeg + FFprobe backend renderer (1080x1920, 30 FPS, H.264, AAC, yuv420p, +faststart)
      if (exportMethod === "ffmpeg" && platformStatus?.ffmpeg.available) {
        setExporting(0.35);
        const ffRes = await renderProjectWithFFmpegService(p, mode);
        if (ffRes.ok) {
          setExporting(1.0);
          const a = document.createElement("a");
          a.href = URL.createObjectURL(ffRes.blob);
          a.download = ffRes.fileName;
          a.click();
          const fresh = (await getProject(id)) ?? p;
          update({ ...fresh, lastExportReport: ffRes.validation });
          toast.success(
            `Exported FFmpeg MP4 (${ffRes.validation.width}×${ffRes.validation.height}, ${ffRes.validation.video_codec.toUpperCase()}, ${ffRes.validation.duration_seconds}s — FFprobe verified!)`,
          );
          setExporting(null);
          return;
        }
        toast.error(ffRes.error);
        setExporting(null);
        return;
      }

      // 2. Browser MediaRecorder + Web Audio API pipeline
      const { blob, ext } = await exportVideo(p, setExporting, mode);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      const suffix =
        mode === "voice"
          ? "_voiceover_only"
          : mode === "music"
            ? "_music_only"
            : mode === "none"
              ? "_no_audio"
              : "";
      a.download = `${p.title.replace(/[^\w-]+/g, "_") || "video"}${suffix}.${ext}`;
      a.click();
      toast.success(`Exported 1080×1920 30FPS video (.${ext})`);
    } catch (e) {
      toast.error((e as Error).message);
    }
    setExporting(null);
  }

  if (p === undefined) return <div className="p-10 text-muted-foreground">Loading studio…</div>;
  if (p === null) {
    return (
      <div className="p-10">
        Project not found.{" "}
        <Link to="/" className="text-primary">
          Back to dashboard
        </Link>
      </div>
    );
  }

  const allPainted = p.scenes.every((s) => s.image);
  const anyBusy = Object.values(busy).some(Boolean);
  const narratedCount = p.scenes.filter((s) => Boolean(s.voice)).length;
  const allNarrated = p.scenes.length > 0 && narratedCount === p.scenes.length;
  const vidDuration = totalDuration(p);
  const isSelectedMusicShort = Boolean(
    selectedMusicTrack && selectedMusicTrack.duration + 0.1 < vidDuration,
  );
  const isAudioMixReady =
    (p.voiceEnabled !== false && narratedCount > 0) ||
    (p.musicEnabled !== false && Boolean(selectedMusicTrack));
  const vb = p.visualBible ?? DEFAULT_VISUAL_BIBLE;

  return (
    <div className="mx-auto max-w-[1440px] p-6 md:p-10">
      <div className="grid gap-8 lg:grid-cols-[1fr_400px]">
        {/* LEFT COLUMN: Script Studio, Scene & Flow Studio, Audio Studio */}
        <div className="min-w-0 space-y-8">
          {/* Header & Project Title */}
          <div>
            <Link
              to="/"
              className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition hover:text-foreground"
            >
              <ArrowLeft className="size-4" />
              Projects
            </Link>
            <Input
              value={p.title}
              onChange={(e) => update({ ...p, title: e.target.value })}
              aria-label="Project title"
              className="mt-2 h-auto border-none bg-transparent px-0 font-display text-4xl md:text-5xl focus-visible:ring-0"
            />
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button onClick={paintAll} disabled={anyBusy || allPainted}>
                {anyBusy ? <Loader2 className="animate-spin" /> : <Wand2 />}
                {allPainted ? "All scenes painted" : "Generate all missing scene images"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowVisualBible((x) => !x)}
              >
                <BookOpen className="size-3.5 text-primary" />
                {showVisualBible ? "Hide Script & Visual Bible" : "Script Studio & Visual Bible"}
              </Button>
              <div className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1 text-xs">
                <Film className="size-3.5 text-primary" />
                <span className="text-muted-foreground">Format:</span>
                <select
                  aria-label="Project video aspect ratio"
                  value={p.aspectRatio ?? "9:16"}
                  onChange={(e) => {
                    const nextRatio = e.target.value as VideoAspectRatio;
                    update({ ...p, aspectRatio: nextRatio }, { aspectRatio: nextRatio });
                    toast.success(`Switched video format to ${nextRatio === "16:9" ? "16:9 Widescreen (1920×1080)" : "9:16 Vertical (1080×1920)"}`);
                  }}
                  className="bg-transparent font-medium text-foreground focus:outline-none"
                >
                  <option value="9:16" className="bg-popover">9:16 Vertical (Default · 1080×1920)</option>
                  <option value="16:9" className="bg-popover">16:9 Widescreen (1920×1080)</option>
                </select>
              </div>
              <span className="text-xs text-muted-foreground">
                {p.scenes.filter((s) => s.image).length}/{p.scenes.length} painted ·{" "}
                {narratedCount}/{p.scenes.length} narrated · {vidDuration}s total ({p.aspectRatio ?? "9:16"})
              </span>
            </div>

            {/* Live Connection Status Pills (Gemini, Google Flow, Piper, Music) */}
            <div className="mt-4 flex flex-wrap gap-2" data-testid="provider-status-bar">
              <span
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${
                  platformStatus?.gemini.connected
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                    : "border-amber-500/30 bg-amber-500/10 text-amber-300"
                }`}
              >
                <Sparkles className="size-3" />
                Gemini: {platformStatus?.gemini.connected ? "Connected" : "Not configured"}
              </span>

              <span
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${
                  platformStatus?.flow.status === "ready" ||
                  platformStatus?.flow.status === "generating_images"
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                    : "border-amber-500/30 bg-amber-500/10 text-amber-300"
                }`}
              >
                <Globe className="size-3" />
                Google Flow:{" "}
                {platformStatus?.flow.status === "ready"
                  ? "Ready"
                  : platformStatus?.flow.status === "waiting_for_signin"
                    ? "Waiting for sign-in"
                    : platformStatus?.flow.status === "generating_images"
                      ? "Generating images"
                      : platformStatus?.flow.status === "generation_failed"
                        ? "Generation failed"
                        : "Browser disconnected"}
              </span>

              <span
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${
                  ttsStatus?.ok
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                    : "border-amber-500/30 bg-amber-500/10 text-amber-300"
                }`}
              >
                <Mic className="size-3" />
                Piper:{" "}
                {ttsStatus?.ok
                  ? `Running (${ttsStatus.voices} voices)`
                  : ttsStatus?.status === "not_installed"
                    ? "Not installed"
                    : "Unavailable"}
              </span>

              <span
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${
                  selectedMusicTrack
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                    : musicLibrary.length > 0
                      ? "border-primary/40 bg-primary/15 text-primary"
                      : "border-border bg-secondary/60 text-muted-foreground"
                }`}
              >
                <Music className="size-3" />
                Music:{" "}
                {selectedMusicTrack
                  ? "Track selected"
                  : musicLibrary.length > 0
                    ? "Ready"
                    : "No track uploaded"}
              </span>
            </div>
          </div>

          {/* STEP 1: SCRIPT STUDIO & VISUAL BIBLE (GEMINI) */}
          {showVisualBible && (
            <section
              aria-label="Script Studio and Visual Bible"
              className="space-y-4 rounded-2xl border border-border bg-card p-5"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
                <div>
                  <h2 className="font-display text-2xl">1. Script Studio &amp; Visual Bible (Gemini)</h2>
                  <p className="text-xs text-muted-foreground">
                    Visual consistency bible shared across all {p.scenes.length} scene prompts so the main character and painted 2D anime palette stay consistent.
                  </p>
                </div>
                <Button size="sm" variant="secondary" onClick={syncVisualBibleToPrompts}>
                  <Sparkles className="size-3.5 text-primary" />
                  Sync Visual Bible to All Scene Prompts
                </Button>
              </div>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 text-xs">
                {(
                  [
                    ["character_appearance", "Character Appearance"],
                    ["clothing", "Clothing & Outfit"],
                    ["hair", "Hair Style & Color"],
                    ["age_range", "Age Range"],
                    ["body_proportions", "Body Proportions"],
                    ["environment", "Environment Progression"],
                    ["color_palette", "Color Palette (Blue / Green / Orange)"],
                    ["lighting", "Atmospheric Lighting"],
                    ["art_style", "Art Style & Negative Rules"],
                  ] as const
                ).map(([key, label]) => (
                  <div key={key} className="space-y-1">
                    <label className="font-medium text-muted-foreground">{label}</label>
                    <Input
                      value={vb[key]}
                      onChange={(e) =>
                        update({
                          ...p,
                          visualBible: { ...vb, [key]: e.target.value },
                        })
                      }
                      className="h-8 text-xs"
                    />
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* STEP 2: SCENE STUDIO & GOOGLE FLOW (NANO BANANA) QUEUE */}
          <section aria-label="Storyboard scenes" className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-4">
              <div>
                <h2 className="font-display text-2xl">
                  2. Scene Studio &amp; Google Flow (Nano Banana) Queue
                </h2>
                <p className="text-xs text-muted-foreground">
                  Connect your persistent Playwright browser profile to sign in to Google Flow, or upload/regenerate individual scenes without affecting other scenes.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={flowConnecting}
                  onClick={handleConnectFlowBrowser}
                >
                  {flowConnecting ? <Loader2 className="size-3.5 animate-spin" /> : <Globe className="size-3.5 text-primary" />}
                  {platformStatus?.flow.connected ? "Reconnect Flow Browser" : "Connect Flow Browser"}
                </Button>
                {platformStatus?.flow.status === "waiting_for_signin" && (
                  <Button size="sm" onClick={handleVerifySignin}>
                    <CheckCircle2 className="size-3.5" />
                    Verify Google Sign-In
                  </Button>
                )}
              </div>
            </div>

            <div className="space-y-3">
              {p.scenes.map((s, i) => {
                const flowJob = flowJobs[s.id];
                const versions = s.imageVersions ?? [];
                return (
                  <div
                    key={s.id}
                    className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 transition hover:border-border/80 sm:flex-row"
                  >
                    <div className={`relative shrink-0 overflow-hidden rounded-lg bg-muted ${(p.aspectRatio ?? "9:16") === "16:9" ? "aspect-video w-44" : "aspect-[9/16] w-28"}`}>
                      {s.image ? (
                        <img src={s.image} alt={s.caption} className="h-full w-full object-cover" />
                      ) : (
                        <div className="flex h-full items-center justify-center text-muted-foreground">
                          <ImageIcon className="size-5" />
                        </div>
                      )}
                      {(busy[s.id] || flowJob?.status === "running" || flowJob?.status === "queued") && (
                        <div className="absolute inset-0 flex flex-col items-center justify-center bg-background/70 p-2 text-center">
                          <Loader2 className="animate-spin text-primary" />
                          <span className="mt-1 text-[10px] text-foreground">
                            {flowJob?.status === "queued" ? "Queued…" : "Painting…"}
                          </span>
                        </div>
                      )}
                    </div>

                    <div className="min-w-0 flex-1 space-y-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground">
                          Scene {i + 1}
                        </span>
                        <Input
                          type="number"
                          step={0.5}
                          min={1.5}
                          max={15}
                          value={s.duration}
                          aria-label={`Scene ${i + 1} duration`}
                          onChange={(e) => {
                            const nextScenes = p.scenes.map((x) =>
                              x.id === s.id ? { ...x, duration: Number(e.target.value) || 1.5 } : x,
                            );
                            const combined = buildCombinedNarrationWav(nextScenes);
                            update({
                              ...p,
                              scenes: nextScenes,
                              narrationWav: combined?.wavDataUrl ?? p.narrationWav,
                              narrationDuration: combined?.duration ?? p.narrationDuration,
                            });
                          }}
                          className="h-7 w-20 text-xs"
                        />
                        <span className="text-xs text-muted-foreground">sec</span>

                        {/* Scene Image Status Badge */}
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                            s.image
                              ? "bg-emerald-500/15 text-emerald-300"
                              : flowJob?.status === "failed"
                                ? "bg-destructive/20 text-destructive"
                                : "bg-secondary text-muted-foreground"
                          }`}
                        >
                          {flowJob?.status
                            ? `Flow: ${flowJob.status}`
                            : s.image
                              ? "Image ready"
                              : "No image"}
                        </span>

                        {s.voice && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary">
                            <CheckCircle2 className="size-3" />
                            WAV ({s.voiceDuration ? `${s.voiceDuration.toFixed(1)}s` : "ready"})
                          </span>
                        )}

                        <div className="ml-auto flex flex-wrap items-center gap-1.5">
                          {/* Version History Selector if multiple versions exist */}
                          {versions.length > 1 && (
                            <select
                              aria-label={`Scene ${i + 1} image version history`}
                              value={versions.find((v) => v.data_url === s.image)?.version_id ?? ""}
                              onChange={(e) => {
                                const ver = versions.find((v) => v.version_id === e.target.value);
                                if (ver) {
                                  update({
                                    ...p,
                                    scenes: p.scenes.map((x) =>
                                      x.id === s.id ? { ...x, image: ver.data_url } : x,
                                    ),
                                  });
                                }
                              }}
                              className="h-7 rounded border border-input bg-background px-1.5 text-[11px]"
                            >
                              {versions.map((v, vIdx) => (
                                <option key={v.version_id} value={v.version_id}>
                                  v{versions.length - vIdx} ({v.source === "manual_upload" ? "Manual" : "Flow"})
                                </option>
                              ))}
                            </select>
                          )}

                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={Boolean(sceneVoicing[s.id]) || voicing}
                            onClick={() => generateSceneVoice(s.id)}
                            title="Synthesize local WAV voiceover for this scene only"
                          >
                            {sceneVoicing[s.id] ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <Mic className="size-3.5 text-primary" />
                            )}
                            <span className="text-xs">{s.voice ? "Redo voice" : "Voice"}</span>
                          </Button>

                          {/* Manual Scene Image Upload Fallback */}
                          <label className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-input bg-background px-2.5 py-1 text-xs font-medium hover:bg-accent">
                            <Upload className="size-3 text-primary" />
                            <span>Upload</span>
                            <input
                              type="file"
                              accept="image/png,image/jpeg,image/webp"
                              aria-label={`Manual image upload for Scene ${i + 1}`}
                              onChange={(e) =>
                                handleManualSceneImageUpload(s.id, e.target.files?.[0])
                              }
                              className="hidden"
                            />
                          </label>

                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={busy[s.id]}
                            onClick={() => paintScene(s.id)}
                          >
                            <RefreshCw className="size-3.5" />
                            {s.image ? "Regenerate" : "Generate"}
                          </Button>
                        </div>
                      </div>

                      {flowJob?.error_message && (
                        <p className="rounded bg-destructive/10 px-2.5 py-1 text-[11px] text-destructive">
                          {flowJob.error_message}
                        </p>
                      )}

                      <div className="grid gap-2 sm:grid-cols-2">
                        <div>
                          <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                            On-Screen Caption
                          </label>
                          <Input
                            value={s.caption}
                            aria-label={`Scene ${i + 1} caption`}
                            onChange={(e) =>
                              update({
                                ...p,
                                scenes: p.scenes.map((x) =>
                                  x.id === s.id ? { ...x, caption: e.target.value } : x,
                                ),
                              })
                            }
                            className="font-caption text-base"
                          />
                        </div>
                        <div>
                          <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                            Spoken Narration (Piper TTS)
                          </label>
                          <Input
                            value={s.narration ?? s.caption}
                            aria-label={`Scene ${i + 1} narration`}
                            onChange={(e) =>
                              update({
                                ...p,
                                scenes: p.scenes.map((x) =>
                                  x.id === s.id ? { ...x, narration: e.target.value } : x,
                                ),
                              })
                            }
                            className="text-xs"
                          />
                        </div>
                      </div>

                      <div className="space-y-1">
                        <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                          Nano Banana / Painted 2D Anime Image Prompt (with Visual Bible)
                        </label>
                        <Textarea
                          value={s.imagePrompt ?? s.visual}
                          rows={2}
                          aria-label={`Scene ${i + 1} visual prompt`}
                          onChange={(e) =>
                            update({
                              ...p,
                              scenes: p.scenes.map((x) =>
                                x.id === s.id
                                  ? { ...x, visual: e.target.value, imagePrompt: e.target.value }
                                  : x,
                              ),
                            })
                          }
                          className="text-xs text-muted-foreground"
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* STEP 3: DEDICATED AUDIO STUDIO SECTION */}
          <section
            id="audio-studio"
            aria-label="Audio Studio"
            className="space-y-6 rounded-2xl border border-border bg-card p-6"
          >
            <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-4">
              <div>
                <div className="flex items-center gap-2">
                  <Sliders className="size-5 text-primary" />
                  <h2 className="font-display text-3xl">3. Audio Studio (Local Piper TTS &amp; Music Mix)</h2>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  100% offline local Piper TTS narration + your uploaded MP3/WAV background music library with automatic ducking and FFmpeg mixing.
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setShowSetupGuide((x) => !x)}
                className="gap-1.5 text-xs"
              >
                <Terminal className="size-3.5 text-primary" />
                {showSetupGuide ? "Hide Setup & Settings" : "Windows Setup & API Settings"}
              </Button>
            </div>

            {/* Required Clear Status Pills */}
            <div className="flex flex-wrap gap-2" data-testid="audio-status-bar">
              {ttsStatus?.ok ? (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-300">
                  <CheckCircle2 className="size-3.5" />
                  Local voice engine connected ({ttsStatus.voices} voices)
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-300">
                  <AlertTriangle className="size-3.5" />
                  Local voice engine unavailable
                </span>
              )}

              {voicing ? (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/15 px-3 py-1 text-xs font-medium text-primary">
                  <Loader2 className="size-3.5 animate-spin" />
                  Generating narration
                  {voicingProgress
                    ? ` (${voicingProgress.current}/${voicingProgress.total})`
                    : "…"}
                </span>
              ) : narratedCount > 0 ? (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-300">
                  <CheckCircle2 className="size-3.5" />
                  Narration ready ({narratedCount}/{p.scenes.length} scenes)
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary/60 px-3 py-1 text-xs text-muted-foreground">
                  <Mic className="size-3.5" />
                  Narration not generated yet
                </span>
              )}

              {musicLibrary.length > 0 && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-300">
                  <FileAudio className="size-3.5" />
                  Music uploaded ({musicLibrary.length} track{musicLibrary.length === 1 ? "" : "s"})
                </span>
              )}

              {selectedMusicTrack && p.musicEnabled !== false && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/15 px-3 py-1 text-xs font-medium text-primary">
                  <Music className="size-3.5" />
                  Music selected: {selectedMusicTrack.name}
                </span>
              )}

              {isAudioMixReady && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-300">
                  <Sparkles className="size-3.5" />
                  Audio mixing complete
                </span>
              )}
            </div>

            {/* Windows Setup & Troubleshooting Drawer */}
            {(showSetupGuide || !ttsStatus?.ok) && (
              <div className="rounded-xl border border-primary/30 bg-background/80 p-4 text-xs space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 font-medium text-foreground">
                    <HelpCircle className="size-4 text-primary" />
                    <span>Local Service, Gemini Key &amp; Windows Setup</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      value={serviceUrlInput}
                      onChange={(e) => setServiceUrlInput(e.target.value)}
                      placeholder="http://127.0.0.1:5005"
                      aria-label="Local TTS localhost URL"
                      className="h-7 w-44 text-xs"
                    />
                    <Input
                      type="password"
                      value={geminiApiKeyInput}
                      onChange={(e) => setGeminiApiKeyInput(e.target.value)}
                      placeholder="Optional: GEMINI_API_KEY"
                      aria-label="Server GEMINI_API_KEY"
                      className="h-7 w-44 text-xs"
                    />
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={checkingTts}
                      onClick={async () => {
                        setLocalTtsBaseUrl(serviceUrlInput);
                        if (geminiApiKeyInput.trim()) {
                          await updatePlatformSettings(
                            { geminiApiKey: geminiApiKeyInput.trim() },
                            serviceUrlInput,
                          );
                          setGeminiApiKeyInput("");
                        }
                        await refreshLocalTts(serviceUrlInput);
                      }}
                    >
                      {checkingTts ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="size-3.5" />
                      )}
                      Save &amp; Check Service
                    </Button>
                  </div>
                </div>
                {!ttsStatus?.ok && (
                  <p className="text-amber-300/90">
                    {ttsError ??
                      ttsStatus?.message ??
                      "Local service is not reachable at http://127.0.0.1:5005. Start the companion FastAPI service on your PC:"}
                  </p>
                )}
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="rounded-lg border border-border bg-card p-3 space-y-1.5">
                    <p className="font-semibold text-foreground">Step 1 — One-Time Install (Windows)</p>
                    <pre className="overflow-x-auto rounded bg-background p-2 font-mono text-[11px] text-primary">
                      cd local-tts{"\n"}install.bat
                    </pre>
                    <p className="text-[11px] text-muted-foreground">
                      Installs <code>piper-tts</code>, <code>playwright</code> (Chromium), <code>google-genai</code>, and downloads 6 English male/female voices.
                    </p>
                  </div>
                  <div className="rounded-lg border border-border bg-card p-3 space-y-1.5">
                    <p className="font-semibold text-foreground">Step 2 — Start Local Service</p>
                    <pre className="overflow-x-auto rounded bg-background p-2 font-mono text-[11px] text-primary">
                      cd local-tts{"\n"}start.bat
                    </pre>
                    <p className="text-[11px] text-muted-foreground">
                      Starts FastAPI on <code>http://127.0.0.1:5005</code> for Piper TTS, Playwright Google Flow, and FFmpeg rendering.
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* PANEL A: VOICEOVER (LOCAL PIPER TTS) */}
            <div className="space-y-4 rounded-xl border border-border bg-background/50 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Mic className="size-4 text-primary" />
                  <h3 className="text-sm font-semibold uppercase tracking-wider text-foreground">
                    Voiceover — Gemini TTS Voice Clone &amp; Local Piper TTS
                  </h3>
                </div>
                <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={p.voiceEnabled !== false}
                    onChange={(e) => update({ ...p, voiceEnabled: e.target.checked })}
                    className="accent-primary"
                  />
                  Enable voiceover in mix
                </label>
              </div>

              {/* Quick Select Voice Clone & Studio Presets */}
              <div className="space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                  Quick Select Cloned Voice &amp; Narrator Presets
                </span>
                <div className="grid gap-2 sm:grid-cols-3" data-testid="voice-clone-presets">
                  {[
                    {
                      id: "gemini:clone_whayrs_male",
                      title: "@W.hayrs Video Voice Clone",
                      sub: "Warm British Male · Gemini TTS (Default)",
                      gender: "male" as const,
                    },
                    {
                      id: "gemini:clone_reference",
                      title: "'Words Hold Power' Voice Clone",
                      sub: "Calm Reflective Female · Gemini TTS",
                      gender: "female" as const,
                    },
                    {
                      id: "en_GB-alan-medium",
                      title: "Alan (Offline British Male)",
                      sub: "Local Offline Piper TTS · No API needed",
                      gender: "male" as const,
                    },
                  ].map((preset) => {
                    const active = (selectedVoiceObj?.id ?? p.voiceId) === preset.id;
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() => {
                          update(
                            { ...p, voiceId: preset.id, voiceGender: "all", voiceLanguage: "all" },
                            { selectedVoiceId: preset.id },
                          );
                          toast.success(`Selected voice: ${preset.title}`);
                        }}
                        className={`flex flex-col items-start rounded-lg border p-2.5 text-left transition ${
                          active
                            ? "border-primary bg-primary/15 text-foreground"
                            : "border-border bg-card/70 text-muted-foreground hover:border-border/80 hover:text-foreground"
                        }`}
                      >
                        <span className="text-xs font-semibold text-foreground">{preset.title}</span>
                        <span className="mt-0.5 text-[11px] text-muted-foreground">{preset.sub}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground" htmlFor="voice-lang-select">
                    Language
                  </label>
                  <select
                    id="voice-lang-select"
                    aria-label="Voice language"
                    value={p.voiceLanguage ?? "all"}
                    onChange={(e) => {
                      const nextLang = e.target.value;
                      update({ ...p, voiceLanguage: nextLang }, { voiceLanguage: nextLang });
                    }}
                    className="h-9 w-full rounded-md border border-input bg-background px-2.5 text-xs"
                  >
                    <option value="all">All English &amp; Installed</option>
                    {availableLanguages.map(([code, label]) => (
                      <option key={code} value={code}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground" htmlFor="voice-gender-select">
                    Gender
                  </label>
                  <select
                    id="voice-gender-select"
                    aria-label="Voice gender"
                    value={p.voiceGender ?? "all"}
                    onChange={(e) => {
                      const nextGender = e.target.value as "all" | "male" | "female";
                      update({ ...p, voiceGender: nextGender }, { voiceGender: nextGender });
                    }}
                    className="h-9 w-full rounded-md border border-input bg-background px-2.5 text-xs"
                  >
                    <option value="all">All Genders (Male &amp; Female)</option>
                    <option value="male">Male Voices</option>
                    <option value="female">Female Voices</option>
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground" htmlFor="voice-model-select">
                    Piper Voice Model
                  </label>
                  <select
                    id="voice-model-select"
                    aria-label="Select local voice"
                    value={selectedVoiceObj?.id ?? p.voiceId ?? ""}
                    onChange={(e) =>
                      update({ ...p, voiceId: e.target.value }, { selectedVoiceId: e.target.value })
                    }
                    disabled={filteredVoices.length === 0}
                    className="h-9 w-full rounded-md border border-input bg-background px-2.5 text-xs"
                  >
                    {filteredVoices.length === 0 ? (
                      <option value="">
                        {ttsStatus?.ok
                          ? "No voices match filter"
                          : "Connect local Piper TTS to load voices"}
                      </option>
                    ) : (
                      filteredVoices.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name} · {v.gender === "male" ? "Male" : v.gender === "female" ? "Female" : "Voice"} · {v.language}
                        </option>
                      ))
                    )}
                  </select>
                </div>
              </div>

              {selectedVoiceObj?.description && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-primary/25 bg-primary/5 px-3 py-2 text-xs">
                  <p className="text-muted-foreground">
                    <span className="font-medium text-foreground">{selectedVoiceObj.name}:</span>{" "}
                    {selectedVoiceObj.description}
                    {p.referenceVoiceName ? ` (Custom clone sample: ${p.referenceVoiceName})` : " (Pre-loaded with your 'Words hold power' reference voice)"}
                  </p>
                  <div className="flex items-center gap-2">
                    <input
                      ref={refVoiceUploadRef}
                      type="file"
                      accept=".mp3,.wav,.m4a,audio/*"
                      aria-label="Upload reference voice clip for cloning"
                      onChange={(e) => handleUploadReferenceVoice(e.target.files?.[0])}
                      className="hidden"
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={uploadingRefVoice}
                      onClick={() => refVoiceUploadRef.current?.click()}
                    >
                      {uploadingRefVoice ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5 text-primary" />}
                      {p.referenceVoiceName ? "Change Clone Sample" : "Upload Custom Voice Sample"}
                    </Button>
                  </div>
                </div>
              )}

              <div className="space-y-1.5">
                <span className="text-xs text-muted-foreground">Watermark (shown under the caption)</span>
                <input
                  type="text"
                  aria-label="Watermark handle"
                  placeholder="@yourhandle"
                  maxLength={40}
                  value={p.watermark ?? ""}
                  onChange={(e) => update({ ...p, watermark: e.target.value })}
                  className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground"
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Narration Speed</span>
                    <span className="font-mono font-medium text-foreground">
                      {(p.voiceSpeed ?? 0.9).toFixed(2)}×
                    </span>
                  </div>
                  <input
                    type="range"
                    aria-label="Narration speed"
                    min={0.5}
                    max={1.5}
                    step={0.05}
                    value={p.voiceSpeed ?? 0.9}
                    onChange={(e) => {
                      const spd = Number(e.target.value);
                      update({ ...p, voiceSpeed: spd }, { voiceSpeed: spd });
                    }}
                    className="w-full accent-primary"
                  />
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Voiceover Volume</span>
                    <span className="font-mono font-medium text-foreground">
                      {p.voiceVolume ?? DEFAULT_VOICE_VOLUME}%
                    </span>
                  </div>
                  <input
                    type="range"
                    aria-label="Voiceover volume"
                    min={0}
                    max={100}
                    step={1}
                    value={p.voiceVolume ?? DEFAULT_VOICE_VOLUME}
                    onChange={(e) => {
                      const vol = Number(e.target.value);
                      update({ ...p, voiceVolume: vol }, { voiceVolume: vol });
                    }}
                    className="w-full accent-primary"
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={previewingVoice || voicing}
                  onClick={handlePreviewVoice}
                >
                  {previewingVoice ? <Loader2 className="animate-spin" /> : <Play />}
                  Preview Voice
                </Button>

                <Button type="button" size="sm" disabled={voicing} onClick={generateAllNarration}>
                  {voicing ? <Loader2 className="animate-spin" /> : <Mic />}
                  {voicing
                    ? `Generating (${voicingProgress?.current ?? 1}/${voicingProgress?.total ?? p.scenes.length})…`
                    : narratedCount > 0
                      ? "Regenerate Voiceover"
                      : "Generate Voiceover"}
                </Button>

                {narratedCount > 0 && (
                  <>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={handlePlayNarrationWav}
                    >
                      {playingNarration ? <Pause /> : <Play />}
                      {playingNarration ? "Pause Narration" : "Play Narration"}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={handleDownloadNarrationWav}
                    >
                      <Download />
                      Download WAV
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-label="Remove voiceover"
                      onClick={() => {
                        stopAllStandaloneAudio();
                        update({
                          ...p,
                          narrationWav: undefined,
                          narrationDuration: undefined,
                          scenes: p.scenes.map((s) => ({
                            ...s,
                            voice: undefined,
                            voiceDuration: undefined,
                          })),
                        });
                      }}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </>
                )}
              </div>
              {allNarrated && (
                <p className="text-[11px] text-emerald-300/90">
                  All {p.scenes.length} scene narrations are synthesized as local offline WAV audio and aligned to the {vidDuration}s video timeline.
                </p>
              )}
            </div>

            {/* PANEL B: BACKGROUND MUSIC LIBRARY (USER-UPLOADED) */}
            <div className="space-y-4 rounded-xl border border-border bg-background/50 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Music className="size-4 text-primary" />
                  <h3 className="text-sm font-semibold uppercase tracking-wider text-foreground">
                    Background Music Library — User Uploaded
                  </h3>
                </div>
                <div className="flex items-center gap-3">
                  <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={p.musicEnabled !== false}
                      onChange={(e) => update({ ...p, musicEnabled: e.target.checked })}
                      className="accent-primary"
                    />
                    Enable music in mix
                  </label>
                  <input
                    ref={musicUploadRef}
                    type="file"
                    accept=".mp3,.wav,.m4a,audio/mpeg,audio/wav,audio/mp4,audio/x-m4a"
                    multiple
                    aria-label="Upload background music file"
                    onChange={(e) => handleUploadMusicFiles(e.target.files)}
                    className="hidden"
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={uploadingMusic}
                    onClick={() => musicUploadRef.current?.click()}
                  >
                    {uploadingMusic ? <Loader2 className="animate-spin" /> : <Upload />}
                    Upload Music (MP3 / WAV / M4A)
                  </Button>
                </div>
              </div>

              {musicError && (
                <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {musicError}
                </div>
              )}

              {musicLibrary.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border p-6 text-center">
                  <FileAudio className="mx-auto size-7 text-muted-foreground" />
                  <p className="mt-2 text-xs font-medium text-foreground">
                    Your Background Music Library is empty
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Upload your own MP3, WAV, or M4A tracks. They are stored locally in IndexedDB and reusable across all projects.
                  </p>
                </div>
              ) : (
                <div className="space-y-2 max-h-60 overflow-y-auto pr-1" data-testid="music-library-list">
                  {musicLibrary.map((track) => {
                    const isSelected = p.selectedMusicId === track.id;
                    const isPreviewing = previewTrackId === track.id;
                    return (
                      <div
                        key={track.id}
                        className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border p-2.5 text-xs transition ${
                          isSelected
                            ? "border-primary bg-primary/10"
                            : "border-border bg-card hover:border-border/80"
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate font-medium text-foreground">{track.name}</span>
                            <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-semibold uppercase text-secondary-foreground">
                              {track.format}
                            </span>
                            <span className="font-mono text-muted-foreground">
                              {formatDuration(track.duration)}
                            </span>
                          </div>
                          <p className="mt-0.5 text-[11px] text-muted-foreground">
                            {track.duration >= vidDuration
                              ? `Auto-fits ${vidDuration}s section from ${formatDuration(track.duration)} track`
                              : `Shorter than ${vidDuration}s video (${formatDuration(track.duration)})`}
                          </p>
                        </div>

                        <div className="flex items-center gap-1.5">
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            aria-label={isPreviewing ? `Pause ${track.name}` : `Preview ${track.name}`}
                            onClick={() => handlePreviewLibraryTrack(track)}
                          >
                            {isPreviewing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
                            {isPreviewing ? "Pause" : "Preview"}
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant={isSelected ? "default" : "secondary"}
                            onClick={() => handleSelectMusicTrack(track.id)}
                          >
                            {isSelected ? "Selected" : "Use Track"}
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            aria-label={`Delete ${track.name}`}
                            onClick={() => handleDeleteMusicTrack(track)}
                            className="text-muted-foreground hover:text-destructive"
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {selectedMusicTrack && isSelectedMusicShort && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 space-y-2 text-xs">
                  <p className="font-medium text-amber-200">
                    Selected track ({formatDuration(selectedMusicTrack.duration)}) is shorter than the {vidDuration}s video. Choose how to handle timing:
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {(
                      [
                        ["loop", "Loop track smoothly"],
                        ["change", "Use another uploaded track"],
                        ["none", "Continue without music"],
                      ] as const
                    ).map(([val, label]) => (
                      <Button
                        key={val}
                        type="button"
                        size="sm"
                        variant={(p.shortTrackBehavior ?? "loop") === val ? "default" : "outline"}
                        onClick={() => {
                          const nextBehavior: ShortTrackBehavior = val;
                          update(
                            {
                              ...p,
                              shortTrackBehavior: nextBehavior,
                              musicEnabled: nextBehavior === "none" ? false : true,
                            },
                            { shortTrackBehavior: nextBehavior },
                          );
                          if (val === "change") {
                            musicUploadRef.current?.click();
                          }
                        }}
                      >
                        {label}
                      </Button>
                    ))}
                  </div>
                </div>
              )}

              <div className="grid gap-4 sm:grid-cols-3 pt-1">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Music Volume</span>
                    <span className="font-mono font-medium text-foreground">
                      {p.musicVolume ?? DEFAULT_MUSIC_VOLUME}%
                    </span>
                  </div>
                  <input
                    type="range"
                    aria-label="Background music volume"
                    min={0}
                    max={100}
                    step={1}
                    value={p.musicVolume ?? DEFAULT_MUSIC_VOLUME}
                    onChange={(e) => {
                      const vol = Number(e.target.value);
                      update({ ...p, musicVolume: vol }, { musicVolume: vol });
                    }}
                    className="w-full accent-primary"
                  />
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Fade-In</span>
                    <span className="font-mono font-medium text-foreground">
                      {(p.musicFadeIn ?? DEFAULT_FADE_IN).toFixed(1)}s
                    </span>
                  </div>
                  <input
                    type="range"
                    aria-label="Music fade-in seconds"
                    min={0}
                    max={5}
                    step={0.1}
                    value={p.musicFadeIn ?? DEFAULT_FADE_IN}
                    onChange={(e) => {
                      const fi = Number(e.target.value);
                      update({ ...p, musicFadeIn: fi }, { musicFadeIn: fi });
                    }}
                    className="w-full accent-primary"
                  />
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Fade-Out</span>
                    <span className="font-mono font-medium text-foreground">
                      {(p.musicFadeOut ?? DEFAULT_FADE_OUT).toFixed(1)}s
                    </span>
                  </div>
                  <input
                    type="range"
                    aria-label="Music fade-out seconds"
                    min={0}
                    max={5}
                    step={0.1}
                    value={p.musicFadeOut ?? DEFAULT_FADE_OUT}
                    onChange={(e) => {
                      const fo = Number(e.target.value);
                      update({ ...p, musicFadeOut: fo }, { musicFadeOut: fo });
                    }}
                    className="w-full accent-primary"
                  />
                </div>
              </div>
            </div>

            {/* PANEL C: AUDIO MIX & AUTOMATIC DUCKING */}
            <div className="space-y-4 rounded-xl border border-border bg-background/50 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Volume2 className="size-4 text-primary" />
                  <h3 className="text-sm font-semibold uppercase tracking-wider text-foreground">
                    Audio Mix &amp; Automatic Ducking
                  </h3>
                </div>
                <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium text-foreground">
                  <input
                    type="checkbox"
                    aria-label="Enable automatic music ducking"
                    checked={p.duckingEnabled !== false}
                    onChange={(e) =>
                      update(
                        { ...p, duckingEnabled: e.target.checked },
                        { duckingEnabled: e.target.checked },
                      )
                    }
                    className="accent-primary"
                  />
                  Automatic music ducking (reduce to {p.duckingLevel ?? DEFAULT_DUCKING_LEVEL}% during speech)
                </label>
              </div>

              {p.duckingEnabled !== false && (
                <div className="grid gap-4 sm:grid-cols-2 items-center">
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">
                        Ducked Music Level During Narration (8–12%)
                      </span>
                      <span className="font-mono font-medium text-primary">
                        {p.duckingLevel ?? DEFAULT_DUCKING_LEVEL}%
                      </span>
                    </div>
                    <input
                      type="range"
                      aria-label="Ducked music volume level"
                      min={8}
                      max={12}
                      step={1}
                      value={p.duckingLevel ?? DEFAULT_DUCKING_LEVEL}
                      onChange={(e) => {
                        const lvl = Number(e.target.value);
                        update({ ...p, duckingLevel: lvl }, { duckingLevel: lvl });
                      }}
                      className="w-full accent-primary"
                    />
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    When local narration plays, background music smoothly ducks from{" "}
                    <strong>{p.musicVolume ?? DEFAULT_MUSIC_VOLUME}%</strong> down to{" "}
                    <strong>{p.duckingLevel ?? DEFAULT_DUCKING_LEVEL}%</strong>, then gradually restores when narration pauses.
                  </p>
                </div>
              )}

              <DuckingEnvelopeBar project={p} />

              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={handleToggleCombinedMix}
                >
                  {playingCombinedMix ? <Pause /> : <Play />}
                  {playingCombinedMix ? "Stop Combined Audio" : "Play Combined Audio"}
                </Button>

                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    stopAllStandaloneAudio();
                    setVideoPlayTrigger((c) => c + 1);
                  }}
                >
                  <Play />
                  Preview Complete Video with Audio
                </Button>

                <div className="ml-auto flex items-center gap-2">
                  <label className="text-xs text-muted-foreground" htmlFor="export-audio-mode">
                    Export Track Mode:
                  </label>
                  <select
                    id="export-audio-mode"
                    aria-label="Export audio mode"
                    value={p.exportAudioMode ?? "both"}
                    onChange={(e) =>
                      update({ ...p, exportAudioMode: e.target.value as ExportAudioMode })
                    }
                    className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                  >
                    <option value="both">Voiceover + Background Music</option>
                    <option value="voice">Voiceover Only</option>
                    <option value="music">Background Music Only</option>
                    <option value="none">Without Audio (Muted)</option>
                  </select>
                </div>
              </div>
            </div>
          </section>
        </div>

        {/* RIGHT COLUMN: Synchronized 9:16 Video Preview & FFmpeg Export Studio */}
        <div className="lg:sticky lg:top-8 lg:self-start space-y-4">
          <Player
            project={p}
            externalPlayTrigger={videoPlayTrigger}
            onStartPlay={stopAllStandaloneAudio}
          />

          <div className="rounded-xl border border-border bg-card p-4 space-y-3">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-foreground">4. Export Studio ({(p.aspectRatio ?? "9:16") === "16:9" ? "1920×1080 16:9" : "1080×1920 9:16"} · 30 FPS)</span>
              <span className="rounded bg-primary/15 px-2 py-0.5 font-mono text-[11px] text-primary">
                H.264 + AAC · yuv420p
              </span>
            </div>

            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="text-muted-foreground">Rendering Engine:</span>
              <select
                value={exportMethod}
                onChange={(e) => setExportMethod(e.target.value as "ffmpeg" | "browser")}
                className="h-7 rounded border border-input bg-background px-2 text-xs"
              >
                <option value="ffmpeg">
                  FFmpeg + FFprobe (1080×1920 H.264/AAC +faststart)
                </option>
                <option value="browser">Browser MediaRecorder Fallback</option>
              </select>
            </div>

            <Button
              className="w-full"
              size="lg"
              disabled={!allPainted || exporting !== null}
              onClick={() => doExport()}
            >
              {exporting !== null ? <Loader2 className="animate-spin" /> : <Download />}
              {exporting !== null
                ? `Rendering ${(p.aspectRatio ?? "9:16") === "16:9" ? "1920×1080" : "1080×1920"} MP4 (${Math.round(exporting * 100)}%)…`
                : `Export ${(p.aspectRatio ?? "9:16") === "16:9" ? "1920×1080 (16:9)" : "1080×1920 (9:16)"} MP4 Video`}
            </Button>

            {exporting !== null && <Progress value={exporting * 100} className="mt-2" />}
            {!allPainted && (
              <p className="text-center text-xs text-amber-300/90">
                Generate or upload every scene image ({p.scenes.filter((s) => s.image).length}/{p.scenes.length} ready) to unlock MP4 export.
              </p>
            )}

            {/* FFprobe Verification Report */}
            {p.lastExportReport && (
              <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-[11px] space-y-1">
                <div className="flex items-center gap-1.5 font-semibold text-emerald-300">
                  <CheckCircle2 className="size-3.5" />
                  <span>FFprobe Verified Export</span>
                </div>
                <p className="text-muted-foreground">
                  Codec: <strong className="text-foreground">{p.lastExportReport.video_codec.toUpperCase()}</strong> ({p.lastExportReport.pixel_format}) · Audio:{" "}
                  <strong className="text-foreground">{p.lastExportReport.audio_codec?.toUpperCase() ?? "Muted"}</strong> ·{" "}
                  {p.lastExportReport.width}×{p.lastExportReport.height} ({p.lastExportReport.aspect_ratio}) @ {p.lastExportReport.fps} FPS ·{" "}
                  {p.lastExportReport.duration_seconds}s · faststart:{" "}
                  {p.lastExportReport.faststart_verified ? "Yes" : "No"}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function DuckingEnvelopeBar({ project }: { project: Project }) {
  const total = totalDuration(project);
  const dims = getVideoDimensions(project.aspectRatio ?? "9:16");
  const intervals = useMemo(() => getSpeechIntervals(project), [project]);
  const samples = useMemo(() => {
    const count = 48;
    const out: number[] = [];
    for (let i = 0; i < count; i++) {
      const t = (i / (count - 1)) * total;
      out.push(computeEffectiveMusicGainAtTime(t, total, project, intervals, project.voiceEnabled !== false));
    }
    return out;
  }, [project, total, intervals]);

  return (
    <div className="rounded-lg border border-border bg-card/60 p-2.5 space-y-1.5">
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>Music Gain &amp; Ducking Timeline ({total}s)</span>
        <span>
          Normal: {project.musicVolume ?? DEFAULT_MUSIC_VOLUME}% · Ducked:{" "}
          {project.duckingEnabled !== false ? `${project.duckingLevel ?? DEFAULT_DUCKING_LEVEL}%` : "Off"}
        </span>
      </div>
      <div className="flex h-8 items-end gap-0.5">
        {samples.map((val, idx) => {
          const maxScale = Math.max(0.25, (project.musicVolume ?? DEFAULT_MUSIC_VOLUME) / 100);
          const pct = Math.max(8, Math.min(100, Math.round((val / maxScale) * 100)));
          return (
            <div
              key={idx}
              style={{ height: `${pct}%` }}
              className="flex-1 rounded-t bg-primary/70 transition-all"
              title={`t=${((idx / (samples.length - 1)) * total).toFixed(1)}s: ${(val * 100).toFixed(1)}% music gain`}
            />
          );
        })}
      </div>
    </div>
  );
}

function Player({
  project,
  externalPlayTrigger,
  onStartPlay,
}: {
  project: Project;
  externalPlayTrigger: number;
  onStartPlay: () => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [muted, setMuted] = useState(false);
  const [masterVol, setMasterVol] = useState(100);

  const imgsRef = useRef<(HTMLImageElement | null)[]>([]);
  const tRef = useRef(0);
  const actxRef = useRef<AudioContext | null>(null);
  const bufsRef = useRef<AudioBuffers>({ music: null, voices: [], musicTrackDuration: 0 });
  const playbackRef = useRef<ActiveAudioPlayback | null>(null);

  const total = totalDuration(project);
  const dims = getVideoDimensions(project.aspectRatio ?? "9:16");
  const imageKey = project.scenes.map((s) => `${s.id}:${s.image?.length ?? 0}`).join("|");
  const audioKey = [
    project.selectedMusicId ?? "",
    project.music?.length ?? 0,
    ...project.scenes.map((s) => `${s.id}:${s.voice?.length ?? 0}`),
  ].join("|");

  useEffect(() => {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!actxRef.current) actxRef.current = new Ctx();
    loadAudio(actxRef.current, project).then((b) => {
      bufsRef.current = b;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioKey]);

  useEffect(() => {
    loadImages(project.scenes).then((imgs) => {
      imgsRef.current = imgs;
      document.fonts.load("500 58px Kalam").then(() => {
        const ctx = ref.current?.getContext("2d");
        if (ctx) drawFrame(ctx, project.scenes, imgs, tRef.current, { watermark: project.watermark });
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageKey]);

  useEffect(() => {
    if (!playing) {
      const ctx = ref.current?.getContext("2d");
      if (ctx) drawFrame(ctx, project.scenes, imgsRef.current, tRef.current, { watermark: project.watermark });
    }
  }, [project.scenes, project.aspectRatio, playing]);

  useEffect(() => {
    if (externalPlayTrigger > 0) {
      tRef.current = 0;
      setCurrentTime(0);
      setPlaying(true);
    }
  }, [externalPlayTrigger]);

  useEffect(() => {
    if (!playing || !actxRef.current) return;
    onStartPlay();
    const ctx = actxRef.current;
    ctx.resume().catch(() => {});
    const effVol = muted ? 0 : masterVol / 100;
    const pb = playAudioWithControls(ctx, ctx.destination, project, bufsRef.current, tRef.current, {
      mode: project.exportAudioMode ?? "both",
      masterVolume: effVol,
    });
    playbackRef.current = pb;
    return () => {
      pb.stop();
      playbackRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    playing,
    audioKey,
    project.voiceVolume,
    project.voiceEnabled,
    project.musicVolume,
    project.musicEnabled,
    project.musicFadeIn,
    project.musicFadeOut,
    project.musicStartOffset,
    project.shortTrackBehavior,
    project.duckingEnabled,
    project.duckingLevel,
    project.exportAudioMode,
  ]);

  useEffect(() => {
    const effVol = muted ? 0 : masterVol / 100;
    playbackRef.current?.setMasterVolume(effVol);
  }, [muted, masterVol]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      tRef.current += (now - last) / 1000;
      last = now;
      if (tRef.current >= total) {
        tRef.current = 0;
        setCurrentTime(0);
        setPlaying(false);
        const ctx = ref.current?.getContext("2d");
        if (ctx) drawFrame(ctx, project.scenes, imgsRef.current, 0, { watermark: project.watermark });
        return;
      }
      setCurrentTime(tRef.current);
      const ctx = ref.current?.getContext("2d");
      if (ctx) drawFrame(ctx, project.scenes, imgsRef.current, tRef.current, { watermark: project.watermark });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, project.scenes, total]);

  function handleSeek(nextT: number) {
    const clamped = Math.max(0, Math.min(total, nextT));
    tRef.current = clamped;
    setCurrentTime(clamped);
    const ctx = ref.current?.getContext("2d");
    if (ctx) drawFrame(ctx, project.scenes, imgsRef.current, clamped, { watermark: project.watermark });
    if (playing && actxRef.current) {
      playbackRef.current?.stop();
      const effVol = muted ? 0 : masterVol / 100;
      playbackRef.current = playAudioWithControls(
        actxRef.current,
        actxRef.current.destination,
        project,
        bufsRef.current,
        clamped,
        {
          mode: project.exportAudioMode ?? "both",
          masterVolume: effVol,
        },
      );
    }
  }

  function handleRestart() {
    handleSeek(0);
    setPlaying(true);
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-lg">
      <div className="group relative overflow-hidden bg-background">
        <canvas ref={ref} width={dims.width} height={dims.height} className={`block w-full ${(project.aspectRatio ?? "9:16") === "16:9" ? "aspect-video" : "aspect-[9/16]"}`} />
        <button
          type="button"
          onClick={() => setPlaying((x) => !x)}
          aria-label={playing ? "Pause preview" : "Play preview"}
          className="absolute inset-0 flex items-center justify-center bg-background/0 transition hover:bg-background/20"
        >
          <span
            className={`rounded-full bg-background/75 p-4 text-foreground shadow-md transition ${
              playing ? "opacity-0 group-hover:opacity-100" : ""
            }`}
          >
            {playing ? <Pause /> : <Play />}
          </span>
        </button>
      </div>

      <div className="space-y-2.5 border-t border-border bg-card p-3.5">
        <div className="flex items-center gap-2">
          <input
            type="range"
            aria-label="Seek video timeline"
            min={0}
            max={Math.max(1, total)}
            step={0.1}
            value={Math.min(total, currentTime)}
            onChange={(e) => handleSeek(Number(e.target.value))}
            className="flex-1 accent-primary"
          />
          <span className="w-24 text-right font-mono text-[11px] text-muted-foreground">
            {currentTime.toFixed(1)}s / {total.toFixed(1)}s
          </span>
        </div>

        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              aria-label={playing ? "Pause" : "Play"}
              onClick={() => setPlaying((x) => !x)}
            >
              {playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
              {playing ? "Pause" : "Play"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label="Restart video"
              onClick={handleRestart}
              title="Restart from 0:00"
            >
              <RotateCcw className="size-3.5" />
            </Button>
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label={muted ? "Unmute preview" : "Mute preview"}
              onClick={() => setMuted((m) => !m)}
            >
              {muted || masterVol === 0 ? (
                <VolumeX className="size-4 text-muted-foreground" />
              ) : (
                <Volume2 className="size-4 text-primary" />
              )}
            </Button>
            <input
              type="range"
              aria-label="Preview master volume"
              min={0}
              max={100}
              step={1}
              value={muted ? 0 : masterVol}
              onChange={(e) => {
                const v = Number(e.target.value);
                setMasterVol(v);
                if (v > 0 && muted) setMuted(false);
              }}
              className="w-20 accent-primary"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
