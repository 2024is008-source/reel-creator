import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2,
  Clock,
  Film,
  Globe,
  Mic,
  Music,
  Plus,
  RefreshCw,
  Settings,
  Sparkles,
  Trash2,
  AlertTriangle,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  deleteProject,
  getAudioPreferences,
  listMusicTracks,
  listProjects,
  saveAudioPreferences,
  totalDuration,
  type MusicTrack,
  type Project,
} from "@/lib/projects";
import {
  fetchPlatformStatus,
  getLocalTtsBaseUrl,
  setLocalTtsBaseUrl,
  updatePlatformSettings,
  type PlatformStatus,
} from "@/lib/local-tts";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Cinematic Studio — AI motivational reels" },
      {
        name: "description",
        content: "Turn a motivational idea into a painted, cinematic vertical video for Reels, Shorts and TikTok.",
      },
      { property: "og:title", content: "Cinematic Studio — AI motivational reels" },
      {
        property: "og:description",
        content: "Turn a motivational idea into a painted, cinematic vertical video.",
      },
    ],
  }),
  component: Dashboard,
});

function Dashboard() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [musicTracks, setMusicTracks] = useState<MusicTrack[]>([]);
  const [selectedMusicId, setSelectedMusicId] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<PlatformStatus | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [geminiModel, setGeminiModel] = useState("gemini-3.5-flash");
  const [flowUrlInput, setFlowUrlInput] = useState("https://labs.google/fx/tools/flow");
  const [serviceUrlInput, setServiceUrlInput] = useState(getLocalTtsBaseUrl());
  const [savingSettings, setSavingSettings] = useState(false);

  const refreshAll = useCallback(async () => {
    const [projs, tracks, prefs, st] = await Promise.all([
      listProjects(),
      listMusicTracks(),
      getAudioPreferences(),
      fetchPlatformStatus(),
    ]);
    setProjects(projs);
    setMusicTracks(tracks);
    setSelectedMusicId(prefs.selectedMusicId);
    setStatus(st);
    if (st.gemini.model) setGeminiModel(st.gemini.model);
    if (st.flow.flowUrl) setFlowUrlInput(st.flow.flowUrl);
  }, []);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  async function handleSaveSettings(e: React.FormEvent) {
    e.preventDefault();
    setSavingSettings(true);
    setLocalTtsBaseUrl(serviceUrlInput);
    const st = await updatePlatformSettings(
      {
        ...(apiKeyInput.trim() ? { geminiApiKey: apiKeyInput.trim() } : {}),
        geminiModel,
        googleFlowUrl: flowUrlInput,
      },
      serviceUrlInput,
    );
    await saveAudioPreferences({ geminiModel });
    setStatus(st);
    setApiKeyInput("");
    setSavingSettings(false);
    toast.success("Platform settings updated");
  }

  const ready = projects?.filter((p) => p.scenes.length && p.scenes.every((s) => s.image)).length ?? 0;
  const secs = projects?.reduce((s, p) => s + totalDuration(p), 0) ?? 0;

  const geminiBadge =
    status?.gemini.status === "connected"
      ? { label: "Connected", ok: true }
      : status?.gemini.status === "api_error"
        ? { label: "API error", ok: false }
        : { label: "Not configured", ok: false };

  const flowBadgeMap: Record<string, { label: string; ok: boolean }> = {
    browser_disconnected: { label: "Browser disconnected", ok: false },
    waiting_for_signin: { label: "Waiting for sign-in", ok: false },
    ready: { label: "Ready", ok: true },
    generating_images: { label: "Generating images", ok: true },
    generation_failed: { label: "Generation failed", ok: false },
  };
  const flowBadge = flowBadgeMap[status?.flow.status ?? "browser_disconnected"] ?? {
    label: "Browser disconnected",
    ok: false,
  };

  const piperBadge =
    status?.piper.status === "running"
      ? { label: `Running (${status.piper.voices} voices)`, ok: true }
      : status?.piper.status === "not_installed"
        ? { label: "Not installed", ok: false }
        : { label: "Unavailable", ok: false };

  const musicBadge =
    musicTracks.length === 0
      ? { label: "No track uploaded", ok: false }
      : selectedMusicId && musicTracks.some((t) => t.id === selectedMusicId)
        ? { label: "Track selected · Ready", ok: true }
        : { label: `Ready (${musicTracks.length} uploaded)`, ok: true };

  return (
    <div className="mx-auto max-w-6xl p-6 md:p-10">
      <div className="relative overflow-hidden rounded-2xl bg-dusk p-8 md:p-12">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <p className="text-xs uppercase tracking-[0.25em] text-muted-foreground">
            Cinematic motivational — painted 2D anime studio
          </p>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" onClick={refreshAll}>
              <RefreshCw className="size-3.5" /> Refresh Status
            </Button>
            <Button size="sm" variant="outline" onClick={() => setShowSettings((x) => !x)}>
              <Settings className="size-3.5" /> Settings
            </Button>
          </div>
        </div>
        <h1 className="mt-3 max-w-xl font-display text-5xl leading-[1.05] text-foreground md:text-6xl">
          Quiet scenes. <span className="italic text-primary">Loud</span> messages.
        </h1>
        <p className="mt-4 max-w-xl text-sm text-muted-foreground">
          Gemini script &amp; Visual Bible → Google Flow / Nano Banana painted 9:16 scenes → Local Piper TTS voiceover → Uploaded music with automatic ducking → FFmpeg 1080×1920 MP4 export.
        </p>
        <Button asChild size="lg" className="mt-6">
          <Link to="/create">
            <Plus /> Create new video
          </Link>
        </Button>
      </div>

      {/* Live Connection Statuses: Gemini, Google Flow, Piper, Music */}
      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="dashboard-connection-cards">
        {[
          {
            title: "Gemini API",
            sub: status?.gemini.model ?? "gemini-3.5-flash",
            badge: geminiBadge,
            icon: Sparkles,
          },
          {
            title: "Google Flow (Nano Banana)",
            sub: "Playwright persistent profile",
            badge: flowBadge,
            icon: Globe,
          },
          {
            title: "Local Piper TTS",
            sub: "Offline WAV voice engine",
            badge: piperBadge,
            icon: Mic,
          },
          {
            title: "Background Music",
            sub: "IndexedDB MP3 / WAV library",
            badge: musicBadge,
            icon: Music,
          },
        ].map((item) => {
          const Icon = item.icon;
          return (
            <div key={item.title} className="rounded-xl border border-border bg-card p-4 space-y-2">
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-foreground">
                  <Icon className="size-3.5 text-primary" />
                  {item.title}
                </span>
                {item.badge.ok ? (
                  <CheckCircle2 className="size-4 text-emerald-400" />
                ) : (
                  <AlertTriangle className="size-4 text-amber-400" />
                )}
              </div>
              <p
                className={`text-xs font-medium ${
                  item.badge.ok ? "text-emerald-300" : "text-amber-300"
                }`}
              >
                {item.badge.label}
              </p>
              <p className="truncate text-[11px] text-muted-foreground">{item.sub}</p>
            </div>
          );
        })}
      </div>

      {/* Settings Drawer */}
      {showSettings && (
        <form
          onSubmit={handleSaveSettings}
          className="mt-6 rounded-2xl border border-primary/30 bg-card p-6 space-y-4"
        >
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-display text-2xl">Studio &amp; Provider Settings</h2>
              <p className="text-xs text-muted-foreground">
                API keys are sent only to your local backend service (http://127.0.0.1:5005) and never exposed in client code.
              </p>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1.5">
              <Label>Local Backend Service URL</Label>
              <Input
                value={serviceUrlInput}
                onChange={(e) => setServiceUrlInput(e.target.value)}
                placeholder="http://127.0.0.1:5005"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Server-Side GEMINI_API_KEY</Label>
              <Input
                type="password"
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
                placeholder={status?.gemini.connected ? "•••••••• (Configured)" : "Paste Gemini API key"}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Gemini Model</Label>
              <select
                value={geminiModel}
                onChange={(e) => setGeminiModel(e.target.value)}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="gemini-3.5-flash">gemini-3.5-flash (Recommended)</option>
                <option value="gemini-2.5-pro">gemini-2.5-pro (Deep Storytelling)</option>
                <option value="gemini-2.0-flash">gemini-2.0-flash</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label>Google Flow URL</Label>
              <Input
                value={flowUrlInput}
                onChange={(e) => setFlowUrlInput(e.target.value)}
                placeholder="https://labs.google/fx/tools/flow"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setShowSettings(false)}>
              Close
            </Button>
            <Button type="submit" disabled={savingSettings}>
              {savingSettings ? "Saving…" : "Save Settings"}
            </Button>
          </div>
        </form>
      )}

      <div className="mt-8 grid grid-cols-3 gap-4">
        {[
          ["Projects", projects?.length ?? 0],
          ["Ready to export", ready],
          ["Total runtime", `${Math.round(secs)}s`],
        ].map(([k, v]) => (
          <div key={k} className="rounded-xl border border-border bg-card p-5">
            <p className="text-xs text-muted-foreground">{k}</p>
            <p className="mt-1 font-display text-4xl">{v}</p>
          </div>
        ))}
      </div>

      <h2 className="mt-12 font-display text-3xl">My projects</h2>
      {projects && projects.length === 0 && (
        <p className="mt-4 text-sm text-muted-foreground">No videos yet. Create your first one.</p>
      )}
      <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {projects?.map((p) => {
          const cover = p.scenes.find((s) => s.image)?.image;
          return (
            <div key={p.id} className="group relative">
              <Link
                to="/project/$id"
                params={{ id: p.id }}
                className="block overflow-hidden rounded-xl border border-border bg-card"
              >
                <div className="aspect-[9/16] bg-muted">
                  {cover ? (
                    <img
                      src={cover}
                      alt={p.title}
                      className="h-full w-full object-cover transition-transform duration-700 group-hover:scale-105"
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center text-muted-foreground">
                      <Film />
                    </div>
                  )}
                </div>
                <div className="p-3">
                  <p className="truncate text-sm font-medium">{p.title}</p>
                  <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="size-3" />
                    {Math.round(totalDuration(p))}s · {p.scenes.length} scenes
                  </p>
                </div>
              </Link>
              <button
                aria-label="Delete project"
                onClick={async () => {
                  if (!confirm("Delete this project?")) return;
                  await deleteProject(p.id);
                  setProjects((ps) => ps?.filter((x) => x.id !== p.id) ?? null);
                }}
                className="absolute right-2 top-2 rounded-md bg-background/70 p-1.5 text-muted-foreground opacity-0 transition group-hover:opacity-100 hover:text-destructive"
              >
                <Trash2 className="size-4" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
