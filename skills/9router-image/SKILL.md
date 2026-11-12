---
name: 9router-image
description: Generate images via 9Router /v1/images/generations using OpenAI / Gemini Imagen / DALL-E / FLUX / MiniMax / SDWebUI / ComfyUI / Codex models. Use when the user wants to create, generate, draw, or render an image, picture, or text-to-image (txt2img).
---

# 9Router — Image Generation

Requires `NINEROUTER_URL` (and `NINEROUTER_KEY` if auth enabled). See https://raw.githubusercontent.com/decolua/9router/refs/heads/master/skills/9router/SKILL.md for setup.

## Discover

```bash
curl $NINEROUTER_URL/v1/models/image | jq '.data[].id'
# Per-model params/options (size enum, quality enum, capabilities like edit)
curl "$NINEROUTER_URL/v1/models/info?id=openai/dall-e-3"
```

## Endpoint

`POST $NINEROUTER_URL/v1/images/generations`

| Field | Required | Notes |
|---|---|---|
| `model` | yes | from `/v1/models/image` |
| `prompt` | yes | image description |
| `n` | no | count (provider-dependent) |
| `size` | no | `1024x1024`, `1792x1024`, ... |
| `quality` | no | `standard` / `hd` (OpenAI) |
| `response_format` | no | `url` (default) or `b64_json` |

Add query `?response_format=binary` to receive raw image bytes (handy for saving file).

## Examples

Save to file (binary):

```bash
curl -X POST "$NINEROUTER_URL/v1/images/generations?response_format=binary" \
  -H "Authorization: Bearer $NINEROUTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini/gemini-3-pro-image-preview","prompt":"watercolor mountains at sunrise","size":"1024x1024"}' \
  --output out.png
```

JS (URL response):

```js
const r = await fetch(`${process.env.NINEROUTER_URL}/v1/images/generations`, {
  method: "POST",
  headers: { "Authorization": `Bearer ${process.env.NINEROUTER_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ model: "gemini/gemini-3-pro-image-preview", prompt: "neon city", size: "1024x1024" }),
});
const { data } = await r.json();
console.log(data[0].url || data[0].b64_json.slice(0, 40));
```

## Edit an image

`POST $NINEROUTER_URL/v1/images/edits` is OpenAI-compatible, so `client.images.edit()` from the OpenAI SDKs works as is. It takes the same fields as generations plus the input image(s):

- multipart: `image` or `image[]` files (PNG/JPEG/WEBP/GIF, max 16, 50MB each), optional `mask`
- JSON: `images: [{ "image_url": "https://... or data:image/png;base64,..." }]` (plain strings also work). URLs must be public: internal/LAN hosts are rejected with 400. For providers that need inline bytes (gemini, antigravity, huggingface, cloudflare-ai), 9router downloads the URL itself (max 10MB, must be an image).

Only providers that use input images accept edits: `codex`, `nanobanana`, `antigravity` (several images), `gemini`, `huggingface`, `black-forest-labs`, `fal-ai`, `cloudflare-ai`, `runwayml` (one image). Others return 400 instead of silently ignoring the image. `mask` works only with `cloudflare-ai`; elsewhere describe the area to change in the prompt.

Edits can take 1-2 minutes. Behind Cloudflare a request idle for 120s fails with HTTP 524, so for slow edits either send `stream=true` (OpenAI-style SSE: `: keepalive` comments, then an `image_edit.completed` event with `b64_json`, or an `error` event) or just wait: a plain request not finished after 90s is answered early with HTTP 200 and kept alive with whitespace, and a late failure then arrives as `{"error":{...}}` in the body instead of a status code. Set the client timeout to 600s.

```bash
curl -X POST "$NINEROUTER_URL/v1/images/edits" \
  -H "Authorization: Bearer $NINEROUTER_KEY" \
  -F model=codex/gpt-image-2.6 -F prompt="make the apple green" \
  -F "image[]=@apple.png"
```

## Response shape

JSON (default `response_format=url`):
```json
{ "created": 1735000000, "data": [{ "url": "https://..." }] }
```

`response_format=b64_json`:
```json
{ "created": 1735000000, "data": [{ "b64_json": "iVBORw0KGgo..." }] }
```

Query `?response_format=binary` returns raw image bytes (Content-Type `image/png` or `image/jpeg`).

## Provider quirks

Common fields above work everywhere. These add/override:

| Provider | Extra/changed fields | Notes |
|---|---|---|
| `openai`, `minimax`, `openrouter`, `recraft` | `quality`, `style`, `response_format` | Standard OpenAI shape |
| `gemini` (nano-banana) | — | Only `prompt`; ignores `size`/`n` |
| `codex` (gpt-5.4-image) | `image`, `images[]`, `image_detail`, `output_format`, `background` | SSE stream; **ChatGPT Plus/Pro required** |
| `huggingface` | — | Only `prompt`; returns single image |
| `nanobanana` | `image`, `images[]` (edit mode) | `size` → aspect ratio; async polling |
| `fal-ai` | `image` (img2img) | `n` → `num_images`; `size` → ratio; async |
| `stability-ai` | `style` (preset), `output_format` | `size` → `aspect_ratio` |
| `black-forest-labs` (FLUX) | `image` (ref) | `size` → exact `width`/`height`; async |
| `runwayml` | `image` (ref) | `size` → ratio; async; video models exist |
| `sdwebui`, `comfyui` | — | Localhost noAuth (`:7860` / `:8188`) |
