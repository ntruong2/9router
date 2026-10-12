"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import ProviderIcon from "@/shared/components/ProviderIcon";

// Client tools shown as a plain "works with" strip — no dashed connector lines.
const CLI_TOOLS = [
  { id: "claude", name: "Claude Code", image: "/providers/claude.png" },
  { id: "codex", name: "OpenAI Codex", image: "/providers/codex.png" },
  { id: "antigravity", name: "Antigravity", image: "/providers/antigravity.png" },
  { id: "cursor", name: "Cursor", image: "/providers/cursor.png" },
];

const PROVIDER_ICONS = {
  claude: "/providers/claude.png",
  antigravity: "/providers/antigravity.png",
  codex: "/providers/codex.png",
  gemini: "/providers/gemini.png",
  github: "/providers/github.png",
  cline: "/providers/cline.png",
  cursor: "/providers/cursor.png",
  kiro: "/providers/kiro.png",
};

const POLL_MS = 3000;
const FE_ACTIVE_TIMEOUT_MS = 60000;
const FE_ACTIVE_TICK_MS = 1000;

const STATE_COLOR = { active: "#00d4d4", last: "#f59e0b", limited: "#dc2626", idle: "#4b5563" };
const STATE_DOT = { active: "bg-[#00d4d4]", last: "bg-amber-500", limited: "bg-red-600", idle: "bg-gray-600" };

