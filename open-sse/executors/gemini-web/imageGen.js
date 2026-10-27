// Gemini Web image generation (DOM capture).
//
// Ask the web UI to generate an image, wait for the generated <img> to land in
// the reply bubble (the "Creating your image" phase keeps the thinking overlay
// up — reuse that marker as the still-working signal), then download the
// (possibly blob:) image in-page as base64. Verified live: 1024×572 blob image
// in ~26s.

import os from "node:os";
import path from "node:path";

const POLL_INTERVAL_MS = 1000;
const IMAGE_TIMEOUT_MS = 120000;
const FIRST_TOKEN_TIMEOUT_MS = 30000;
const MIN_IMAGE_EDGE = 100;
// A finished text-only reply (refusal, sign-in/quota notice) never turns into
// an image; give up after it has been idle this long instead of the full timeout.
const TEXT_ONLY_GRACE_MS = 30000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Newer (signed-in) layouts may not use the model-response/message-content
// tags or an English "Stop" label, so also accept the sent user query and a
// stop-icon button as activity, and fall back to the chat area for images.
const READ_IMAGE_STATE = `(() => {
  const msgs = [...document.querySelectorAll('model-response, message-content')];
  const last = msgs.length ? msgs[msgs.length - 1] : null;
  const queries = document.querySelectorAll('user-query, [data-test-id*="user-query"], .user-query-container, .query-text').length;
  const scope = last || document.querySelector('chat-window, .chat-history, main');
  const imgs = scope
    ? [...scope.querySelectorAll('img')].map((i) => ({
        src: i.currentSrc || i.src || '',
        w: i.naturalWidth || 0,
        h: i.naturalHeight || 0,
      }))
    : [];
  const stopButton = [...document.querySelectorAll('button')].some((b) => {
    const label = b.getAttribute('aria-label') || '';
    const icon = b.querySelector('mat-icon');
    const iconName = icon ? (icon.getAttribute('fonticon') || icon.getAttribute('data-mat-icon-name') || icon.textContent || '').trim() : '';
    return /stop|dừng|ngừng/i.test(label) || /^stop/i.test(iconName) || b.classList.contains('stop');
  });
  return {
    count: msgs.length + queries,
    generating: stopButton || !!document.querySelector('[data-test-id="thinking-overlay-content"]'),
    images: imgs.filter((i) => i.src && !i.src.includes('gstatic') && !i.src.includes('googleusercontent.com/a/') && i.w > 0),
    text: last ? (last.innerText || '').trim().slice(0, 400) : '',
  };
})()`;

async function readImageState(page) {
  try {
    return (
      (await page.evaluate(READ_IMAGE_STATE)) || { count: 0, generating: false, images: [], text: "" }
    );
  } catch {
    return { count: 0, generating: false, images: [], text: "" };
  }
}

async function fetchImageAsBase64(page, src) {
  const result = await page.evaluate(async (url) => {
    // data: URL — decode directly
    if (url.startsWith("data:")) {
      const r = await fetch(url);
      const blob = await r.blob();
      return { ok: true, mime: blob.type || "image/png", b64: url.slice(url.indexOf(",") + 1) };
    }
    // blob:/same-origin images render untainted — canvas gives the bytes
    // without a network round-trip (the blob may already be revoked).
    try {
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("img load failed"));
        el.src = url;
      });
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext("2d").drawImage(img, 0, 0);
      const dataUrl = canvas.toDataURL("image/png");
      return { ok: true, mime: "image/png", b64: dataUrl.slice(dataUrl.indexOf(",") + 1) };
    } catch {
      /* fall through to fetch */
    }
    try {
      const response = await fetch(url);
      if (!response.ok) return { ok: false, err: `status ${response.status}` };
      const blob = await response.blob();
      const buf = new Uint8Array(await blob.arrayBuffer());
      let s = "";
      for (let i = 0; i < buf.length; i += 0x8000) {
        s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      }
      return { ok: true, mime: blob.type || "image/png", b64: btoa(s) };
    } catch (e) {
      return { ok: false, err: String(e) };
    }
  }, src);
  if (!result?.ok) throw new Error(`failed to download generated image: ${result?.err}`);
  return { b64: result.b64, mime: result.mime };
}

export function buildImagePrompt(prompt, size) {
  const hints = size ? ` (aspect ratio ${size})` : "";
  return `Generate an image${hints}: ${prompt}`;
}

// What the page shows when nothing recognizable happened (dialog, sign-in
// wall, changed layout) — appended to errors so the cause is visible in logs.
async function describePage(page) {
  // Last failure's screenshot, for debugging on the server.
  await page.screenshot({ path: path.join(os.tmpdir(), "gemini-web-last.png") }).catch(() => {});
  try {
    const info = await page.evaluate(() => {
      const box = document.querySelector("rich-textarea .ql-editor, .ql-editor");
      const send = document.querySelector("button.send-button, button[aria-label*='Send' i], button[aria-label*='Gửi']");
      const active = document.activeElement;
      return {
        text: ((document.querySelector("main") || document.body)?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 300),
        composer: box ? `${(box.innerText || "").trim().length} chars` : "missing",
        send: send ? `${send.getAttribute("aria-label") || send.className}${send.disabled || send.getAttribute("aria-disabled") === "true" ? " (disabled)" : ""}` : "missing",
        focus: active ? `${active.tagName.toLowerCase()}.${String(active.className || "").split(" ")[0]}` : "none",
        dialogs: document.querySelectorAll("[role='dialog'], mat-dialog-container, .cdk-overlay-pane").length,
      };
    });
    return ` (page: ${page.url()}; composer: ${info.composer}; send: ${info.send}; focus: ${info.focus}; dialogs: ${info.dialogs}${info.text ? ` — "${info.text}"` : ""})`;
  } catch {
    return "";
  }
}

/**
 * Wait for the generated image inside the reply that follows the just-sent
 * message and return it as base64. Completion: an <img> with a real
 * (non-gstatic, loaded) source is present and the turn is no longer working.
 */
export async function waitForGeminiImage(page, { timeoutMs = IMAGE_TIMEOUT_MS, signal }) {
  const started = Date.now();
  let sawActivity = false;
  let lastText = "";
  let textSince = 0;
  const withReply = (message) => (lastText ? `${message} — Gemini replied: ${lastText}` : message);

  while (true) {
    if (signal?.aborted) throw new Error("Request aborted");
    if (Date.now() - started > timeoutMs) {
      throw new Error(withReply("Gemini image generation timed out") + (lastText ? "" : await describePage(page)));
    }
    await sleep(POLL_INTERVAL_MS);

    const st = await readImageState(page);
    if (st.text !== lastText) {
      lastText = st.text || "";
      textSince = Date.now();
    }
    if (st.count > 0 || st.generating) sawActivity = true;
    if (!sawActivity && Date.now() - started > FIRST_TOKEN_TIMEOUT_MS) {
      throw new Error(`no first sign of activity from Gemini${await describePage(page)}`);
    }

    const ready = st.images.filter((i) => i.w >= MIN_IMAGE_EDGE);
    if (ready.length > 0 && !st.generating) {
      const image = ready[ready.length - 1];
      const media = await fetchImageAsBase64(page, image.src);
      return { ...media, width: image.w, height: image.h };
    }
    if (lastText && !st.generating && st.images.length === 0 && Date.now() - textSince > TEXT_ONLY_GRACE_MS) {
      throw new Error(withReply("Gemini did not return an image"));
    }
  }
}
