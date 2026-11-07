import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { generateScript, type StructuredScriptOutput } from "@/lib/studio.functions";
import {
  DEFAULT_DUCKING_LEVEL,
  DEFAULT_FADE_IN,
  DEFAULT_FADE_OUT,
  DEFAULT_MUSIC_VOLUME,
  DEFAULT_VOICE_VOLUME,
  getAudioPreferences,
  saveProject,
  uid,
} from "@/lib/projects";
import { generateScriptViaLocalService } from "@/lib/local-tts";

export const Route = createFileRoute("/create")({
  head: () => ({
    meta: [
      { title: "Create video — Cinematic Studio" },
      { name: "description", content: "Describe your motivational message and let Gemini write the structured script and Visual Bible." },
      { property: "og:title", content: "Create video — Cinematic Studio" },
      { property: "og:description", content: "Describe your motivational message and let Gemini write the structured script and Visual Bible." },
    ],
  }),
  component: Create,
});

const CATEGORIES = [
  "Motivation",
  "Discipline",
  "Self-improvement",
  "Mental strength",
  "Life lessons",
  "Faith and hope",
  "Relationships",
  "Success",
  "Personal growth",
];

function computeSceneCountForDuration(durationSec: number): number {
  // Reference reels: one short spoken phrase per image, about 3 seconds each (21s -> 7 scenes).
  return Math.max(3, Math.min(12, Math.round(durationSec / 3.0)));
}

