"use client";

import { Fragment, useEffect, useState } from "react";
import Card from "@/shared/components/Card";
import { SegmentedControl } from "@/shared/components";
import { SPEED_RATING_THRESHOLDS } from "@/shared/services/speedStats.js";

const PERIODS = [
  { value: "1h", label: "1h" },
  { value: "6h", label: "6h" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7D" },
];
const REFRESH_MS = 30_000;

const RATING = {
  smooth: { label: "Smooth", className: "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300", bar: "bg-emerald-500" },
  normal: { label: "Normal", className: "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300", bar: "bg-amber-500" },
  slow: { label: "Slow", className: "border-red-500/20 bg-red-500/10 text-red-700 dark:text-red-300", bar: "bg-red-500" },
  unknown: { label: "No TTFT", className: "border-border bg-surface text-text-muted", bar: "bg-text-muted" },
};

const fmtMs = (ms) => (ms === null || ms === undefined ? "—" : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);
const fmtTokens = (n) => (n === null || n === undefined ? "—" : n >= 1000 ? `${Math.round(n / 1000)}K` : String(Math.round(n)));
const fmtTps = (n) => (n === null || n === undefined ? "—" : `${n.toFixed(0)} tok/s`);
const fmtPct = (n) => (n === null || n === undefined ? "—" : `${Math.round(n * 100)}%`);

function ratingFor(ms) {
  if (ms === null || ms === undefined) return "unknown";
  if (ms <= SPEED_RATING_THRESHOLDS.smooth.p50) return "smooth";
  if (ms <= SPEED_RATING_THRESHOLDS.normal.p50) return "normal";
  return "slow";
}

function RatingBadge({ rating }) {
  const style = RATING[rating] || RATING.unknown;
  return <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${style.className}`}>{style.label}</span>;
}

function Stat({ label, value, hint }) {
  return (
    <div className="min-w-0 rounded-xl border border-border/70 bg-surface/80 p-3">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">{label}</p>
      <p className="mt-1 truncate text-lg font-bold tabular-nums text-text-primary">{value}</p>
      {hint && <p className="mt-0.5 truncate text-[11px] text-text-muted">{hint}</p>}
    </div>
  );
}

// Recent requests as bars: height = time to first token (total time when not streamed).
function RecentBars({ recent }) {
  const values = recent.map((r) => r.ttftMs ?? r.totalMs);
  const max = Math.max(1, ...values);
  return (
    <div className="flex h-16 items-end gap-[2px]" aria-label="Recent requests, time to first token">
      {recent.map((r, i) => {
        const value = values[i];
        return (
          <div
            key={`${r.timestamp}-${i}`}
            className={`min-w-[3px] flex-1 rounded-t ${RATING[ratingFor(value)].bar}`}
            style={{ height: `${Math.max(4, (value / max) * 100)}%` }}
            title={`${new Date(r.timestamp).toLocaleTimeString()} · TTFT ${fmtMs(r.ttftMs)} · total ${fmtMs(r.totalMs)} · in ${fmtTokens(r.inputTokens)}`}
          />
        );
      })}
    </div>
  );
}

export default function SpeedStatsTab() {
  const [period, setPeriod] = useState("24h");
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    const load = () => fetch(`/api/usage/speed?period=${period}`, { cache: "no-store", signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((next) => { setData(next); setError(null); })
      .catch((err) => { if (err.name !== "AbortError") setError(err.message); });
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => { controller.abort(); clearInterval(timer); };
  }, [period]);

  const overall = data?.overall;
  const { smooth, normal } = SPEED_RATING_THRESHOLDS;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Card className="flex min-w-0 flex-col gap-4 p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <span className="material-symbols-outlined text-[19px]">speed</span>
            </span>
            <div>
              <h2 className="text-sm font-bold tracking-tight text-text-primary">Response speed</h2>
              <p className="text-[11px] text-text-muted">Time to first token (TTFT) is what you wait for. Refreshes every 30s.</p>
            </div>
          </div>
          <SegmentedControl options={PERIODS} value={period} onChange={setPeriod} size="sm" />
        </div>
        {error && <p className="text-xs text-red-500">Failed to load speed stats: {error}</p>}
        {overall && overall.requests === 0 && (
          <p className="text-xs text-text-muted">No timed requests in this window yet. Latency is recorded for requests made after this feature was deployed.</p>
        )}
        {overall && overall.requests > 0 && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            <Stat label="Requests" value={overall.requests} hint={`${overall.streamed} streamed`} />
            <Stat label="TTFT p50" value={fmtMs(overall.p50TtftMs)} hint="typical wait" />
            <Stat label="TTFT p90" value={fmtMs(overall.p90TtftMs)} hint="slow 10%" />
            <Stat label="Output speed" value={fmtTps(overall.p50OutputTps)} hint="p50 after first token" />
            <div className="flex min-w-0 flex-col justify-between rounded-xl border border-border/70 bg-surface/80 p-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">Overall</p>
              <div className="mt-1"><RatingBadge rating={overall.rating} /></div>
              <p className="mt-0.5 truncate text-[11px] text-text-muted">median context {fmtTokens(overall.p50InputTokens)}</p>
            </div>
          </div>
        )}
        <p className="text-[11px] text-text-muted">
          Smooth: TTFT p50 ≤ {smooth.p50 / 1000}s and p90 ≤ {smooth.p90 / 1000}s · Normal: p50 ≤ {normal.p50 / 1000}s · Slow: above that.
          Large contexts raise TTFT even with a high cache rate — compare the context columns before blaming the account.
        </p>
      </Card>

      {data?.byModel?.length > 0 && (
        <Card className="min-w-0 overflow-hidden p-0">
          <div className="border-b border-border px-4 py-3 text-sm font-semibold text-text-primary">By model</div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-xs">
              <thead className="bg-bg-subtle text-[10px] uppercase tracking-wider text-text-muted">
                <tr>
                  <th className="px-4 py-2">Model</th>
                  <th className="px-3 py-2 text-right">Req</th>
                  <th className="px-3 py-2 text-right">TTFT p50</th>
                  <th className="px-3 py-2 text-right">TTFT p90</th>
                  <th className="px-3 py-2 text-right">Total p50</th>
                  <th className="px-3 py-2 text-right">Output</th>
                  <th className="px-3 py-2 text-right">Context p50</th>
                  <th className="px-3 py-2 text-right">Cache</th>
                  <th className="px-4 py-2">Rating</th>
                </tr>
              </thead>
              <tbody>
                {data.byModel.map((row) => (
                  <Fragment key={row.key}>
                    <tr
                      className="cursor-pointer border-t border-border/60 hover:bg-bg-hover"
                      onClick={() => setExpanded(expanded === row.key ? null : row.key)}
                    >
                      <td className="max-w-[260px] truncate px-4 py-2 font-medium text-text-primary" title={row.key}>
                        <span className="material-symbols-outlined mr-1 align-middle text-[14px] text-text-muted">{expanded === row.key ? "expand_more" : "chevron_right"}</span>
                        {row.key}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{row.requests}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtMs(row.p50TtftMs)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtMs(row.p90TtftMs)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtMs(row.p50TotalMs)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtTps(row.p50OutputTps)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtTokens(row.p50InputTokens)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtPct(row.avgCacheRatio)}</td>
                      <td className="px-4 py-2"><RatingBadge rating={row.rating} /></td>
                    </tr>
                    {expanded === row.key && (
                      <tr className="border-t border-border/40 bg-bg-subtle">
                        <td colSpan={9} className="px-4 py-3">
                          <div className="grid gap-4 md:grid-cols-2">
                            <div>
                              <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-text-muted">Last {row.recent.length} requests (TTFT)</p>
                              <RecentBars recent={row.recent} />
                            </div>
                            <div>
                              <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-text-muted">TTFT by context size</p>
                              <table className="w-full text-xs">
                                <tbody>
                                  {row.byContext.map((b) => (
                                    <tr key={b.bucket} className="border-t border-border/40 first:border-t-0">
                                      <td className="py-1 font-medium">{b.bucket}</td>
                                      <td className="py-1 text-right tabular-nums text-text-muted">{b.requests} req</td>
                                      <td className="py-1 text-right tabular-nums">p50 {fmtMs(b.p50TtftMs)}</td>
                                      <td className="py-1 text-right tabular-nums">p90 {fmtMs(b.p90TtftMs)}</td>
                                      <td className="py-1 pl-2 text-right"><RatingBadge rating={b.rating} /></td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {data?.byAccount?.length > 0 && (
        <Card className="min-w-0 overflow-hidden p-0">
          <div className="border-b border-border px-4 py-3 text-sm font-semibold text-text-primary">By account</div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-xs">
              <thead className="bg-bg-subtle text-[10px] uppercase tracking-wider text-text-muted">
                <tr>
                  <th className="px-4 py-2">Account</th>
                  <th className="px-3 py-2">Provider</th>
                  <th className="px-3 py-2 text-right">Req</th>
                  <th className="px-3 py-2 text-right">TTFT p50</th>
                  <th className="px-3 py-2 text-right">TTFT p90</th>
                  <th className="px-3 py-2 text-right">Output</th>
                  <th className="px-3 py-2 text-right">Context p50</th>
                  <th className="px-4 py-2">Rating</th>
                </tr>
              </thead>
              <tbody>
                {data.byAccount.map((row) => (
                  <tr key={row.connectionId} className="border-t border-border/60">
                    <td className="max-w-[240px] truncate px-4 py-2 font-medium text-text-primary" title={row.name}>{row.name}</td>
                    <td className="px-3 py-2 text-text-muted">{row.provider}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{row.requests}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtMs(row.p50TtftMs)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtMs(row.p90TtftMs)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtTps(row.p50OutputTps)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtTokens(row.p50InputTokens)}</td>
                    <td className="px-4 py-2"><RatingBadge rating={row.rating} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
