// Image provider adapter registry
import createOpenAIAdapter from "./openai.js";
import gemini from "./gemini.js";
import codex from "./codex.js";
import sdwebui from "./sdwebui.js";
import comfyui from "./comfyui.js";
import huggingface from "./huggingface.js";
import nanobanana from "./nanobanana.js";
import falAi from "./falAi.js";
import stabilityAi from "./stabilityAi.js";
import blackForestLabs from "./blackForestLabs.js";
import runwayml from "./runwayml.js";
import cloudflareAi from "./cloudflareAi.js";
import antigravity from "./antigravity.js";
import museWeb from "./muse-web.js";
import chatgptWeb from "./chatgpt-web.js";
import geminiWeb from "./gemini-web.js";
import grokWeb from "./grok-web.js";
import veoAiFreeWeb from "./veoaifree-web.js";
import ucWeb from "./uc-web.js";

const ADAPTERS = {
  openai: createOpenAIAdapter("openai"),
  minimax: createOpenAIAdapter("minimax"),
  openrouter: createOpenAIAdapter("openrouter"),
  recraft: createOpenAIAdapter("recraft"),
  "vercel-ai-gateway": createOpenAIAdapter("vercel-ai-gateway"),
  xai: createOpenAIAdapter("xai"),
  sensenova: createOpenAIAdapter("sensenova"),
  "sensenova-intl": createOpenAIAdapter("sensenova-intl"),
  gemini,
  codex,
  sdwebui,
  comfyui,
  huggingface,
  nanobanana,
  antigravity,
  "fal-ai": falAi,
  "stability-ai": stabilityAi,
  "black-forest-labs": blackForestLabs,
  runwayml,
  "cloudflare-ai": cloudflareAi,
  "muse-web": museWeb,
  "chatgpt-web": chatgptWeb,
  "gemini-web": geminiWeb,
  "grok-web": grokWeb,
  "veoaifree-web": veoAiFreeWeb,
  "uc-web": ucWeb,
};

// How each adapter consumes input images for /v1/images/edits.
//   "multi"  — reads body.images (array) and body.image
//   "single" — reads only one image (body.image, or body.images[0])
// Providers not listed ignore input images, so edits must be rejected for them.
// Only cloudflare-ai forwards a mask.
const IMAGE_INPUT = {
  codex: "multi",
  nanobanana: "multi",
  antigravity: "multi",
  gemini: "single",
  huggingface: "single",
  "black-forest-labs": "single",
  "fal-ai": "single",
  "cloudflare-ai": "single",
  runwayml: "single",
};
const MASK_PROVIDERS = new Set(["cloudflare-ai"]);

export function getImageInputSupport(provider) {
  return IMAGE_INPUT[provider] || null;
}

export function supportsImageMask(provider) {
  return MASK_PROVIDERS.has(provider);
}

export function getImageAdapter(provider) {
  return ADAPTERS[provider] || null;
}

export function isImageProvider(provider) {
  return provider in ADAPTERS;
}
