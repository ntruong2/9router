import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { getSettings } from "@/lib/localDb";
import { getModelInfo, getComboModels } from "../services/model.js";
import { getKeyAccessContext, enforceKeyAccess } from "../services/keyAccess.js";
import { handleImageGenerationCore } from "open-sse/handlers/imageGenerationCore.js";
import { getImageAdapter, getImageInputSupport, supportsImageMask } from "open-sse/handlers/imageProviders/index.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { handleComboChat } from "open-sse/services/combo.js";
import * as log from "../utils/logger.js";
import { saveRequestUsage } from "@/lib/usageDb.js";
import { releaseAfterEventStream } from "@/shared/services/sessionLoad.js";

// Providers that don't require credentials (noAuth)
const NO_AUTH_PROVIDERS = new Set(["sdwebui", "comfyui", "veoaifree-web"]);
const imageIdempotency = globalThis[Symbol.for("9router.imageIdempotency")] ||= new Map();
const IMAGE_IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
const IMAGE_IDEMPOTENCY_MAX_ENTRIES = 200;

function recordImageRequestUsage({ provider, model, connectionId, apiKey, endpoint, usage, startedAt }) {
  if (!usage || typeof usage !== "object") return;
  const promptTokens = usage.prompt_tokens;
  const completionTokens = usage.completion_tokens;
  if (!Number.isSafeInteger(promptTokens) || promptTokens < 0 ||
      !Number.isSafeInteger(completionTokens) || completionTokens < 0) {
    return;
  }

  saveRequestUsage({
    provider,
    model,
    connectionId: connectionId || undefined,
    apiKey: apiKey || undefined,
    endpoint: endpoint || null,
    tokens: usage,
    status: "success",
    ...(startedAt ? { latency: { total: Date.now() - startedAt } } : {}),
  }).catch(() => {});
}

async function readJsonBody(request) {
  try {
    return { body: await request.json() };
  } catch {
    return { status: HTTP_STATUS.BAD_REQUEST, message: "Invalid JSON body" };
  }
}

/**
 * Handle image generation request
 * @param {Request} request
 * @param {object} [options]
 * @param {(request: Request) => Promise<{body?: object, status?: number, message?: string}>} [options.readBody]
 *   Body reader; runs after the API key check so unauthenticated uploads are never parsed.
 * @param {boolean} [options.edit] - /v1/images/edits: body.images holds the input images
 */
