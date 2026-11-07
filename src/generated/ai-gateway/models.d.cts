import "@lovable.dev/ai-gateway";

/* The MIT License

Copyright (c) OpenAI (https://openai.com)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
 */
declare namespace ModelContract_22a58a07375a37a1 {
export type paths = Record<string, never>;
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        GatewayErrorResponse: {
            error: {
                code?: string | null;
                message: string;
                metadata?: {
                    provider_name?: unknown;
                    raw?: unknown;
                };
                param?: unknown;
                type?: string;
            };
            usage?: {
                [key: string]: unknown;
            };
        };
        GatewayImageError: {
            error: {
                code?: string | null;
                message: string;
                metadata?: {
                    provider_name?: unknown;
                    raw?: unknown;
                };
                param?: unknown;
                type?: string;
            };
            
            type: "error";
        };
        ImageEditEvent: components["schemas"]["Output_ImageEditStreamEvent"] | components["schemas"]["GatewayErrorResponse"] | components["schemas"]["GatewayImageError"];
        ImageEditRequest: {
            background?: ("transparent" | "opaque" | "auto") | null;
            image: Blob | Blob[];
            
            mask?: Blob;
            
            model: "openai/gpt-image-2.5-sunburst";
            n?: number | null;
            output_compression?: number | null;
            output_format?: ("png" | "jpeg" | "webp") | null;
            partial_images?: components["schemas"]["PartialImages"];
            prompt: string;
            quality?: ("low" | "medium" | "high" | "xhigh" | "max" | "auto") | null;
            size?: (string | ("1024x1024" | "1536x1024" | "1024x1536" | "auto" | "256x256" | "512x512")) | null;
            stream?: boolean | null;
            user?: string;
        };
        ImageEditResponse: components["schemas"]["Output_ImagesResponse"];
        ImageGenerationEvent: components["schemas"]["Output_ImageGenStreamEvent"] | components["schemas"]["GatewayErrorResponse"] | components["schemas"]["GatewayImageError"];
        ImageGenerationRequest: {
            background?: ("transparent" | "opaque" | "auto") | null;
            
            model: "openai/gpt-image-2.5-sunburst";
            moderation?: ("low" | "auto") | null;
            n?: number | null;
            output_compression?: number | null;
            output_format?: ("png" | "jpeg" | "webp") | null;
            partial_images?: components["schemas"]["PartialImages"];
            prompt: string;
            quality?: ("low" | "medium" | "high" | "xhigh" | "max" | "auto") | null;
            size?: (string | ("auto" | "1024x1024" | "1536x1024" | "1024x1536" | "256x256" | "512x512" | "1792x1024" | "1024x1792")) | null;
            stream?: boolean | null;
            user?: string;
        };
        ImageGenerationResponse: components["schemas"]["Output_ImagesResponse"];
        Output_Image: {
            b64_json?: string;
            revised_prompt?: string;
            
            url?: string;
        };
        Output_ImageEditCompletedEvent: {
            b64_json: string;
            
            background: "transparent" | "opaque" | "auto";
            
            created_at: number;
            
            output_format: "png" | "webp" | "jpeg";
            
            quality: "low" | "medium" | "high" | "xhigh" | "max" | "auto";
            size: string | ("1024x1024" | "1024x1536" | "1536x1024" | "auto");
            
            type: "image_edit.completed";
            usage: components["schemas"]["Output_ImagesUsage"];
        };
        Output_ImageEditPartialImageEvent: {
            b64_json: string;
            
            background: "transparent" | "opaque" | "auto";
            
            created_at: number;
            
            output_format: "png" | "webp" | "jpeg";
            partial_image_index: number;
            
            quality: "low" | "medium" | "high" | "xhigh" | "max" | "auto";
            size: string | ("1024x1024" | "1024x1536" | "1536x1024" | "auto");
            
            type: "image_edit.partial_image";
        };
        Output_ImageEditStreamEvent: components["schemas"]["Output_ImageEditPartialImageEvent"] | components["schemas"]["Output_ImageEditCompletedEvent"];
        Output_ImageGenCompletedEvent: {
            b64_json: string;
            
            background: "transparent" | "opaque" | "auto";
            
            created_at: number;
            
            output_format: "png" | "webp" | "jpeg";
            
            quality: "low" | "medium" | "high" | "xhigh" | "max" | "auto";
            size: string | ("1024x1024" | "1024x1536" | "1536x1024" | "auto");
            
            type: "image_generation.completed";
            usage: components["schemas"]["Output_ImagesUsage"];
        };
        Output_ImageGenInputUsageDetails: {
            image_tokens: number;
            text_tokens: number;
        };
        Output_ImageGenOutputTokensDetails: {
            image_tokens: number;
            text_tokens: number;
        };
        Output_ImageGenPartialImageEvent: {
            b64_json: string;
            
            background: "transparent" | "opaque" | "auto";
            
            created_at: number;
            
            output_format: "png" | "webp" | "jpeg";
            partial_image_index: number;
            
            quality: "low" | "medium" | "high" | "xhigh" | "max" | "auto";
            size: string | ("1024x1024" | "1024x1536" | "1536x1024" | "auto");
            
            type: "image_generation.partial_image";
        };
        Output_ImageGenStreamEvent: components["schemas"]["Output_ImageGenPartialImageEvent"] | components["schemas"]["Output_ImageGenCompletedEvent"];
        Output_ImageGenUsage: {
            input_tokens: number;
            input_tokens_details: components["schemas"]["Output_ImageGenInputUsageDetails"];
            output_tokens: number;
            output_tokens_details?: components["schemas"]["Output_ImageGenOutputTokensDetails"];
            total_tokens: number;
        };
        Output_ImagesResponse: {
            
            background?: "transparent" | "opaque";
            
            created: number;
            data?: components["schemas"]["Output_Image"][];
            
            output_format?: "png" | "webp" | "jpeg";
            
            quality?: "low" | "medium" | "high" | "xhigh" | "max";
            size?: string | ("1024x1024" | "1024x1536" | "1536x1024");
            usage?: components["schemas"]["Output_ImageGenUsage"];
        };
        Output_ImagesUsage: {
            input_tokens: number;
            input_tokens_details: {
                image_tokens: number;
                text_tokens: number;
            };
            output_tokens: number;
            total_tokens: number;
        };
        PartialImages: number | null;
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export type operations = Record<string, never>;

}
declare module "@lovable.dev/ai-gateway" {
  interface GeneratedModelsBySurface {
    "chat-completions": "google/gemini-2.5-flash" | "google/gemini-2.5-flash-image" | "google/gemini-2.5-flash-lite" | "google/gemini-2.5-pro" | "google/gemini-3-flash-preview" | "google/gemini-3-pro-image" | "google/gemini-3.1-flash-image" | "google/gemini-3.1-flash-lite" | "google/gemini-3.1-pro-preview" | "google/gemini-3.5-flash" | "google/gemini-3.6-flash" | "google/gemini-3.7-flash" | "google/gemini-3.8-flash" | "openai/chat-latest" | "openai/gpt-5" | "openai/gpt-5-mini" | "openai/gpt-5-nano" | "openai/gpt-5.2" | "openai/gpt-5.4" | "openai/gpt-5.4-mini" | "openai/gpt-5.4-nano" | "openai/gpt-5.5" | "openai/gpt-5.6-luna" | "openai/gpt-5.6-sol" | "openai/gpt-5.6-terra" | "openai/gpt-6-astra";
    "responses": "openai/chat-latest" | "openai/gpt-5" | "openai/gpt-5-mini" | "openai/gpt-5-nano" | "openai/gpt-5.2" | "openai/gpt-5.4" | "openai/gpt-5.4-mini" | "openai/gpt-5.4-nano" | "openai/gpt-5.4-pro" | "openai/gpt-5.5" | "openai/gpt-5.5-pro" | "openai/gpt-5.6-luna" | "openai/gpt-5.6-sol" | "openai/gpt-5.6-terra" | "openai/gpt-6-astra";
    "messages": never;
    "interactions": never;
    "image-generation": "google/gemini-2.5-flash-image" | "google/gemini-3-pro-image" | "google/gemini-3.1-flash-image" | "google/gemini-3.1-flash-lite-image" | "openai/gpt-image-1-mini" | "openai/gpt-image-2" | "openai/gpt-image-2.5-sunburst";
    "image-edit": "openai/gpt-image-1-mini" | "openai/gpt-image-2" | "openai/gpt-image-2.5-sunburst";
    "embeddings": "google/gemini-embedding-001" | "google/gemini-embedding-2" | "openai/text-embedding-3-large" | "openai/text-embedding-3-small";
    "speech": "google/gemini-2.5-flash-lite-preview-tts" | "google/gemini-2.5-flash-tts" | "google/gemini-2.5-pro-tts" | "google/gemini-3.1-flash-tts-preview" | "openai/gpt-4o-mini-tts";
    "transcription": "google/gemini-3.5-transcribe" | "openai/gpt-4o-mini-transcribe" | "openai/gpt-4o-transcribe";
    "music": never;
    "videos": "google/gemini-omni-1.1-flash" | "google/veo-3.1" | "google/veo-3.1-fast" | "google/veo-3.1-lite";
    "systemone": never;
    "live": never;
  }
  interface ImageFieldsByModel {
    "openai/gpt-image-2.5-sunburst": ModelContract_22a58a07375a37a1.components["schemas"]["ImageGenerationRequest"];
  }
  interface ImageEditFieldsByModel {
    "openai/gpt-image-2.5-sunburst": ModelContract_22a58a07375a37a1.components["schemas"]["ImageEditRequest"];
  }
  interface ImageResponseByModel {
    "openai/gpt-image-2.5-sunburst": ModelContract_22a58a07375a37a1.components["schemas"]["ImageGenerationResponse"];
  }
  interface ImageEditResponseByModel {
    "openai/gpt-image-2.5-sunburst": ModelContract_22a58a07375a37a1.components["schemas"]["ImageEditResponse"];
  }
  interface ImageEventByModel {
    "openai/gpt-image-2.5-sunburst": ModelContract_22a58a07375a37a1.components["schemas"]["ImageGenerationEvent"];
  }
  interface ImageEditEventByModel {
    "openai/gpt-image-2.5-sunburst": ModelContract_22a58a07375a37a1.components["schemas"]["ImageEditEvent"];
  }
}
