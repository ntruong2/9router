"use client";

import { useEffect, useState } from "react";
import Card from "@/shared/components/Card";

const fmt = (value) => new Intl.NumberFormat().format(value || 0);

export default function SmartAnalytics({ period = "7d" }) {
  const [data, setData] = useState(null);

  useEffect(() => {
    let active = true;
    fetch(`/api/usage/insights?period=${period}`, { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((next) => { if (active) setData(next); })
      .catch(() => { if (active) setData(null); });
    return () => { active = false; };
  }, [period]);

  if (!data) return null;
  return (
    <Card className="relative flex min-w-0 flex-col gap-4 overflow-hidden border-primary/15 bg-gradient-to-br from-primary/[0.06] via-surface to-surface p-4 shadow-sm sm:p-5">
      <div className="pointer-events-none absolute -right-10 -top-16 h-36 w-36 rounded-full bg-primary/10 blur-3xl" />
      <div className="relative flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <span className="material-symbols-outlined text-[19px]">insights</span>
          </span>
          <div>
            <h2 className="text-sm font-bold tracking-tight text-text-primary">Smart Analytics</h2>
            <p className="text-[11px] text-text-muted">Usage signals for this period</p>
          </div>
        </div>
        <span className="rounded-full border border-primary/15 bg-primary/5 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-primary">Live</span>
      </div>
      <div className="relative grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="rounded-xl border border-border/70 bg-surface/80 p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">Total tokens</p>
          <p className="mt-1 text-lg font-bold tabular-nums text-text-primary">{fmt(data.totalTokens)}</p>
        </div>
        <div className="rounded-xl border border-emerald-500/15 bg-emerald-500/[0.05] p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">Cache hit rate</p>
          <p className="mt-1 text-lg font-bold tabular-nums text-emerald-600 dark:text-emerald-400">{data.cacheHitRate}%</p>
        </div>
        <div className="min-w-0 rounded-xl border border-border/70 bg-surface/80 p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">Top provider</p>
          <p className="mt-1 truncate text-sm font-bold text-text-primary" title={data.topProvider?.name}>{data.topProvider?.name || "—"}</p>
        </div>
        <div className="min-w-0 rounded-xl border border-border/70 bg-surface/80 p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">Top model</p>
          <p className="mt-1 truncate text-sm font-bold text-text-primary" title={data.topModel?.name}>{data.topModel?.name || "—"}</p>
        </div>
      </div>
      {data.recommendations?.map((item, index) => (
        <div key={`${item.type}-${index}`} className="relative flex items-start gap-2 rounded-xl border border-amber-500/20 bg-amber-500/[0.07] px-3 py-2.5 text-xs text-amber-800 dark:text-amber-200">
          <span className="material-symbols-outlined shrink-0 text-[16px]">lightbulb</span>
          <p>{item.message}</p>
        </div>
      ))}
    </Card>
  );
}
