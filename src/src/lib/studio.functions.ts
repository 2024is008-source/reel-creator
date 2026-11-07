import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { generateImage, generateResponse, GatewayError } from "@lovable.dev/ai-gateway";

export const STYLE_PROMPT =
  "Retro 1990s lo-fi anime illustration in the style of quiet aesthetic motivational reels: flat matte colors, simple clean line art, soft cel shading, risograph / printed-paper texture with fine film grain and tiny dust specks, muted deep navy and slate-teal skies, dark forest greens, warm burnt-orange and coral sunset accents, low-contrast moody night, dusk, rain or golden-hour light. Either a small lone figure in a vast calm landscape (mountains, lake, forest path, snowy pines, ocean shore, rooftop over night city, empty street under lamps), or an intimate close-up of a young man or woman with a quiet emotional expression. Minimal, uncluttered, cinematic, vertical 9:16, keep the centre band of the frame calm for a caption. No text, no letters, no watermark, no logos, not photorealistic, not 3D.";

export const visualBibleSchema = z.object({
  character_appearance: z.string().min(3),
  clothing: z.string().min(3),
  hair: z.string().min(2),
  age_range: z.string().min(2),
  body_proportions: z.string().min(2),
  environment: z.string().min(3),
  color_palette: z.string().min(3),
  lighting: z.string().min(3),
  art_style: z.string().default(STYLE_PROMPT),
});

export const structuredSceneSchema = z.object({
  scene_number: z.number().int().min(1),
  start_time: z.number().min(0),
  end_time: z.number().gt(0),
  caption: z.string().min(1),
  narration: z.string().optional().default(""),
  visual_description: z.string().min(1),
  image_prompt: z.string().min(1),
  camera_movement: z.string().default("slow zoom in"),
  transition: z.string().default("fade"),
});

export const structuredScriptSchema = z.object({
  title: z.string().min(1),
  theme: z.string().default("Hope and perseverance"),
  duration_seconds: z.number().min(9).max(90).default(21),
  visual_style: z.string().default("cinematic painted 2D anime"),
  narration: z.string().default(""),
  visual_bible: visualBibleSchema,
  scenes: z.array(structuredSceneSchema).min(1),
});

export type StructuredScriptOutput = z.infer<typeof structuredScriptSchema>;

const scriptInput = z.object({
  title: z.string().max(200),
  topic: z.string().min(1).max(500),
  message: z.string().max(1000),
  story: z.string().max(1500).optional().default(""),
  audience: z.string().max(200).optional().default(""),
  language: z.string().max(50).default("English"),
  category: z.string().max(80),
  duration: z.number().int().min(9).max(90).default(21),
  aspectRatio: z.enum(["9:16", "16:9"]).optional().default("9:16"),
  sceneCount: z.number().int().min(3).max(12),
  model: z.string().optional().default("gemini-3.5-flash"),
});

function friendly(e: unknown): string {
  if (e instanceof GatewayError) {
    if (e.httpStatus === 402) return "AI credits are used up. Add credits in your workspace to keep generating.";
    if (e.httpStatus === 429) return "Gemini API quota or rate limit exceeded. Wait a moment and try again.";
    return `AI request failed (${e.code ?? e.httpStatus ?? "error"}).`;
  }
  return e instanceof Error ? e.message : "Unknown error";
}

