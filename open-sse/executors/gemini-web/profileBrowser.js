// Signed-in browser profile for Gemini Web connections made with Login via
// Browser. Google treats session cookies replayed in a fresh (headless)
// browser as a hijacked session: the UI still looks signed in, but image
// generation answers "Are you signed in?" or never replies, and the original
// profile gets signed out. Driving the very profile the user signed in with
// keeps the same device, cookies and history.
//
// A Chromium profile can only be opened once, so requests on one profile run
// one at a time; the window stays open between requests and closes when idle.

import { loadRuntimeDep } from "../../services/lazyRuntime.js";
import { resolveSystemChromeExecutable } from "../browserExecutableCheck.js";
import { isWebLoginProfileBusy, registerProfileCloser, webLoginProfileDir } from "../../services/webLogin.js";

export const GEMINI_PROFILE_IDLE_MS = 5 * 60 * 1000;

// profile -> { context, tail, idleTimer }
const slots = new Map();

function slotFor(profile) {
  let slot = slots.get(profile);
  if (!slot) {
    slot = { context: null, tail: Promise.resolve(), idleTimer: null };
    slots.set(profile, slot);
    // Login via Browser needs the profile for itself: close our window first.
    registerProfileCloser(profile, () => closeGeminiProfile(profile));
  }
  return slot;
}

async function launchProfile(profile) {
  const { chromium } = await loadRuntimeDep("playwright-core");
  const executablePath = resolveSystemChromeExecutable();
  if (!executablePath) {
    throw new Error("No Chrome/Chromium executable found — set CHROME_PATH or install Google Chrome");
  }
  const options = {
    headless: false,
    executablePath,
    viewport: { width: 1280, height: 800 },
    args: ["--disable-blink-features=AutomationControlled"],
    ignoreDefaultArgs: ["--enable-automation"],
  };
  // Keep Chromium's sandbox (Playwright drops it by default) unless the host
  // cannot start with it — same as the Login via Browser window.
  try {
    return await chromium.launchPersistentContext(webLoginProfileDir(profile), { ...options, chromiumSandbox: true });
  } catch (error) {
    if (!/sandbox|namespace|zygote/i.test(String(error?.message || ""))) throw error;
    return chromium.launchPersistentContext(webLoginProfileDir(profile), options);
  }
}

function scheduleIdleClose(profile, slot) {
  clearTimeout(slot.idleTimer);
  slot.idleTimer = setTimeout(() => {
    slot.idleTimer = null;
    void closeGeminiProfile(profile);
  }, GEMINI_PROFILE_IDLE_MS);
  slot.idleTimer.unref?.();
}

/**
 * Wait for this profile's turn, then open a new tab in its window.
 * @returns {Promise<{ page: import("playwright-core").Page, release: () => Promise<void> }>}
 */
export async function acquireGeminiProfilePage(profile) {
  const slot = slotFor(profile);
  let unlock;
  const turn = new Promise((resolve) => { unlock = resolve; });
  const previous = slot.tail;
  slot.tail = previous.then(() => turn);
  await previous;

  try {
    clearTimeout(slot.idleTimer);
    if (isWebLoginProfileBusy(profile)) {
      throw new Error(`Login via Browser is open on profile "${profile}" — finish it, then retry`);
    }
    if (!slot.context) {
      const context = await launchProfile(profile);
      context.on("close", () => {
        if (slot.context === context) slot.context = null;
      });
      slot.context = context;
    }
    const page = await slot.context.newPage();
    let released = false;
    return {
      page,
      release: async () => {
        if (released) return;
        released = true;
        await page.close().catch(() => {});
        scheduleIdleClose(profile, slot);
        unlock();
      },
    };
  } catch (error) {
    scheduleIdleClose(profile, slot);
    unlock();
    throw error;
  }
}

/** Close the profile window (idle timeout, or Login via Browser taking over). */
export async function closeGeminiProfile(profile) {
  const slot = slots.get(profile);
  if (!slot?.context) return;
  clearTimeout(slot.idleTimer);
  const context = slot.context;
  slot.context = null;
  await context.close().catch(() => {});
}