function Create() {
  const nav = useNavigate();
  const genServer = useServerFn(generateScript);
  const [f, setF] = useState({
    title: "",
    topic: "",
    message: "",
    story: "",
    audience: "",
    language: "English",
    category: "Motivation",
    duration: 21,
    aspectRatio: "9:16" as "9:16" | "16:9",
    model: "gemini-3.5-flash",
  });
  const [busy, setBusy] = useState(false);
  const up =
    (k: keyof typeof f) => (e: { target: { value: string } }) =>
      setF({ ...f, [k]: k === "duration" ? Number(e.target.value) : e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const sceneCount = computeSceneCountForDuration(f.duration);

    let structured: StructuredScriptOutput | null = null;
    let errMsg = "";

    // 1. Try local Python Gemini service (/api/gemini/script) first
    const localRes = await generateScriptViaLocalService({
      title: f.title,
      category: f.category,
      topic: f.topic,
      message: f.message,
      story: f.story,
      audience: f.audience,
      language: f.language,
      duration_seconds: f.duration,
      aspect_ratio: f.aspectRatio,
      scene_count: sceneCount,
      model: f.model,
    });

    if (localRes.ok) {
      structured = localRes.script;
    } else if (localRes.code && localRes.code !== "BACKEND_UNREACHABLE" && localRes.code !== "GEMINI_NOT_CONFIGURED") {
      // Explicit Gemini API error (e.g. invalid key or quota exceeded)
      errMsg = localRes.error;
    } else {
      // 2. Fallback to TanStack server function
      const srvRes = await genServer({
        data: { ...f, sceneCount },
      }).catch((err: Error) => ({ ok: false as const, error: err.message }));
      if (srvRes.ok) {
        structured = srvRes;
      } else {
        errMsg = srvRes.error;
      }
    }

    setBusy(false);
    if (!structured) {
      toast.error(errMsg || "Failed to generate script with Gemini.");
      return;
    }

    const id = uid();
    const prefs = await getAudioPreferences();
    await saveProject({
      id,
      title: f.title.trim() || structured.title,
      topic: f.topic,
      aspectRatio: f.aspectRatio,
      theme: structured.theme,
      message: f.message,
      story: f.story,
      audience: f.audience,
      language: f.language,
      category: f.category,
      visualStyle: structured.visual_style || "cinematic painted 2D anime",
      narrationScript: structured.narration,
      visualBible: structured.visual_bible,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      scenes: structured.scenes.map((s, idx) => {
        const dur = Math.max(1.5, Math.round((s.end_time - s.start_time) * 10) / 10);
        return {
          id: uid(),
          sceneNumber: s.scene_number ?? idx + 1,
          startTime: s.start_time,
          endTime: s.end_time,
          caption: s.caption,
          narration: s.narration || s.caption,
          visual: s.visual_description,
          imagePrompt: s.image_prompt,
          cameraMovement: s.camera_movement || "slow zoom in",
          transition: s.transition || "fade",
          imageStatus: "idle",
          duration: dur,
        };
      }),
      voiceEngine: prefs.voiceEngine ?? "gemini",
      voiceId: prefs.selectedVoiceId ?? "gemini:clone_whayrs_male",
      watermark: "@W.hayrs",
      voiceLanguage: prefs.voiceLanguage ?? "all",
      voiceGender: prefs.voiceGender ?? "all",
      voiceSpeed: prefs.voiceSpeed ?? 1.0,
      voiceVolume: prefs.voiceVolume ?? DEFAULT_VOICE_VOLUME,
      voiceEnabled: true,
      selectedMusicId: prefs.selectedMusicId,
      musicEnabled: true,
      musicVolume: prefs.musicVolume ?? DEFAULT_MUSIC_VOLUME,
      musicFadeIn: prefs.musicFadeIn ?? DEFAULT_FADE_IN,
      musicFadeOut: prefs.musicFadeOut ?? DEFAULT_FADE_OUT,
      musicStartOffset: 0,
      shortTrackBehavior: prefs.shortTrackBehavior ?? "loop",
      duckingEnabled: prefs.duckingEnabled ?? true,
      duckingLevel: prefs.duckingLevel ?? DEFAULT_DUCKING_LEVEL,
      exportAudioMode: "both",
    });
    nav({ to: "/project/$id", params: { id } });
  }

  return (
    <form onSubmit={submit} className="mx-auto max-w-2xl space-y-5 p-6 md:p-10">
      <h1 className="font-display text-5xl">New video</h1>
      <p className="text-sm text-muted-foreground">
        Step 1 — Enter your motivational message. Google Gemini generates a structured script, connected captions, narration, and a Visual Bible for Google Flow / Nano Banana.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label>Video title (optional)</Label>
          <Input value={f.title} onChange={up("title")} placeholder="Better Days Are Coming" />
        </div>
        <div className="space-y-2">
          <Label>Category</Label>
          <select
            value={f.category}
            onChange={up("category")}
            className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
          >
            {CATEGORIES.map((c) => (
              <option key={c} className="bg-popover">
                {c}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="space-y-2">
        <Label>Topic *</Label>
        <Input required value={f.topic} onChange={up("topic")} placeholder="Staying strong when life gets hard" />
      </div>
      <div className="space-y-2">
        <Label>Main message *</Label>
        <Textarea
          required
          value={f.message}
          onChange={up("message")}
          placeholder="The hardest battle is with yourself — keep going, better days are coming."
        />
      </div>
      <div className="space-y-2">
        <Label>Story idea (optional)</Label>
        <Textarea
          value={f.story}
          onChange={up("story")}
          placeholder="A solitary traveller walks through cold rain at dusk, then reaches a mountain ridge at sunrise."
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-5">
        <div className="space-y-2">
          <Label>Audience</Label>
          <Input value={f.audience} onChange={up("audience")} placeholder="Young adults" />
        </div>
        <div className="space-y-2">
          <Label>Language</Label>
          <Input value={f.language} onChange={up("language")} />
        </div>
        <div className="space-y-2">
          <Label>Length (seconds)</Label>
          <Input type="number" min={12} max={60} value={f.duration} onChange={up("duration")} />
        </div>
        <div className="space-y-2">
          <Label>Video Format</Label>
          <select
            aria-label="Video aspect ratio"
            value={f.aspectRatio}
            onChange={up("aspectRatio")}
            className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-xs"
          >
            <option value="9:16" className="bg-popover">
              9:16 Vertical (Default)
            </option>
            <option value="16:9" className="bg-popover">
              16:9 Widescreen
            </option>
          </select>
        </div>
        <div className="space-y-2">
          <Label>Gemini Model</Label>
          <select
            value={f.model}
            onChange={up("model")}
            className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-xs"
          >
            <option value="gemini-3.5-flash" className="bg-popover">
              gemini-3.5-flash
            </option>
            <option value="gemini-2.5-pro" className="bg-popover">
              gemini-2.5-pro
            </option>
          </select>
        </div>
      </div>
      <Button type="submit" size="lg" disabled={busy}>
        {busy ? <Loader2 className="animate-spin" /> : <Sparkles />}{" "}
        {busy ? "Generating script & Visual Bible with Gemini…" : "Generate Script & Visual Bible (Gemini)"}
      </Button>
    </form>
  );
}
