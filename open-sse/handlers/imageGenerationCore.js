import { createErrorResult, parseUpstreamError, formatProviderError } from "../utils/error.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";
import { refreshWithRetry } from "../services/tokenRefresh.js";
import { getExecutor } from "../executors/index.js";
import { getImageAdapter } from "./imageProviders/index.js";
import { urlToBase64 } from "./imageProviders/_base.js";

function serializeRequestBody(requestBody) {
  if (typeof FormData !== "undefined" && requestBody instanceof FormData) return requestBody;
  if (typeof requestBody === "string") return requestBody;
  return JSON.stringify(requestBody);
}

/**
 * Core image generation handler — orchestrator only.
 * Provider-specific URL/headers/body/parse/normalize live in `./imageProviders/{id}.js`.
 *
 * @param {object} options
 * @param {object} options.body - Request body { model, prompt, n, size, ... }
 * @param {object} options.modelInfo - { provider, model }
 * @param {object} options.credentials - Provider credentials
 * @param {object} [options.log] - Logger
 * @param {boolean} [options.streamToClient] - Pipe SSE to client (codex)
 * @param {boolean} [options.binaryOutput] - Return raw image bytes
 * @param {function} [options.onCredentialsRefreshed]
 * @param {function} [options.onRequestSuccess]
 * @param {function} [options.onUsage] - Receives exact provider-reported usage when available
 * @returns {Promise<{ success: boolean, response: Response, status?: number, error?: string }>}
 */