function buildGeminiPrompt(data: z.infer<typeof scriptInput>): string {
  const avgSec = Math.round((data.duration / data.sceneCount) * 10) / 10;
  return `You are a master cinematic motivational film director and visual development artist.
Write a structured motivational vertical video script and Visual Bible in ${data.language}.

INPUT PARAMETERS:
- Video title (generate one if blank): ${data.title || "(Generate an evocative title)"}
- Category: ${data.category}
- Topic: ${data.topic}
- Main motivational message: ${data.message}
- Story idea: ${data.story || "A solitary protagonist walking through quiet rain and mist at dusk toward a warm mountain sunrise"}
- Audience: ${data.audience || "General audience"}
- Duration: ${data.duration} seconds
- Exact scene count: ${data.sceneCount} scenes (~${avgSec}s per scene; start_time and end_time must span 0 to ${data.duration}s continuously)

VISUAL STYLE (match the reference reels exactly):
${STYLE_PROMPT}
Vary the shots like the reference reels: alternate wide landscapes with a tiny lone figure, medium shots of a person from behind, and emotional close-up portraits. Characters do NOT have to be the same person in every scene; keep the colour palette, grain and drawing style identical instead. Fill \`visual_bible\` with the shared palette, lighting and art style (character fields can describe the typical figure).
Every scene's \`image_prompt\` must describe one clear image and end with the full visual style above.

CAPTION & NARRATION RULES (reference reel format):
- The whole narration is one short, calm, quotable motivational message (about 2.5 words per second of video), e.g. "A yes from God blesses you, a no from God protects you, a wait from God prepares you."
- Split it into ${data.sceneCount} consecutive phrases, one per scene. Each phrase is 2-8 words.
- For every scene, \`caption\` and \`narration\` are the SAME phrase, word for word (the caption is exactly what is spoken).
- No hashtags, no emojis, no quotation marks.

Return ONLY valid JSON matching this schema:
{
  "title": "string",
  "theme": "string",
  "duration_seconds": ${data.duration},
  "visual_style": "cinematic painted 2D anime",
  "narration": "full spoken narration across all scenes",
  "visual_bible": {
    "character_appearance": "string",
    "clothing": "string",
    "hair": "string",
    "age_range": "string",
    "body_proportions": "string",
    "environment": "string",
    "color_palette": "string",
    "lighting": "string",
    "art_style": "string"
  },
  "scenes": [
    {
      "scene_number": 1,
      "start_time": 0,
      "end_time": ${avgSec},
      "caption": "Short connected caption",
      "narration": "Spoken narration line for scene 1",
      "visual_description": "Scene environment, character pose, weather, lighting",
      "image_prompt": "Complete 9:16 painted 2D anime prompt embedding Visual Bible character clothing, hair, palette, and lighting",
      "camera_movement": "slow zoom in",
      "transition": "fade"
    }
  ]
}`;
}

async function callOfficialGeminiRestApi(apiKey: string, model: string, prompt: string): Promise<string> {
  const cleanModel = model.replace(/^google\//, "").trim() || "gemini-3.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${cleanModel}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.7,
      },
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403 || errText.toLowerCase().includes("api_key_invalid")) {
      throw new Error("Invalid Gemini API key (GEMINI_API_KEY). Check your server environment configuration.");
    }
    if (res.status === 429 || errText.toLowerCase().includes("quota")) {
      throw new Error("Gemini API quota exceeded (HTTP 429). Please wait or check your Google AI Studio quota.");
    }
    throw new Error(`Gemini API error (HTTP ${res.status}): ${errText.slice(0, 240)}`);
  }
  const body = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text =
    body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("").trim() ?? "";
  if (!text) {
    throw new Error("Gemini API returned an empty response.");
  }
  return text;
}

export const generateScript = createServerFn({ method: "POST" })
  .inputValidator((d) => scriptInput.parse(d))
  .handler(async ({ data }) => {
    try {
      const prompt = buildGeminiPrompt(data);
      const geminiKey = process.env["GEMINI_API_KEY"]?.trim();
      let rawText = "";

      if (geminiKey) {
        rawText = await callOfficialGeminiRestApi(geminiKey, data.model, prompt);
      } else {
        const res = await generateResponse({
          model: "openai/gpt-5-mini",
          input: [{ role: "user", content: prompt }],
          text: { format: { type: "json_object" } },
        });
        const r = res as unknown as {
          output_text?: string;
          output?: Array<{ content?: Array<{ type: string; text?: string }> }>;
        };
        rawText =
          r.output_text ??
          (r.output ?? [])
            .flatMap((o) => o.content ?? [])
            .filter((c) => c.type === "output_text")
            .map((c) => c.text ?? "")
            .join("");
      }

      const cleaned = rawText
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "");
      const parsed = structuredScriptSchema.parse(JSON.parse(cleaned));
      return { ok: true as const, ...parsed };
    } catch (e) {
      return { ok: false as const, error: friendly(e) };
    }
  });

export const generateSceneImage = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ visual: z.string().min(1).max(2500), aspectRatio: z.enum(["9:16", "16:9"]).optional().default("9:16") }).parse(d))
  .handler(async ({ data }) => {
    try {
      const stylePrompt = data.aspectRatio === "16:9" ? STYLE_PROMPT.replace("vertical 9:16", "widescreen horizontal 16:9") : STYLE_PROMPT;
      const res = await generateImage({
        model: "openai/gpt-image-2.5-sunburst",
        prompt: `${data.visual}. ${stylePrompt}`,
        size: data.aspectRatio === "16:9" ? "1536x1024" : "1024x1536",
        quality: "medium",
        output_format: "jpeg",
        n: 1,
      });
      const b64 = (res as unknown as { data?: Array<{ b64_json?: string }> }).data?.[0]?.b64_json;
      if (!b64) return { ok: false as const, error: "No image was returned." };
      return { ok: true as const, image: `data:image/jpeg;base64,${b64}` };
    } catch (e) {
      return { ok: false as const, error: friendly(e) };
    }
  });
