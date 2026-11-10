// POST /v1/images/edits — OpenAI-compatible image edit endpoint.
// Accepts the OpenAI SDK's multipart form (image / image[] files, optional mask) and the
// JSON form (images: [{ image_url }] or plain URL / data-URL strings), normalizes both to
// { ...fields, images: [dataUrl|url], mask? } and runs the image generation pipeline in
// edit mode, which rejects providers that cannot take an input image.
import { handleImageGeneration } from "./imageGeneration.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";

export const MAX_EDIT_IMAGES = 16;
export const MAX_EDIT_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_EDIT_BODY_BYTES = 64 * 1024 * 1024;

const STRING_FIELDS = [
  "model", "prompt", "size", "quality", "response_format", "output_format",
  "background", "input_fidelity", "moderation", "style", "user",
];
const NUMBER_FIELDS = ["n", "output_compression"];

const fail = (status, message) => ({ status, message });

function sniffImageType(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF"
    && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") return "image/webp";
  if (bytes.length >= 4 && String.fromCharCode(...bytes.subarray(0, 4)) === "GIF8") return "image/gif";
  return null;
}

async function fileToDataUrl(file, field) {
  if (file.size > MAX_EDIT_FILE_BYTES) {
    return fail(HTTP_STATUS.PAYLOAD_TOO_LARGE, `${field} exceeds ${MAX_EDIT_FILE_BYTES / 1024 / 1024}MB`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = sniffImageType(bytes);
  if (!type) return fail(HTTP_STATUS.UNSUPPORTED_MEDIA_TYPE, `${field} must be a PNG, JPEG, WEBP or GIF image`);
  return { value: `data:${type};base64,${Buffer.from(bytes).toString("base64")}` };
}

// String / { image_url } input → URL or data URL the adapters understand.
function refFromJson(input, field) {
  const ref = typeof input === "string" ? input : input?.image_url ?? input?.url;
  if (input?.file_id) return fail(HTTP_STATUS.BAD_REQUEST, `${field}: file_id is not supported, send image_url instead`);
  if (typeof ref !== "string" || !ref.trim()) return fail(HTTP_STATUS.BAD_REQUEST, `${field} must be an image URL or data URL`);
  const value = ref.trim();
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(value) || /^https?:\/\//i.test(value)) return { value };
  if (/^[A-Za-z0-9+/=\s]+$/.test(value) && value.length > 100) return { value: `data:image/png;base64,${value.replace(/\s+/g, "")}` };
  return fail(HTTP_STATUS.BAD_REQUEST, `${field} must be an image URL or data URL`);
}

function pickFields(source, get) {
  const body = {};
  for (const key of STRING_FIELDS) {
    const v = get(source, key);
    if (typeof v === "string" && v !== "") body[key] = v;
  }
  for (const key of NUMBER_FIELDS) {
    const v = get(source, key);
    if (v === undefined || v === null || v === "") continue;
    const num = Number(v);
    if (!Number.isFinite(num)) return fail(HTTP_STATUS.BAD_REQUEST, `${key} must be a number`);
    body[key] = num;
  }
  return { body };
}

async function readMultipart(request) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return fail(HTTP_STATUS.BAD_REQUEST, "Invalid multipart body");
  }
  const picked = pickFields(form, (f, k) => f.get(k));
  if (!picked.body) return picked;

  const files = [...form.getAll("image"), ...form.getAll("image[]")];
  const images = [];
  for (const entry of files) {
    const ref = typeof entry === "string" ? refFromJson(entry, "image") : await fileToDataUrl(entry, "image");
    if (ref.status) return ref;
    images.push(ref.value);
  }

  const maskEntry = form.get("mask");
  let mask;
  if (maskEntry) {
    const ref = typeof maskEntry === "string" ? refFromJson(maskEntry, "mask") : await fileToDataUrl(maskEntry, "mask");
    if (ref.status) return ref;
    mask = ref.value;
  }
  return { body: picked.body, images, mask };
}

async function readJson(request) {
  let json;
  try {
    json = await request.json();
  } catch {
    return fail(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }
  if (!json || typeof json !== "object") return fail(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  const picked = pickFields(json, (o, k) => o[k]);
  if (!picked.body) return picked;

  const inputs = [json.images, json.image]
    .flatMap((v) => (Array.isArray(v) ? v : v ? [v] : []));
  const images = [];
  for (const input of inputs) {
    const ref = refFromJson(input, "image");
    if (ref.status) return ref;
    images.push(ref.value);
  }

  let mask;
  if (json.mask) {
    const ref = refFromJson(json.mask, "mask");
    if (ref.status) return ref;
    mask = ref.value;
  }
  return { body: picked.body, images, mask };
}

/**
 * Parse an image edit request into the normalized edit body.
 * @returns {Promise<{body?: object, status?: number, message?: string}>}
 */
export async function parseImageEditRequest(request) {
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_EDIT_BODY_BYTES) {
    return fail(HTTP_STATUS.PAYLOAD_TOO_LARGE, `Request body exceeds ${MAX_EDIT_BODY_BYTES / 1024 / 1024}MB`);
  }

  const contentType = (request.headers.get("content-type") || "").toLowerCase();
  let parsed;
  if (contentType.startsWith("multipart/form-data")) parsed = await readMultipart(request);
  else if (contentType.startsWith("application/json") || !contentType) parsed = await readJson(request);
  else return fail(HTTP_STATUS.UNSUPPORTED_MEDIA_TYPE, "Content-Type must be multipart/form-data or application/json");
  if (parsed.status) return parsed;

  const { body, images, mask } = parsed;
  if (images.length === 0) return fail(HTTP_STATUS.BAD_REQUEST, "Missing required field: image");
  if (images.length > MAX_EDIT_IMAGES) return fail(HTTP_STATUS.BAD_REQUEST, `At most ${MAX_EDIT_IMAGES} images are allowed`);

  body.images = images;
  if (mask) body.mask = mask;
  return { body };
}

/** Handle POST /v1/images/edits */
export function handleImageEdit(request) {
  return handleImageGeneration(request, { readBody: parseImageEditRequest, edit: true });
}