export async function handleImageGenerationCore({
  body,
  modelInfo,
  credentials,
  log,
  streamToClient = false,
  binaryOutput = false,
  onCredentialsRefreshed,
  onRequestSuccess,
  onUsage,
}) {
  const { provider, model } = modelInfo;

  if (!body.prompt) {
    return createErrorResult(HTTP_STATUS.BAD_REQUEST, "Missing required field: prompt");
  }

  const adapter = getImageAdapter(provider);
  if (!adapter) {
    return createErrorResult(
      HTTP_STATUS.BAD_REQUEST,
      `Provider '${provider}' does not support image generation`
    );
  }

  // Executor-delegating adapters: skip manual URL/headers/body, use the proven executor flow
  if (adapter.useExecutor && adapter.executeViaExecutor) {
    log?.debug?.("IMAGE", `${provider.toUpperCase()} | ${model} | prompt="${body.prompt.slice(0, 50)}..." (executor)`);
    const execPromise = adapter.executeViaExecutor(model, body, credentials, log);
    execPromise.catch(() => {});

    // Streaming clients: if the executor is still running after 10s, open SSE and send
    // progress keepalives so idle proxies don't cut the request. Fast results/errors
    // still go through the normal path below (keeps account fallback working).
    if (streamToClient && !binaryOutput) {
      const settled = await Promise.race([
        execPromise.then(() => true, () => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 10000)),
      ]);
      if (!settled) {
        return { success: true, response: buildExecutorSseResponse(execPromise) };
      }
    }

    function buildExecutorSseResponse(promise) {
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
            const responseBody = await promise;
            if (onRequestSuccess) await onRequestSuccess();
            const normalized = adapter.normalize(responseBody, body.prompt);
            const finalBody = (normalized.created && Array.isArray(normalized.data)) ? normalized : responseBody;
            send("done", finalBody);
          } catch (error) {
            const errMsg = formatProviderError(error, provider, model, HTTP_STATUS.BAD_GATEWAY);
            log?.debug?.("IMAGE", `Executor stream error: ${errMsg}`);
            send("error", { message: errMsg });
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

    try {
      const responseBody = await execPromise;
      if (onRequestSuccess) await onRequestSuccess();
      const normalized = adapter.normalize(responseBody, body.prompt);
      const finalBody = (normalized.created && Array.isArray(normalized.data)) ? normalized : responseBody;

      if (binaryOutput) {
        const first = finalBody.data?.[0];
        let b64 = first?.b64_json;
        if (!b64 && first?.url) {
          try { b64 = await urlToBase64(first.url); } catch {}
        }
        if (b64) {
          const buf = Buffer.from(b64, "base64");
          const fmt = (body.output_format || "png").toLowerCase();
          const mime = fmt === "jpeg" || fmt === "jpg" ? "image/jpeg" : fmt === "webp" ? "image/webp" : "image/png";
          return {
            success: true,
            response: new Response(buf, {
              headers: { "Content-Type": mime, "Content-Disposition": `inline; filename="image.${fmt === "jpeg" ? "jpg" : fmt}"`, "Access-Control-Allow-Origin": "*" },
            }),
          };
        }
      }

      return {
        success: true,
        response: new Response(JSON.stringify(finalBody), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        }),
      };
    } catch (error) {
      const errMsg = formatProviderError(error, provider, model, HTTP_STATUS.BAD_GATEWAY);
      log?.debug?.("IMAGE", `Executor error: ${errMsg}`);
      return createErrorResult(HTTP_STATUS.BAD_GATEWAY, errMsg);
    }
  }

  let url;
  let headers;
  let requestBody;

  try {
    url = adapter.buildUrl(model, credentials);
    requestBody = await adapter.buildBody(model, body);
    headers = adapter.buildHeaders(credentials, requestBody, model, body);
  } catch (error) {
    return createErrorResult(HTTP_STATUS.BAD_REQUEST, error.message || `Invalid ${provider} image request`);
  }

  log?.debug?.("IMAGE", `${provider.toUpperCase()} | ${model} | prompt="${body.prompt.slice(0, 50)}..."`);

  // Fetch provider, with one token refresh + retry on 401/403. Throws on network error.
  const fetchProvider = async () => {
    let res = await fetch(url, {
      method: "POST",
      headers,
      body: serializeRequestBody(requestBody),
    });

    // Handle 401/403 — try token refresh (skipped for noAuth providers)
    const executor = getExecutor(provider);
    if (
      !executor?.noAuth &&
      !adapter.noAuth &&
      (res.status === HTTP_STATUS.UNAUTHORIZED || res.status === HTTP_STATUS.FORBIDDEN)
    ) {
      const newCredentials = await refreshWithRetry(
        () => executor.refreshCredentials(credentials, log),
        3,
        log
      );

      if (newCredentials?.accessToken || newCredentials?.apiKey) {
        log?.info?.("TOKEN", `${provider.toUpperCase()} | refreshed for image generation`);
        Object.assign(credentials, newCredentials);
        if (onCredentialsRefreshed) await onCredentialsRefreshed(newCredentials);

        try {
          const retryBody = await adapter.buildBody(model, body);
          const retryHeaders = adapter.buildHeaders(credentials, retryBody, model, body);
          const retryUrl = adapter.buildUrl(model, credentials);
          res = await fetch(retryUrl, {
            method: "POST",
            headers: retryHeaders,
            body: serializeRequestBody(retryBody),
          });
        } catch {
          log?.warn?.("TOKEN", `${provider.toUpperCase()} | retry after refresh failed`);
        }
      } else {
        log?.warn?.("TOKEN", `${provider.toUpperCase()} | refresh failed`);
      }
    }
    return res;
  };

  // Streaming adapters (codex): open the SSE response to the client immediately and send
  // keepalive comments while waiting on the provider. Codex can stay silent for 30s+ before
  // its first byte (e.g. with reference images), and proxies cut idle connections.
  // Wait briefly first so fast provider errors (429, 5xx) still return a normal error result
  // and the caller can fall back to another account.
  let pendingResponse = null;
  if (streamToClient && adapter.stream && adapter.parseResponse) {
    pendingResponse = fetchProvider();
    pendingResponse.catch(() => {});
    const EARLY_STREAM_AFTER_MS = 10000;
    const settled = await Promise.race([
      pendingResponse.then(() => true, () => true),
      new Promise((resolve) => setTimeout(() => resolve(false), EARLY_STREAM_AFTER_MS)),
    ]);
    if (!settled) {
      return { success: true, response: buildEarlySseResponse(pendingResponse) };
    }
  }

  function buildEarlySseResponse(resPromise) {
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        let closed = false;
        const write = (chunk) => { if (!closed) { try { controller.enqueue(enc.encode(chunk)); } catch { closed = true; } } };
        const send = (event, data) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        const keepalive = setInterval(() => write(": keepalive\n\n"), 15000);
        send("progress", { stage: "queued", bytesReceived: 0 });
        try {
          const res = await resPromise;
          if (!res.ok) {
            const { statusCode, message } = await parseUpstreamError(res);
            const errMsg = formatProviderError(new Error(message), provider, model, statusCode);
            log?.debug?.("IMAGE", `Provider error: ${errMsg}`);
            send("error", { status: statusCode, message: errMsg });
            return;
          }
          const parsed = await adapter.parseResponse(res, {
            headers, log, streamToClient: true, onRequestSuccess, onUsage, url, requestBody, model, body,
          });
          const reader = parsed?.sseResponse?.body?.getReader();
          if (!reader) {
            send("error", { message: `Invalid stream from ${provider}` });
            return;
          }
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (closed) { reader.cancel().catch(() => {}); break; }
            controller.enqueue(value);
          }
        } catch (error) {
          const errMsg = formatProviderError(error, provider, model, HTTP_STATUS.BAD_GATEWAY);
          log?.debug?.("IMAGE", `Stream error: ${errMsg}`);
          send("error", { message: errMsg });
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

  let providerResponse;
  try {
    providerResponse = await (pendingResponse || fetchProvider());
  } catch (error) {
    const errMsg = formatProviderError(error, provider, model, HTTP_STATUS.BAD_GATEWAY);
    log?.debug?.("IMAGE", `Fetch error: ${errMsg}`);
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, errMsg);
  }

  if (!providerResponse.ok) {
    // Pass the executor so provider-specific reset times (e.g. codex usage_limit resets_at) survive
    const { statusCode, message, resetsAtMs } = await parseUpstreamError(providerResponse, getExecutor(provider));
    const errMsg = formatProviderError(new Error(message), provider, model, statusCode);
    log?.debug?.("IMAGE", `Provider error: ${errMsg}`);
    return createErrorResult(statusCode, errMsg, resetsAtMs);
  }

  // Parse provider response — adapter may override (codex SSE / async polling / binary)
  let parsed;
  try {
    if (adapter.parseResponse) {
      parsed = await adapter.parseResponse(providerResponse, {
        headers,
        log,
        streamToClient,
        onRequestSuccess,
        onUsage,
        url,
        requestBody,
        model,
        body,
      });
      // Codex streaming case: returns an SSE Response directly
      if (parsed?.sseResponse) {
        return { success: true, response: parsed.sseResponse };
      }
    } else {
      parsed = await providerResponse.json();
    }
  } catch (parseError) {
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, parseError.message || `Invalid response from ${provider}`);
  }

  if (onRequestSuccess) await onRequestSuccess();

  // Normalize → OpenAI-compatible shape
  const normalized = adapter.normalize(parsed, body.prompt);

  // Already in OpenAI shape? skip re-normalize
  const finalBody = (normalized.created && Array.isArray(normalized.data)) ? normalized : parsed;

  // Binary output: decode first b64_json (or fetch url) into raw bytes
  if (binaryOutput) {
    const first = finalBody.data?.[0];
    let b64 = first?.b64_json;
    if (!b64 && first?.url) {
      try { b64 = await urlToBase64(first.url); } catch {}
    }
    if (b64) {
      const buf = Buffer.from(b64, "base64");
      const fmt = (body.output_format || "png").toLowerCase();
      const mime = fmt === "jpeg" || fmt === "jpg" ? "image/jpeg" : fmt === "webp" ? "image/webp" : "image/png";
      return {
        success: true,
        response: new Response(buf, {
          headers: {
            "Content-Type": mime,
            "Content-Disposition": `inline; filename="image.${fmt === "jpeg" ? "jpg" : fmt}"`,
            "Access-Control-Allow-Origin": "*",
          },
        }),
      };
    }
  }

  return {
    success: true,
    response: new Response(JSON.stringify(finalBody), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    }),
  };
}