function formatResetDuration(resetAt) {
  if (!resetAt) return null;
  const ms = new Date(resetAt).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hours}h${remMins ? ` ${remMins}m` : ""}`;
}

export default function StatusGrid() {
  const [providers, setProviders] = useState(null); // null = first load in flight
  const [rawActiveIds, setRawActiveIds] = useState([]);
  const [lastProviderId, setLastProviderId] = useState(null);
  const [errorProviderId, setErrorProviderId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      fetch("/api/public/status")
        .then((res) => res.json())
        .then((data) => {
          if (cancelled) return;
          setProviders(Array.isArray(data.providers) ? data.providers : []);
          setRawActiveIds(Array.isArray(data.activeProviderIds) ? data.activeProviderIds : []);
          setLastProviderId(data.lastProviderId || null);
          setErrorProviderId(data.errorProviderId || null);
        })
        .catch(() => {
          if (!cancelled) setProviders((prev) => prev ?? []);
        });
    };
    poll();
    const interval = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const list = providers || [];

  // A provider only counts as "active" for up to FE_ACTIVE_TIMEOUT_MS, in case
  // the backend signal gets stuck on (mirrors the dashboard's own topology).
  const firstSeenRef = useRef({});
  const [tick, setTick] = useState(0);
  const rawActiveKey = rawActiveIds.join(",");

  useEffect(() => {
    const seen = firstSeenRef.current;
    const now = Date.now();
    for (const p of rawActiveIds) {
      if (!seen[p]) seen[p] = now;
    }
    for (const p of Object.keys(seen)) {
      if (!rawActiveIds.includes(p)) delete seen[p];
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawActiveKey]);

  useEffect(() => {
    if (rawActiveIds.length === 0) return;
    const id = setInterval(() => setTick((t) => t + 1), FE_ACTIVE_TICK_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawActiveKey]);

  const activeSet = useMemo(() => {
    const now = Date.now();
    const filtered = new Set();
    for (const p of rawActiveIds) {
      const ts = firstSeenRef.current[p];
      if (!ts || now - ts < FE_ACTIVE_TIMEOUT_MS) filtered.add(p);
    }
    return filtered;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawActiveKey, tick]);

  function stateFor(provider) {
    const id = provider?.id?.toLowerCase();
    if (errorProviderId && id === errorProviderId.toLowerCase()) return "active"; // still flash, error styling comes from the ring color below
    if (activeSet.has(id)) return "active";
    if (provider?.errorCode) return "limited";
    if (lastProviderId && id === lastProviderId.toLowerCase()) return "last";
    return "idle";
  }

  return (
    <div className="mt-16 w-full max-w-4xl">
      <div className="rounded-2xl border border-[#123433] bg-[#0a1414]/60 backdrop-blur-sm p-6 sm:p-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2 text-xs font-[family-name:var(--font-landing-mono)] text-gray-400 uppercase tracking-wider">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#00d4d4] opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-[#00d4d4]" />
            </span>
            Live status
          </div>
          <span className="text-[11px] text-gray-600">{list.length || 0} connected</span>
        </div>

        {/* Provider cards */}
        {providers === null && (
          <div className="py-10 text-center text-sm text-gray-600">Loading…</div>
        )}
        {providers !== null && list.length === 0 && (
          <div className="py-10 text-center text-sm text-gray-600">No providers connected yet</div>
        )}
        {list.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {list.map((provider) => {
              const state = stateFor(provider);
              const isErrorEvent = errorProviderId && provider.id?.toLowerCase() === errorProviderId.toLowerCase();
              const ringColor = isErrorEvent ? "#ef4444" : STATE_COLOR[state];
              const remaining = typeof provider.percentUsed === "number" ? 100 - provider.percentUsed : null;
              const resetDuration = formatResetDuration(provider.resetAt);

              return (
                <div
                  key={provider.id}
                  className="rounded-xl border border-[#123433] bg-[#050505] p-4 flex items-center gap-4 transition-colors hover:border-[#00d4d4]/40"
                >
                  {/* Radial remaining-quota ring */}
                  <div
                    className="relative w-16 h-16 rounded-full flex items-center justify-center flex-none"
                    style={{
                      background:
                        remaining === null
                          ? "#123433"
                          : `conic-gradient(${ringColor} ${remaining * 3.6}deg, #123433 0deg)`,
                    }}
                  >
                    <div className="absolute inset-[3px] rounded-full bg-[#050505] flex items-center justify-center overflow-hidden">
                      {PROVIDER_ICONS[provider.id] ? (
                        <ProviderIcon
                          src={PROVIDER_ICONS[provider.id]}
                          alt={provider.label}
                          size={28}
                          className="object-contain w-7 h-7"
                          fallbackText={provider.label.slice(0, 2).toUpperCase()}
                        />
                      ) : (
                        <span className="text-[10px] font-bold text-gray-400">
                          {provider.label.slice(0, 2).toUpperCase()}
                        </span>
                      )}
                    </div>
                    <span
                      className={`absolute -top-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-[#050505] ${STATE_DOT[isErrorEvent ? "limited" : state]}`}
                    />
                  </div>

                  {/* Text */}
                  <div className="min-w-0">
                    <div className="font-bold text-sm text-white truncate">{provider.label}</div>
                    <div className="text-[11px] text-gray-500 font-[family-name:var(--font-landing-mono)] flex flex-wrap items-center gap-x-1">
                      {remaining !== null ? (
                        <span>{remaining}% quota</span>
                      ) : (
                        <span>—</span>
                      )}
                      {resetDuration && (
                        <>
                          <span>·</span>
                          <span className="inline-flex items-center gap-1">
                            <span>resets</span>
                            <span>{resetDuration}</span>
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Works-with strip */}
        <div className="mt-8 pt-6 border-t border-[#123433] flex flex-col sm:flex-row items-center justify-center gap-4">
          <span className="text-[11px] text-gray-600 uppercase tracking-wider">Works with</span>
          <div className="flex items-center gap-3">
            {CLI_TOOLS.map((tool) => (
              <div
                key={tool.id}
                className="w-9 h-9 rounded-lg bg-[#050505] border border-[#123433] flex items-center justify-center overflow-hidden p-1.5 opacity-80 hover:opacity-100 transition-opacity"
                title={tool.name}
              >
                <ProviderIcon
                  src={tool.image}
                  alt={tool.name}
                  size={24}
                  className="object-contain max-w-full max-h-full"
                  fallbackText={tool.name.slice(0, 2).toUpperCase()}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