export async function handleImageGeneration(request, { readBody = readJsonBody, edit = false } = {}) {
  const startedAt = Date.now();
  const url = new URL(request.url);
  const preferredConnectionId = request.headers.get("x-connection-id") || null;
  const wantsStream = (request.headers.get("accept") || "").includes("text/event-stream");
  const binaryOutput = url.searchParams.get("response_format") === "binary";

  const apiKey = extractApiKey(request);
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!apiKey) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    const valid = await isValidApiKey(apiKey);
    if (!valid) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
  }

  const parsed = await readBody(request);
  if (!parsed?.body) return errorResponse(parsed?.status || HTTP_STATUS.BAD_REQUEST, parsed?.message || "Invalid request body");
  const body = parsed.body;
  // A slow upload (large multipart behind a tunnel) eats into the proxy's time budget; log it so a
  // client-side cut can be told apart from a slow provider.
  const bodyMs = Date.now() - startedAt;
  log.info("IMAGE", `${edit ? "edit" : "generate"} ${body.model || "?"} · body read ${(bodyMs / 1000).toFixed(1)}s${request.headers.get("content-length") ? ` · ${(Number(request.headers.get("content-length")) / 1048576).toFixed(1)}MB` : ""}`);
  // OpenAI-style streaming (edits only): `stream: true` in the form/JSON body, not the Accept header.
  const openAiStream = edit && body.stream === true;
  delete body.stream;
  const modelStr = body.model;
  const idempotencyKey = request.headers.get("Idempotency-Key")?.trim();

  if (!modelStr) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  if (!body.prompt) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: prompt");

  // Per-key access control: requested target, before combo expansion.
  const keyAccessDenied = await enforceKeyAccess(await getKeyAccessContext(request), modelStr);
  if (keyAccessDenied) return keyAccessDenied;

  // Combo expansion: model may be a combo name → run fallback/round-robin across models
  // Streaming clients get an SSE response right away with progress keepalives, while the normal
  // non-stream flow runs underneath so account fallback, locks and combos keep working.
  // Opening SSE per attempt meant a slow upstream error (e.g. Antigravity 429 after ~17s) ended
  // the stream without locking the account or trying the next one.
  const run = async () => {
    const comboModels = await getComboModels(modelStr);
    if (comboModels) {
      const comboStrategies = settings.comboStrategies || {};
      const comboStrategy = comboStrategies[modelStr]?.fallbackStrategy || settings.comboStrategy || "fallback";
      const comboStickyLimit = settings.comboStickyRoundRobinLimit;
      log.info("IMAGE", `Combo "${modelStr}" with ${comboModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
      return handleComboChat({
        body,
        models: comboModels,
        handleSingleModel: (b, m) => handleSingleModelImage(b, m, { wantsStream: false, binaryOutput, preferredConnectionId, apiKey, endpoint: url.pathname, edit, signal: request.signal, queueTimeoutMs: settings.imageQueueTimeoutMs, jobTimeoutMs: settings.imageJobTimeoutMs, startedAt }),
        log,
        comboName: modelStr,
        comboStrategy,
        comboStickyLimit,
      });
    }
    return handleSingleModelImage(body, modelStr, { wantsStream: false, binaryOutput, preferredConnectionId, apiKey, endpoint: url.pathname, edit, signal: request.signal, queueTimeoutMs: settings.imageQueueTimeoutMs, jobTimeoutMs: settings.imageJobTimeoutMs, startedAt });
  };

  // Look the key up BEFORE starting work: a retried request must reuse the first run instead of
  // calling the provider (and spending quota) again.
  let responsePromise;
  if (idempotencyKey) {
    const cacheKey = `${apiKey || "local"}:${idempotencyKey}`;
    const existing = imageIdempotency.get(cacheKey);
    if (existing && existing.expiresAt > Date.now()) responsePromise = existing.promise.then((response) => response.clone());
    else {
      if (existing) imageIdempotency.delete(cacheKey);
      // Bound memory: entries hold a full image response, so evict the oldest beyond the cap.
      while (imageIdempotency.size >= IMAGE_IDEMPOTENCY_MAX_ENTRIES) imageIdempotency.delete(imageIdempotency.keys().next().value);
      responsePromise = run();
      const cachedPromise = responsePromise.then((response) => response.clone());
      imageIdempotency.set(cacheKey, { promise: cachedPromise, expiresAt: Date.now() + IMAGE_IDEMPOTENCY_TTL_MS });
      cachedPromise.finally(() => setTimeout(() => {
        const current = imageIdempotency.get(cacheKey);
        if (current?.promise === cachedPromise) imageIdempotency.delete(cacheKey);
      }, IMAGE_IDEMPOTENCY_TTL_MS)).catch(() => {});
    }
  }
  responsePromise ??= run();
  if (openAiStream && !binaryOutput) return openAiSseFromResponse(responsePromise, "image_edit");
  if (wantsStream && !binaryOutput) return sseFromResponse(responsePromise);
  // Edits routinely take 60-120s. Behind Cloudflare an origin that sends nothing for ~100s is cut
  // (HTTP 524, or a bare TCP reset for some clients), and the upload itself already uses part of that
  // budget. So a plain-JSON edit that is not done within 20s is answered early with HTTP 200 and kept
  // alive with whitespace until the body is ready.
  if (edit && !binaryOutput) return jsonWithKeepalive(responsePromise, JSON_KEEPALIVE_AFTER_MS);
  return responsePromise;
}

const JSON_KEEPALIVE_AFTER_MS = 20000;
const JSON_KEEPALIVE_EVERY_MS = 10000;

const NO_BUFFER_HEADERS = {
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
  "Access-Control-Allow-Origin": "*",
};

// Return the response untouched when it is ready within afterMs. Otherwise commit to HTTP 200 and
// stream spaces (valid leading JSON whitespace) until the real body is ready; from then on an
// upstream failure can only be reported inside the JSON body ({"error":{...}}), not as a status.
async function jsonWithKeepalive(responsePromise, afterMs) {
  const SLOW = Symbol("slow");
  let timer;
  const first = await Promise.race([
    responsePromise,
    new Promise((resolve) => { timer = setTimeout(() => resolve(SLOW), afterMs); }),
  ]);
  clearTimeout(timer);
  if (first !== SLOW) return first;

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const write = (text) => { if (!closed) { try { controller.enqueue(enc.encode(text)); } catch { closed = true; } } };
      write(" ");
      const keepalive = setInterval(() => write(" "), JSON_KEEPALIVE_EVERY_MS);
      try {
        const res = await responsePromise;
        write(await res.text());
      } catch (err) {
        write(JSON.stringify({ error: { message: err?.message || "Image generation failed", type: "api_error" } }));
      } finally {
        clearInterval(keepalive);
        closed = true;
        try { controller.close(); } catch {}
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/json", ...NO_BUFFER_HEADERS } });
}

// OpenAI-compatible image streaming: SSE comment keepalives every 10s (SDKs ignore them), then
// `<prefix>.completed` per image, or `error`. Used when the request body sets stream=true.
function openAiSseFromResponse(responsePromise, prefix) {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const write = (text) => { if (!closed) { try { controller.enqueue(enc.encode(text)); } catch { closed = true; } } };
      const event = (name, data) => write("event: " + name + "\ndata: " + JSON.stringify(data) + "\n\n");
      write(": open\n\n");
      const keepalive = setInterval(() => write(": keepalive\n\n"), 10000);
      try {
        const res = await responsePromise;
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch {}
        if (res.ok && Array.isArray(json?.data)) {
          for (const item of json.data) {
            event(`${prefix}.completed`, {
              type: `${prefix}.completed`,
              created_at: json.created,
              ...(item.b64_json ? { b64_json: item.b64_json } : {}),
              ...(item.url ? { url: item.url } : {}),
              ...(json.usage ? { usage: json.usage } : {}),
            });
          }
        } else {
          const message = json?.error?.message || json?.error || json?.message || text || `HTTP ${res.status}`;
          event("error", { type: "error", error: { message: typeof message === "string" ? message : JSON.stringify(message), type: "api_error", code: res.status } });
        }
      } catch (err) {
        event("error", { type: "error", error: { message: err?.message || "Image generation failed", type: "api_error", code: HTTP_STATUS.BAD_GATEWAY } });
      } finally {
        clearInterval(keepalive);
        closed = true;
        try { controller.close(); } catch {}
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Connection": "keep-alive", ...NO_BUFFER_HEADERS } });
}

// Wrap a (possibly slow) JSON Response promise as SSE: `progress` every 10s, then `done` with the
// OpenAI-style body or `error` with status + message.
function sseFromResponse(responsePromise) {
  const enc = new TextEncoder();
  const startedAt = Date.now();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (event, data) => {
        if (closed) return;
        try { controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch { closed = true; }
      };
      const progress = () => send("progress", { stage: "generating", elapsedMs: Date.now() - startedAt });
      progress();
      const keepalive = setInterval(progress, 10000);
      try {
        const res = await responsePromise;
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch {}
        if (res.ok && json) {
          send("done", json);
        } else {
          const message = json?.error?.message || json?.error || json?.message || text || `HTTP ${res.status}`;
          send("error", { status: res.status, message: typeof message === "string" ? message : JSON.stringify(message) });
        }
      } catch (err) {
        send("error", { status: HTTP_STATUS.BAD_GATEWAY, message: err?.message || "Image generation failed" });
      } finally {
        clearInterval(keepalive);
        closed = true;
        try { controller.close(); } catch {}
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// Map normalized edit input (body.images, body.mask) onto the fields the provider's
// adapter reads. Providers that would silently ignore the input image are rejected.
function buildEditBody(body, provider, model) {
  const support = getImageInputSupport(provider);
  const label = `${provider}/${model}`;
  if (!support) return { error: `Model ${label} does not support image edits` };
  const { images = [], ...rest } = body;
  if (support === "single" && images.length > 1) return { error: `Model ${label} accepts only one input image` };
  if (rest.mask && !supportsImageMask(provider)) return { error: `Model ${label} does not support mask` };
  return { body: images.length === 1 ? { ...rest, image: images[0] } : { ...rest, images } };
}

async function handleSingleModelImage(body, modelStr, { wantsStream, binaryOutput, preferredConnectionId, apiKey, endpoint, edit, signal, queueTimeoutMs, jobTimeoutMs, startedAt } = {}) {
  const modelInfo = await getModelInfo(modelStr);
  if (!modelInfo.provider) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");

  const { provider, model } = modelInfo;

  if (edit) {
    const prepared = buildEditBody(body, provider, model);
    if (prepared.error) return errorResponse(HTTP_STATUS.BAD_REQUEST, prepared.error);
    body = prepared.body;
  }

  // noAuth providers — no credential needed
  if (NO_AUTH_PROVIDERS.has(provider)) {
    const result = await handleImageGenerationCore({ body, modelInfo: { provider, model }, credentials: null, binaryOutput });
    if (result.success) return result.response;
    return errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, result.error || "Image generation failed");
  }

  // Credentialed providers — fallback loop
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;
  let queueDeadline;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model, {
      preferredConnectionId,
      reserveImageSlot: true,
    });

    if (credentials?.waitForImageSlot) {
      const timeoutMs = queueTimeoutMs || 30_000;
      // One overall queue deadline: a freed slot taken by another request must not restart the wait.
      queueDeadline ??= performance.now() + timeoutMs;
      const remaining = queueDeadline - performance.now();
      if (remaining > 0 && await credentials.waitForImageSlot(remaining, signal)) continue;
      return unavailableResponse(HTTP_STATUS.SERVICE_UNAVAILABLE, `[${provider}/${model}] image capacity is full`, new Date(Date.now() + timeoutMs).toISOString(), `retry after ${Math.ceil(timeoutMs / 1000)}s`);
    }

    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) {
        return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${provider}`);
      }
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    let refreshedCredentials;
    try {
      refreshedCredentials = await checkAndRefreshToken(provider, credentials);
    } catch (error) {
      credentials.releaseImageSlot?.();
      throw error;
    }

    // Skip accounts the adapter knows cannot generate images (e.g. ChatGPT Free on codex)
    // without locking them: they stay usable for chat.
    const adapter = getImageAdapter(provider);
    if (adapter?.canUseCredentials && !adapter.canUseCredentials(refreshedCredentials)) {
      log.info("IMAGE", `[${provider}/${model}] skip connection ${credentials.connectionId.slice(0, 8)}: plan not entitled to image generation`);
      excludeConnectionIds.add(credentials.connectionId);
      credentials.releaseImageSlot?.();
      lastError = lastError || "No account entitled to image generation (ChatGPT Free plans are not supported)";
      lastStatus = lastStatus || HTTP_STATUS.FORBIDDEN;
      continue;
    }

    let result;
    const timeoutController = new AbortController();
    const timeoutMs = jobTimeoutMs || 10 * 60_000;
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;
    const timeout = setTimeout(() => timeoutController.abort(new Error("Image generation timeout")), timeoutMs);
    try {
      result = await handleImageGenerationCore({
      body,
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      streamToClient: wantsStream,
      binaryOutput,
      signal: combinedSignal,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          accessToken: newCreds.accessToken,
          refreshToken: newCreds.refreshToken,
          providerSpecificData: newCreds.providerSpecificData,
          testStatus: "active"
        });
      },
      onUsage: (usage) => {
        recordImageRequestUsage({
          provider,
          model,
          connectionId: credentials.connectionId,
          apiKey,
          endpoint,
          usage,
          startedAt,
        });
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
        // Cookies that rotate on use (Clerk `__client`) are mutated in place by
        // the executor — persist the new value so the chain does not drift.
        if (refreshedCredentials.apiKey && refreshedCredentials.apiKey !== credentials.apiKey) {
          await updateProviderCredentials(credentials.connectionId, { apiKey: refreshedCredentials.apiKey });
        }
      }
      });
    } catch (error) {
      credentials.releaseImageSlot?.({ error: true });
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    if (result.success) {
      if (startedAt) log.info("IMAGE", `[${provider}/${model}] done ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
      if (result.response?.headers?.get("content-type")?.includes("text/event-stream")) {
        return releaseAfterEventStream(result.response, credentials.releaseImageSlot, signal);
      }
      credentials.releaseImageSlot?.();
      return result.response;
    }

    credentials.releaseImageSlot?.();

    const { shouldFallback } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model, result.resetsAtMs || null);

    if (shouldFallback) {
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }

    return result.response;
  }
}
