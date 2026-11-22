"use client";

import { useState, useEffect } from "react";
import { Card, Button } from "@/shared/components";
import PricingModal from "@/shared/components/PricingModal";

export default function PricingSettingsPage() {
  const [showModal, setShowModal] = useState(false);
  const [currentPricing, setCurrentPricing] = useState(null);
  const [pricingMeta, setPricingMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState("");
  const [syncError, setSyncError] = useState("");

  const loadPricing = async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/pricing");
      if (response.ok) {
        const data = await response.json();
        setCurrentPricing(data);
      }
    } catch (error) {
      console.error("Failed to load pricing:", error);
    } finally {
      setLoading(false);
    }
  };

  const loadPricingMeta = async () => {
    try {
      const response = await fetch("/api/pricing/meta");
      if (response.ok) setPricingMeta(await response.json());
    } catch (error) {
      console.error("Failed to load pricing metadata:", error);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadPricing();
    loadPricingMeta();
  }, []);

  const syncPricing = async () => {
    setSyncing(true);
    setSyncMessage("");
    setSyncError("");
    try {
      const response = await fetch("/api/pricing/sync", { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Sync failed");
      setSyncMessage(`Đã đồng bộ ${data.modelCount} model OpenRouter`);
      await Promise.all([loadPricing(), loadPricingMeta()]);
    } catch (error) {
      setSyncError(error.message || "Không thể đồng bộ giá");
    } finally {
      setSyncing(false);
    }
  };

  const lastSyncedAt = pricingMeta?.providers?.openrouter?.syncedAt;
  const formattedLastSyncedAt = lastSyncedAt
    ? new Intl.DateTimeFormat("vi-VN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(lastSyncedAt))
    : "Chưa đồng bộ";

  const handlePricingUpdated = () => {
    loadPricing();
  };

  // Count total models with pricing
  const getModelCount = () => {
    if (!currentPricing) return 0;
    let count = 0;
    for (const provider in currentPricing) {
      count += Object.keys(currentPricing[provider]).length;
    }
    return count;
  };

  // Get providers list
  const getProviders = () => {
    if (!currentPricing) return [];
    return Object.keys(currentPricing).sort();
  };

  const providers = getProviders();
  const modelCount = getModelCount();
  const syncedModelCount = pricingMeta?.providers?.openrouter?.modelCount || 0;

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <Card padding="md">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-text-muted">Model pricing</p>
            <h2 className="mt-1 text-xl font-semibold text-text-main">Keep token costs accurate</h2>
            <p className="mt-1 max-w-2xl text-sm text-text-muted">Automatic catalog updates with manual overrides for custom models.</p>
          </div>
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
            <Button
              variant="outline"
              size="md"
              onClick={syncPricing}
              disabled={syncing}
              loading={syncing}
              icon="sync"
              className="w-full sm:w-auto"
            >{syncing ? "Syncing catalog" : "Sync now"}</Button>
            <Button
              variant="primary"
              size="md"
              onClick={() => setShowModal(true)}
              icon="tune"
              className="w-full sm:w-auto"
            >Edit pricing</Button>
          </div>
        </div>
        <div className="mt-5 flex flex-col gap-2 border-t border-border-subtle pt-4 text-sm sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2 text-text-muted">
            <span className="size-2 rounded-full bg-emerald-500 shadow-[0_0_0_4px] shadow-emerald-500/10" />
            <span>OpenRouter catalog</span>
            <span className="text-text-main">{syncedModelCount || "—"} models synced</span>
          </div>
          <div className="text-text-muted">Last synced <span className="font-medium text-text-main">{formattedLastSyncedAt}</span></div>
        </div>
        {(syncMessage || syncError) && (
          <div aria-live="polite" className={`mt-3 rounded-lg border px-3 py-2 text-sm ${syncError ? "border-red-500/20 bg-red-500/10 text-red-600 dark:text-red-300" : "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"}`}>
            {syncError || syncMessage}
          </div>
        )}
      </Card>

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {[
          { label: "Priced models", value: modelCount, icon: "neurology", tone: "text-brand-600 bg-brand-500/10" },
          { label: "Providers", value: providers.length, icon: "hub", tone: "text-cyan-600 bg-cyan-500/10" },
          { label: "Pricing status", value: loading ? "..." : "Active", icon: "verified", tone: "text-emerald-600 bg-emerald-500/10" },
        ].map((stat) => (
          <Card key={stat.label} className="flex items-center gap-3 p-4 sm:p-5">
            <div className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${stat.tone}`}>
              <span className="material-symbols-outlined text-[21px]">{stat.icon}</span>
            </div>
            <div className="min-w-0">
              <div className="text-xs font-medium uppercase tracking-wide text-text-muted">{stat.label}</div>
              <div className="mt-1 text-2xl font-semibold tabular-nums text-text-main">{loading && stat.label !== "Pricing status" ? "..." : stat.value}</div>
            </div>
          </Card>
        ))}
      </section>

      <section className="grid gap-6 lg:grid-cols-[1.35fr_0.65fr]">
        <Card className="p-5 sm:p-6">
          <div className="mb-5 flex items-end justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-brand-600 dark:text-brand-300">Catalog coverage</p>
              <h2 className="mt-1 text-xl font-semibold text-text-main">Current pricing overview</h2>
            </div>
            <button onClick={() => setShowModal(true)} className="shrink-0 text-sm font-medium text-brand-600 hover:text-brand-700 dark:text-brand-300 dark:hover:text-brand-200">View details <span aria-hidden="true">→</span></button>
          </div>
          {loading ? (
            <div className="flex min-h-40 items-center justify-center text-sm text-text-muted">Loading pricing data...</div>
          ) : providers.length ? (
            <div className="grid gap-2 sm:grid-cols-2">
              {providers.slice(0, 8).map((provider, index) => (
                <div key={provider} className="group flex items-center justify-between rounded-2xl border border-border-subtle bg-bg/50 px-4 py-3 transition hover:border-brand-500/30 hover:bg-brand-500/5">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-xs font-bold text-text-muted">{String(index + 1).padStart(2, "0")}</div>
                    <span className="truncate text-sm font-semibold text-text-main">{provider}</span>
                  </div>
                  <span className="shrink-0 text-xs tabular-nums text-text-muted">{Object.keys(currentPricing[provider]).length} models</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex min-h-40 items-center justify-center text-sm text-text-muted">No pricing data available</div>
          )}
          {providers.length > 8 && <p className="mt-4 text-xs text-text-muted">+ {providers.length - 8} more providers in the full pricing view.</p>}
        </Card>

        <Card className="p-5 sm:p-6">
          <div className="mb-5 flex size-10 items-center justify-center rounded-xl bg-amber-500/10 text-amber-600 dark:text-amber-300">
            <span className="material-symbols-outlined text-[21px]">calculate</span>
          </div>
          <h2 className="text-lg font-semibold text-text-main">How costs are calculated</h2>
          <p className="mt-2 text-sm leading-6 text-text-muted">Rates use dollars per million tokens. Each request combines input, output and cached token usage.</p>
          <div className="mt-5 space-y-2 text-sm">
            {[
              ["Input", "Prompt tokens"],
              ["Output", "Generated tokens"],
              ["Cached", "Reused input tokens"],
            ].map(([name, description]) => (
              <div key={name} className="flex items-center justify-between rounded-xl bg-bg/60 px-3 py-2">
                <span className="font-medium text-text-main">{name}</span>
                <span className="text-text-muted">{description}</span>
              </div>
            ))}
          </div>
        </Card>
      </section>

      {/* Pricing Modal */}
      {showModal && (
        <PricingModal
          isOpen={showModal}
          onClose={() => setShowModal(false)}
          onSave={handlePricingUpdated}
        />
      )}
    </div>
  );
}
