// Shared helpers for image provider adapters
import { fetchImageAsBase64 } from "../../translator/concerns/image.js";

export const POLL_INTERVAL_MS = 1500;
export const POLL_TIMEOUT_MS = 120000;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Map OpenAI size to provider-specific aspect ratio
export function sizeToAspectRatio(size) {
  if (!size || typeof size !== "string") return "1:1";
  const map = {
    "1024x1024": "1:1",
    "1024x1792": "9:16",
    "1792x1024": "16:9",
    "1024x1536": "2:3",
    "1536x1024": "3:2",
  };
  return map[size] || "1:1";
}

// Fetch URL → base64 (for providers returning image URLs)
export async function urlToBase64(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
  const buf = await res.arrayBuffer();
  return Buffer.from(buf).toString("base64");
}

// Fetch a caller-supplied input image URL -> raw base64. Goes through the SSRF-hardened
// fetcher (public IPs only with DNS pinned, no redirects, size cap, magic-byte check), so
// an edit request can't make the server read internal hosts. urlToBase64 above is only
// for result URLs returned by the provider itself.
export async function inputUrlToBase64(url) {
  const fetched = await fetchImageAsBase64(url);
  if (!fetched) throw new Error("Input image URL was rejected: it must be a public http(s) URL that returns an image of at most 10MB");
  return fetched.url.slice(fetched.url.indexOf(",") + 1);
}

export function nowSec() {
  return Math.floor(Date.now() / 1000);
}
