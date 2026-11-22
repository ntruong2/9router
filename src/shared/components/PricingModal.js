"use client";

import { useState, useEffect } from "react";
import { getDefaultPricing, formatCost } from "open-sse/providers/pricing.js";

export default function PricingModal({ isOpen, onClose, onSave }) {
  const [pricingData, setPricingData] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [newProvider, setNewProvider] = useState("");
  const [newModel, setNewModel] = useState("");
  const [modelQuery, setModelQuery] = useState("");

  const loadPricing = async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/pricing");
      if (response.ok) {
        const data = await response.json();
        setPricingData(data);
      } else {
        // Fallback to defaults
        const defaults = getDefaultPricing();
        setPricingData(defaults);
      }
    } catch (error) {
      console.error("Failed to load pricing:", error);
      const defaults = getDefaultPricing();
      setPricingData(defaults);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Loading starts only when the modal becomes visible.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (isOpen) loadPricing();
  }, [isOpen]);

  const handlePricingChange = (provider, model, field, value) => {
    const numValue = parseFloat(value);
    if (isNaN(numValue) || numValue < 0) return;

    setPricingData(prev => {
      const newData = { ...prev };
      if (!newData[provider]) newData[provider] = {};
      if (!newData[provider][model]) newData[provider][model] = {};
      newData[provider][model][field] = numValue;
      return newData;
    });
  };

  const addCustomModel = () => {
    const provider = newProvider.trim().toLowerCase();
    const model = newModel.trim();
    if (!provider || !model) return;
    setPricingData((prev) => ({
      ...prev,
      [provider]: {
        ...(prev[provider] || {}),
        [model]: prev[provider]?.[model] || { input: 0, output: 0, cached: 0, reasoning: 0, cache_creation: 0 },
      },
    }));
    setNewModel("");
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const response = await fetch("/api/pricing", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pricingData)
      });

      if (response.ok) {
        onSave?.();
        onClose();
      } else {
        const error = await response.json();
        alert(`Failed to save pricing: ${error.error}`);
      }
    } catch (error) {
      console.error("Failed to save pricing:", error);
      alert("Failed to save pricing");
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    if (!confirm("Reset all pricing to defaults? This cannot be undone.")) return;

    try {
      const response = await fetch("/api/pricing", { method: "DELETE" });
      if (response.ok) {
        const defaults = getDefaultPricing();
        setPricingData(defaults);
      }
    } catch (error) {
      console.error("Failed to reset pricing:", error);
      alert("Failed to reset pricing");
    }
  };

  if (!isOpen) return null;

  // Get all unique providers and models for display
  const allProviders = Object.keys(pricingData).sort();
  const visibleProviders = allProviders.filter((provider) => {
    const query = modelQuery.trim().toLowerCase();
    return !query || Object.keys(pricingData[provider]).some((model) => `${provider}/${model}`.toLowerCase().includes(query));
  });
  const pricingFields = ["input", "output", "cached", "reasoning", "cache_creation"];

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-bg-base border border-border rounded-lg shadow-xl max-w-6xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border bg-bg-base/95 p-4 backdrop-blur">
          <div>
            <h2 className="text-xl font-semibold">Pricing Configuration</h2>
            <p className="mt-0.5 text-xs text-text-muted">Rates are in dollars per million tokens</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close pricing configuration"
            className="flex size-8 items-center justify-center rounded-lg text-text-muted transition hover:bg-bg-hover hover:text-text"
          >
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          {loading ? (
            <div className="text-center py-8 text-text-muted">Loading pricing data...</div>
          ) : (
            <div className="space-y-6">
              {/* Instructions */}
              <div className="flex flex-col gap-3 rounded-2xl border border-border bg-bg-subtle p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-2 text-sm">
                  <span className="material-symbols-outlined text-[18px] text-primary">info</span>
                  <span className="text-text-muted">Search the catalog or add a custom model override.</span>
                </div>
                <label className="relative block sm:w-72">
                  <span className="material-symbols-outlined pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[17px] text-text-muted">search</span>
                  <input
                    value={modelQuery}
                    onChange={(event) => setModelQuery(event.target.value)}
                    placeholder="Search provider or model"
                    className="h-9 w-full rounded-xl border border-border bg-bg-base pl-9 pr-3 text-sm text-text-primary outline-none transition focus:border-primary"
                    aria-label="Search provider or model"
                  />
                </label>
              </div>

              <div className="flex flex-col gap-2 rounded-lg border border-primary/20 bg-primary/5 p-3 sm:flex-row sm:items-end">
                <label className="flex-1 text-xs text-text-muted">
                  Provider
                  <input value={newProvider} onChange={(e) => setNewProvider(e.target.value)} placeholder="openai" className="mt-1 w-full rounded border border-border bg-bg-base px-2 py-1.5 text-sm text-text-primary" />
                </label>
                <label className="flex-[2] text-xs text-text-muted">
                  Custom model ID
                  <input value={newModel} onChange={(e) => setNewModel(e.target.value)} placeholder="gpt-6.2-sol" className="mt-1 w-full rounded border border-border bg-bg-base px-2 py-1.5 text-sm text-text-primary" />
                </label>
                <button type="button" onClick={addCustomModel} disabled={!newProvider.trim() || !newModel.trim()} className="rounded bg-primary px-3 py-1.5 text-sm text-white disabled:opacity-50">
                  Add custom model
                </button>
              </div>

              {/* Pricing Tables */}
              {allProviders.map(provider => {
                const models = Object.keys(pricingData[provider]).sort().filter((model) => {
                  const query = modelQuery.trim().toLowerCase();
                  return !query || `${provider}/${model}`.toLowerCase().includes(query);
                });
                if (!models.length) return null;
                return (
                  <div key={provider} className="overflow-hidden rounded-2xl border border-border">
                    <div className="flex items-center justify-between bg-bg-subtle px-4 py-3">
                      <span className="text-sm font-semibold">{provider.toUpperCase()}</span>
                      <span className="text-xs text-text-muted">{models.length} shown</span>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="sticky top-0 z-10 bg-bg-hover text-xs uppercase text-text-muted">
                          <tr>
                            <th className="px-3 py-2 text-left">Model</th>
                            <th className="px-3 py-2 text-right">Input</th>
                            <th className="px-3 py-2 text-right">Output</th>
                            <th className="px-3 py-2 text-right">Cached</th>
                            <th className="px-3 py-2 text-right">Reasoning</th>
                            <th className="px-3 py-2 text-right">Cache Creation</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {models.map(model => (
                            <tr key={model} className="hover:bg-bg-subtle/50">
                              <td className="px-3 py-2 font-medium">{model}</td>
                              {pricingFields.map(field => (
                                <td key={field} className="px-3 py-2">
                                  <input
                                    type="number"
                                    step="0.01"
                                    min="0"
                                    value={pricingData[provider][model][field] || 0}
                                    onChange={(e) => handlePricingChange(provider, model, field, e.target.value)}
                                    className="w-20 px-2 py-1 text-right bg-bg-base border border-border rounded focus:outline-none focus:border-primary"
                                  />
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })}

              {visibleProviders.length === 0 && (
                <div className="text-center py-8 text-text-muted">
                  {allProviders.length === 0 ? "No pricing data available" : "No models match your search"}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-border flex items-center justify-between gap-2">
          <button
            onClick={handleReset}
            className="px-4 py-2 text-sm text-red-500 hover:bg-red-500/10 rounded border border-red-500/20 transition-colors"
            disabled={saving}
          >
            Reset to Defaults
          </button>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm text-text-muted hover:text-text border border-border rounded transition-colors"
              disabled={saving}
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              className="px-4 py-2 text-sm bg-primary text-white rounded hover:bg-primary/90 transition-colors disabled:opacity-50"
              disabled={saving}
            >
              {saving ? "Saving..." : "Save Changes"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
