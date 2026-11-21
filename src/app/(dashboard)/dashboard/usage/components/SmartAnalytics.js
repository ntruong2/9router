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
    <Card className="flex min-w-0 flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <span className="material-symbols-outlined text-primary">insights</span>
        <h2 className="text-sm font-semibold text-text-primary">Smart Analytics</h2>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div><p className="text-[11px] text-text-muted">Total tokens</p><p className="text-lg font-semibold">{fmt(data.totalTokens)}</p></div>
        <div><p className="text-[11px] text-text-muted">Cache hit rate</p><p className="text-lg font-semibold">{data.cacheHitRate}%</p></div>
        <div><p className="text-[11px] text-text-muted">Top provider</p><p className="truncate text-sm font-semibold" title={data.topProvider?.name}>{data.topProvider?.name || "—"}</p></div>
        <div><p className="text-[11px] text-text-muted">Top model</p><p className="truncate text-sm font-semibold" title={data.topModel?.name}>{data.topModel?.name || "—"}</p></div>
      </div>
      {data.recommendations?.map((item, index) => (
        <p key={`${item.type}-${index}`} className="rounded-lg bg-bg-subtle px-3 py-2 text-xs text-text-muted">{item.message}</p>
      ))}
    </Card>
  );
}
