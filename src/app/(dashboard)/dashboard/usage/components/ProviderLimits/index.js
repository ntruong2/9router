"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import ProviderIcon from "@/shared/components/ProviderIcon";
import QuotaTable from "./QuotaTable";
import Toggle from "@/shared/components/Toggle";
import Tooltip from "@/shared/components/Tooltip";
import {
  parseQuotaData,
  calculatePercentage,
  filterQuotasByVisibility,
  getHiddenQuotaRows,
  getQuotaVisibilityKey,
  getConnectionLabel,
  getConnectionQuotaRemaining,
  sortVisibleConnections,
  buildLoadingState,
  filterQuotaStateByConnections,
  getConnectionsEmptyMessage,
  getPageSizeLabel,
  getConnectionsPaginationSummary,
  getSafePagination,
  getSafeTotals,
  shouldResetPage,
  getPaginationPageValue,
  getProviderOptions,
  reconcileConnectionsPage,
  getQuotaCache,
  setQuotaCache,
  QUOTA_CACHE_KEY,
  REFRESH_INTERVAL_MS,
  CLAUDE_REFRESH_INTERVAL_MS,
  DEPLETED_QUOTA_THRESHOLD,
  AUTO_REFRESH_STORAGE_KEY,
  CONNECTIONS_PAGE_SIZE,
  ACCOUNT_PAGE_SIZE_OPTIONS,
  ACCOUNT_PAGE_SIZE_MAX,
  ACCOUNT_FILTER_OPTIONS,
  QUOTA_SORT_OPTIONS,
  QUOTA_SORT_MODES,
  isRemainingSortMode,
} from "./utils";
import Card from "@/shared/components/Card";
import { ConfirmModal, EditConnectionModal } from "@/shared/components";
import AutoPingScheduleModal from "@/app/(dashboard)/dashboard/providers/[id]/AutoPingScheduleModal";
import { getScheduleSlotLabels } from "@/shared/services/quotaPingSchedule";
import { USAGE_SUPPORTED_PROVIDERS, AI_PROVIDERS } from "@/shared/constants/providers";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { appendQuotaHistory, buildQuotaSnapshot, SMART_QUOTA_FETCHED_AT_HEADER, forecastQuota, getQuotaAlertState, getConnectionQuotaHealth, getRecommendedConnection } from "@/shared/services/smartQuota.js";
import { buildQuotaAlerts, dedupeQuotaAlerts } from "@/shared/services/smartQuotaAlerts.js";
import { useNotificationStore } from "@/store/notificationStore";

// Maps the stored providerSpecificData.authMethod to a human label for Kiro.
// Values come from the Kiro connect flows: builder-id/idc (device code),
// google/github (social), imported (refresh-token paste), api_key (headless).
const KIRO_METHOD_LABELS = {
  "builder-id": "AWS Builder ID",
  idc: "IAM Identity Center",
  google: "Google",
  github: "GitHub",
  imported: "Imported Token",
  api_key: "API Key",
};

const AUTO_PING_SETTINGS_KEYS = {
  claude: "claudeAutoPing",
  codex: "codexAutoPing",
};

const AUTO_PING_TOOLTIPS = {
  claude: "When your 5h quota runs out, auto-sends a request the moment it resets so a new window starts right away.",
  codex: "Auto-starts the next 5h Codex window after reset by sending a tiny request. Consumes a small amount of quota.",
};

function kiroMethodLabel(conn) {
  const m = conn.providerSpecificData?.authMethod;
  if (m && KIRO_METHOD_LABELS[m]) return KIRO_METHOD_LABELS[m];
  return conn.authType === "api_key" ? "API Key" : "OAuth";
}

function getConnectionSecondaryLabel(connection) {
  if (connection.name?.trim() && connection.email?.trim() && connection.name.trim() !== connection.email.trim()) {
    return connection.email.trim();
  }

  if (connection.name?.trim() && connection.displayName?.trim() && connection.name.trim() !== connection.displayName.trim()) {
    return connection.displayName.trim();
  }

  return null;
}

// Region is stored for builder-id/idc/api_key flows; social and imported flows
// omit it, so fall back to the region segment of the profileArn
// (arn:aws:codewhisperer:<region>:...).
function kiroRegion(conn) {
  const r = conn.providerSpecificData?.region;
  if (r) return r;
  const arn = conn.providerSpecificData?.profileArn;
  const seg = typeof arn === "string" ? arn.split(":")[3] : "";
  return seg || "";
}

function getCodexResetCreditCount(quota) {
  const value = quota?.raw?.resetCredits?.availableCount;
  const count = typeof value === "number" ? value : Number(value);
  return Number.isFinite(count) ? Math.max(0, count) : 0;
}

const CLAUDE_RESET_LIMIT_NAMES = {
  five_hour: "session",
  seven_day: "weekly",
  seven_day_overage_included: "weekly",
  seven_day_opus: "Opus weekly",
  seven_day_sonnet: "Sonnet weekly",
};

function formatClaudeResetClears(clears) {
  const names = [...new Set((clears || []).map((c) => CLAUDE_RESET_LIMIT_NAMES[c]).filter(Boolean))];
  return names.length ? `${names.join(" + ")} limits` : "limits";
}

function claudeGrantStatus(grant) {
  if (grant.resetsLeft <= 0) return "used";
  if (grant.paused) return "paused";
  if (grant.endsAt && new Date(grant.endsAt).getTime() <= Date.now()) return "expired";
  if (grant.usableNow) return "usable now";
  if (grant.startsAt && new Date(grant.startsAt).getTime() > Date.now()) return "not started";
  return grant.useRequiresLimit ? "at limit only" : "unavailable";
}

function providerLabel(providerId) {
  return AI_PROVIDERS[providerId]?.name || providerId;
}

function formatCreditDate(value) {
  if (!value) return "N/A";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "N/A";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatTimeRemaining(value) {
  if (!value) return "N/A";
  const diffMs = new Date(value).getTime() - Date.now();
  if (!Number.isFinite(diffMs)) return "N/A";
  if (diffMs <= 0) return "Expired";
  const totalHours = Math.ceil(diffMs / (60 * 60 * 1000));
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return days > 0 ? `${days}d ${hours}h` : `${hours}h`;
}

export default function ProviderLimits() {
  const { copied, copy } = useCopyToClipboard();
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [connections, setConnections] = useState([]);
  const [quotaData, setQuotaData] = useState({});
  const [loading, setLoading] = useState({});
  const [errors, setErrors] = useState({});
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [autoPingConfigs, setAutoPingConfigs] = useState({ claude: {}, codex: {} });
  const [scheduleConnection, setScheduleConnection] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [hasHydratedAutoRefresh, setHasHydratedAutoRefresh] = useState(false);
  const [hasHydratedViewState, setHasHydratedViewState] = useState(false);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [countdown, setCountdown] = useState(60);
  const [connectionsLoading, setConnectionsLoading] = useState(true);
  const [deletingId, setDeletingId] = useState(null);
  const [togglingId, setTogglingId] = useState(null);
  const [resettingLimitId, setResettingLimitId] = useState(null);
  const [resetConfirmState, setResetConfirmState] = useState(null);
  const [resetCreditsState, setResetCreditsState] = useState(null);
  const [showEditModal, setShowEditModal] = useState(false);
  const [selectedConnection, setSelectedConnection] = useState(null);
  const [proxyPools, setProxyPools] = useState([]);
  // Initialize providerFilter from URL ?provider= param so the page
  // can be bookmarked / deep-linked to a specific provider (#4217).
  const [providerFilter, _setProviderFilter] = useState(
    () => searchParams?.get("provider") || "all"
  );
  // Wrapper: keeps URL in sync with the selected provider so the view can be
  // bookmarked. Replaces the URL without adding to browser history.
  const setProviderFilter = useCallback((value) => {
    _setProviderFilter(value);
    try {
      const params = new URLSearchParams(searchParams?.toString() || "");
      if (value === "all") {
        params.delete("provider");
      } else {
        params.set("provider", value);
      }
      const newUrl = params.toString() ? `${pathname}?${params.toString()}` : pathname;
      router.replace(newUrl, { scroll: false });
    } catch { /* non-fatal: URL sync is best-effort */ }
  }, [pathname, router, searchParams]);
  const [providerOptions, setProviderOptions] = useState([]);
  const [accountFilter, setAccountFilter] = useState("all");
  const [quotaSortMode, setQuotaSortMode] = useState("default");
  const [quotaVisibility, setQuotaVisibility] = useState({});
  const [smartQuotaUse, setSmartQuotaUse] = useState(true);
  const [smartQuotaForecast, setSmartQuotaForecast] = useState(true);
  const [smartQuotaAlerts, setSmartQuotaAlerts] = useState(true);
  const [smartQuotaBackgroundRefresh, setSmartQuotaBackgroundRefresh] = useState(false);
  const [sessionPin, setSessionPin] = useState({});
  const [sessionMaxConcurrent, setSessionMaxConcurrent] = useState({});
  const [imageMaxConcurrent, setImageMaxConcurrent] = useState({});
  const [imageQueueTimeoutMs, setImageQueueTimeoutMs] = useState(30000);
  const [sessionLoadStatus, setSessionLoadStatus] = useState({});
  const [imageLoadStatus, setImageLoadStatus] = useState({});
  const addNotification = useNotificationStore((state) => state.addNotification);
  const [expiringFirst, setExpiringFirst] = useState(false);
  const [providerMenuOpen, setProviderMenuOpen] = useState(false);
  const [bulkToggling, setBulkToggling] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(CONNECTIONS_PAGE_SIZE);
  const [customPageSizeInput, setCustomPageSizeInput] = useState(
    String(CONNECTIONS_PAGE_SIZE),
  );
  const [pagination, setPagination] = useState({
    page: 1,
    pageSize: CONNECTIONS_PAGE_SIZE,
    total: 0,
    totalPages: 1,
  });
  const [totals, setTotals] = useState({
    eligibleConnections: 0,
    providerFilteredConnections: 0,
  });

  const intervalRef = useRef(null);
  const countdownRef = useRef(null);
  const tickCountRef = useRef(0);
  // Only the newest connections request may update state: the list is refetched whenever a
  // filter changes, and a slower stale response must not overwrite the current view.
  const connectionsRequestRef = useRef(0);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const saved = JSON.parse(window.localStorage.getItem("quotaTrackerViewState") || "{}");
      if (!searchParams?.get("provider") && typeof saved.providerFilter === "string") _setProviderFilter(saved.providerFilter);
      if (["all", "active", "inactive", "quota-available", "quota-exhausted"].includes(saved.accountFilter)) setAccountFilter(saved.accountFilter);
      const savedSortMode = saved.quotaSortMode ?? window.localStorage.getItem("quotaTrackerSortMode");
      if (QUOTA_SORT_MODES.includes(savedSortMode)) setQuotaSortMode(savedSortMode);
      if (typeof saved.expiringFirst === "boolean") setExpiringFirst(saved.expiringFirst);
      if (Number.isInteger(saved.pageSize) && saved.pageSize >= 1 && saved.pageSize <= ACCOUNT_PAGE_SIZE_MAX) {
        setPageSize(saved.pageSize);
        setCustomPageSizeInput(String(saved.pageSize));
      }
    } catch { /* ignore malformed browser preferences */ }
    setHasHydratedViewState(true);
    // Restore saved preferences once on mount. Re-running on every URL change (the provider
    // filter rewrites ?provider=) would reapply stale values over the user's current choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !hasHydratedViewState) return;
    window.localStorage.setItem("quotaTrackerViewState", JSON.stringify({
      providerFilter,
      accountFilter,
      quotaSortMode,
      expiringFirst,
      pageSize,
    }));
  }, [hasHydratedViewState, providerFilter, accountFilter, quotaSortMode, expiringFirst, pageSize]);

  useEffect(() => {
    if (!hasHydratedViewState) return;
    setPage(1);
  }, [accountFilter, providerFilter, hasHydratedViewState]);

  useEffect(() => {
    if (typeof window === "undefined" || !hasHydratedViewState) return;
    window.localStorage.setItem("quotaTrackerSortMode", quotaSortMode);
  }, [hasHydratedViewState, quotaSortMode]);

  const fetchConnections = useCallback(
    async (targetPage = page) => {
      const requestId = ++connectionsRequestRef.current;
      const isStale = () => requestId !== connectionsRequestRef.current;
      try {
        const params = new URLSearchParams({
          page: String(targetPage),
          pageSize: String(pageSize),
          accountStatus: ["active", "inactive"].includes(accountFilter) ? accountFilter : "all",
          quotaStatus: ["quota-available", "quota-exhausted"].includes(accountFilter) ? accountFilter : "all",
          sort: "priority",
        });

        if (providerFilter !== "all") {
          params.set("provider", providerFilter);
        }

        const response = await fetch(
          `/api/providers/client?${params.toString()}`,
        );
        if (!response.ok) throw new Error("Failed to fetch connections");

        const data = await response.json();
        if (isStale()) return null;
        const connectionList = data.connections || [];
        const nextPagination = getSafePagination(data.pagination, pageSize);
        const nextTotals = getSafeTotals(data.totals, connectionList.length);

        setConnections(connectionList);
        setProviderOptions(getProviderOptions(data.providerOptions));
        setPagination(nextPagination);
        setTotals(nextTotals);
        setPage(getPaginationPageValue(data.pagination, targetPage));
        return connectionList;
      } catch (error) {
        if (isStale()) return null;
        console.error("Error fetching connections:", error);
        setConnections([]);
        setProviderOptions([]);
        setPagination({ page: 1, pageSize, total: 0, totalPages: 1 });
        setTotals({
          eligibleConnections: 0,
          providerFilteredConnections: 0,
          accountFilteredConnections: 0,
          filteredConnections: 0,
        });
        return [];
      }
    },
    [accountFilter, page, pageSize, providerFilter],
  );

  // Fetch quota for a specific connection
  const fetchQuota = useCallback(async (connectionId, provider, { force = false, silent = false } = {}) => {
    if (!silent) {
      setLoading((prev) => ({ ...prev, [connectionId]: true }));
      setErrors((prev) => ({ ...prev, [connectionId]: null }));
    }

    try {
      const url = `/api/usage/${connectionId}${force ? "?force=1" : ""}`;
      const response = await fetch(url);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMsg = errorData.error || response.statusText;

        // Handle different error types gracefully
        if (response.status === 404) {
          // Connection not found - skip silently
          console.warn(
            `[ProviderLimits] Connection not found for ${provider}, skipping`,
          );
          return;
        }

        if (response.status === 401) {
          // Auth error - show message instead of throwing
          console.warn(
            `[ProviderLimits] Auth error for ${provider}:`,
            errorMsg,
          );
          const quotaEntry = {
            quotas: [],
            message: errorMsg,
            authError: true,
          };
          setQuotaData((prev) => ({
            ...prev,
            [connectionId]: quotaEntry,
          }));
          setQuotaCache(connectionId, quotaEntry);
          return;
        }

        throw new Error(`HTTP ${response.status}: ${errorMsg}`);
      }

      const data = await response.json();

      // Parse quota data using provider-specific parser
      const parsedQuotas = parseQuotaData(provider, data);

      const quotaEntry = {
        quotas: parsedQuotas,
        plan: data.plan || null,
        message: data.message || null,
        raw: data,
        fetchedAt: response.headers.get(SMART_QUOTA_FETCHED_AT_HEADER),
      };

      setQuotaData((prev) => ({
        ...prev,
        [connectionId]: quotaEntry,
      }));
      setQuotaCache(connectionId, quotaEntry);
    } catch (error) {
      console.error(
        `[ProviderLimits] Error fetching quota for ${provider} (${connectionId}):`,
        error,
      );
      setErrors((prev) => ({ ...prev, [connectionId]: error.message || "Failed to fetch quota" }));
    } finally {
      if (!silent) setLoading((prev) => ({ ...prev, [connectionId]: false }));
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let timer;
    const load = async () => {
      try {
        const [chatResponse, imageResponse] = await Promise.all([
          fetch("/api/usage/session-load", { cache: "no-store", signal: controller.signal }),
          fetch("/api/usage/image-load", { cache: "no-store", signal: controller.signal }),
        ]);
        if (!chatResponse.ok || !imageResponse.ok) throw new Error("Failed to fetch load status");
        const [chatData, imageData] = await Promise.all([chatResponse.json(), imageResponse.json()]);
        if (!controller.signal.aborted) {
          setSessionLoadStatus(Object.fromEntries(chatData.accounts.map((entry) => [entry.connectionId, entry])));
          setImageLoadStatus(Object.fromEntries(imageData.accounts.map((entry) => [entry.connectionId, entry])));
        }
      } catch {
        if (!controller.signal.aborted) setSessionLoadStatus({});
        if (!controller.signal.aborted) setImageLoadStatus({});
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(load, 5000);
      }
    };
    load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, []);

  // Refresh quota for a specific provider
  const refreshProvider = useCallback(
    async (connectionId, provider) => {
      await fetchQuota(connectionId, provider, { force: true });
      setLastUpdated(new Date());
    },
    [fetchQuota],
  );

  const handleResetCodexLimit = useCallback(
    async (connectionId, provider) => {
      if ((provider !== "codex" && provider !== "claude") || resettingLimitId) return;

      setResettingLimitId(connectionId);
      setErrors((prev) => ({ ...prev, [connectionId]: null }));

      try {
        const response = provider === "claude"
          ? await fetch(`/api/usage/${connectionId}/claude-reset`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ grantId: quotaData[connectionId]?.raw?.resetCredits?.nextGrantId }),
          })
          : await fetch(`/api/usage/${connectionId}/codex-reset-credits`, { method: "POST" });
        const result = await response.json().catch(() => ({}));

        if (!response.ok) {
          throw new Error(result.message || result.error || result.code || "Failed to reset limit");
        }

        await fetchQuota(connectionId, provider, { force: true });
        setLastUpdated(new Date());
      } catch (error) {
        setErrors((prev) => ({ ...prev, [connectionId]: error.message || "Failed to reset limit" }));
      } finally {
        setResettingLimitId(null);
      }
    },
    [fetchQuota, resettingLimitId, quotaData],
  );

  // Claude grants already arrive with the usage read; no extra fetch
  const handleViewClaudeResets = useCallback((connection, resetCredits) => {
    setResetCreditsState({ connection, loading: false, error: null, data: { kind: "claude", ...resetCredits } });
  }, []);

  const handleViewCodexResetCredits = useCallback(async (connection) => {
    setResetCreditsState({ connection, loading: true, error: null, data: null });
    try {
      const response = await fetch(`/api/usage/${connection.id}/codex-reset-credits`, { cache: "no-store" });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(result.error || result.message || "Failed to load Codex reset credits");
      }
      const credits = Array.isArray(result.credits) ? [...result.credits] : [];
      credits.sort((a, b) => {
        const aTime = a.expiresAt ? new Date(a.expiresAt).getTime() : Number.POSITIVE_INFINITY;
        const bTime = b.expiresAt ? new Date(b.expiresAt).getTime() : Number.POSITIVE_INFINITY;
        return aTime - bTime;
      });
      setResetCreditsState({ connection, loading: false, error: null, data: { ...result, credits } });
    } catch (error) {
      setResetCreditsState({ connection, loading: false, error: error.message || "Failed to load Codex reset credits", data: null });
    }
  }, []);

  const handleDeleteConnection = useCallback(
    async (id) => {
      if (!confirm("Delete this connection?")) return;
      setDeletingId(id);
      try {
        const res = await fetch(`/api/providers/${id}`, { method: "DELETE" });
        if (res.ok) {
          setQuotaData((prev) => {
            const next = { ...prev };
            delete next[id];
            return next;
          });
          setLoading((prev) => {
            const next = { ...prev };
            delete next[id];
            return next;
          });
          setErrors((prev) => {
            const next = { ...prev };
            delete next[id];
            return next;
          });

          if (typeof window !== "undefined") {
            try {
              const cache = getQuotaCache();
              if (cache[id]) {
                delete cache[id];
                window.localStorage.setItem(
                  QUOTA_CACHE_KEY,
                  JSON.stringify(cache),
                );
              }
            } catch (e) {
              console.error("Error deleting cache entry:", e);
            }
          }

          await reconcileConnectionsPage(fetchConnections, page);
        }
      } catch (error) {
        console.error("Error deleting connection:", error);
      } finally {
        setDeletingId(null);
      }
    },
    [fetchConnections, page],
  );

  const handleToggleConnectionActive = useCallback(
    async (id, isActive) => {
      setTogglingId(id);
      try {
        const res = await fetch(`/api/providers/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isActive }),
        });
        if (res.ok) {
          setQuotaData((prev) => {
            const next = { ...prev };
            return next;
          });
          await reconcileConnectionsPage(fetchConnections, page);
        }
      } catch (error) {
        console.error("Error updating connection status:", error);
      } finally {
        setTogglingId(null);
      }
    },
    [fetchConnections, page],
  );

  const handleUpdateConnection = useCallback(
    async (formData) => {
      if (!selectedConnection?.id) return;
      const connectionId = selectedConnection.id;
      const provider = selectedConnection.provider;
      try {
        const res = await fetch(`/api/providers/${connectionId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(formData),
        });
        if (res.ok) {
          await fetchConnections();
          setShowEditModal(false);
          setSelectedConnection(null);
          if (USAGE_SUPPORTED_PROVIDERS.includes(provider)) {
            await fetchQuota(connectionId, provider);
          }
        }
      } catch (error) {
        console.error("Error saving connection:", error);
      }
    },
    [selectedConnection, fetchConnections, fetchQuota],
  );

  useEffect(() => {
    let cancelled = false;
    fetch("/api/proxy-pools?isActive=true", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled && data?.proxyPools) {
          setProxyPools(data.proxyPools);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshAll = useCallback(async (force = false) => {
    if (refreshingAll) return;

    setRefreshingAll(true);
    setCountdown(60);

    // Throttle Claude: poll its quota every Nth auto-tick (manual force bypasses)
    const tick = (tickCountRef.current += 1);
    const claudeEvery = Math.round(CLAUDE_REFRESH_INTERVAL_MS / REFRESH_INTERVAL_MS);
    const shouldFetch = (conn) =>
      force || conn.provider !== "claude" || tick % claudeEvery === 0;

    try {
      const visibleConnections = await fetchConnections(page);
      if (!visibleConnections) return; // superseded by a newer request

      setLoading(buildLoadingState(visibleConnections.filter(shouldFetch)));
      setErrors((prev) =>
        filterQuotaStateByConnections(prev, visibleConnections),
      );
      setQuotaData((prev) =>
        filterQuotaStateByConnections(prev, visibleConnections),
      );

      const targets = visibleConnections.filter(shouldFetch);
      setLoading(buildLoadingState(targets));
      try {
        await Promise.all(targets.map((conn) => fetchQuota(conn.id, conn.provider, { force, silent: true })));
      } finally {
        setLoading((prev) => Object.fromEntries(
          Object.entries(filterQuotaStateByConnections(prev, visibleConnections)).map(([id]) => [id, false]),
        ));
      }

      setLastUpdated(new Date());
    } catch (error) {
      console.error("Error refreshing all providers:", error);
    } finally {
      setRefreshingAll(false);
    }
  }, [refreshingAll, fetchConnections, fetchQuota, page]);

  useEffect(() => {
    // Wait for the saved filters: fetching with the defaults first can show the wrong list.
    if (!hasHydratedViewState) return;
    const initializeData = async () => {
      setConnectionsLoading(true);
      const visibleConnections = await fetchConnections(page);
      if (!visibleConnections) return; // superseded by a newer request
      setConnectionsLoading(false);

      // Always fetch fresh quota on mount, no cache display
      setLoading(buildLoadingState(visibleConnections));
      setErrors((prev) =>
        filterQuotaStateByConnections(prev, visibleConnections),
      );
      setQuotaData((prev) =>
        filterQuotaStateByConnections(prev, visibleConnections),
      );

      try {
        await Promise.all(
          visibleConnections.map((conn) => fetchQuota(conn.id, conn.provider, { silent: true })),
        );
      } finally {
        setLoading((prev) => Object.fromEntries(
          Object.entries(filterQuotaStateByConnections(prev, visibleConnections)).map(([id]) => [id, false]),
        ));
      }
      setLastUpdated(new Date());
    };

    initializeData();
  }, [fetchConnections, fetchQuota, page, hasHydratedViewState]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(AUTO_REFRESH_STORAGE_KEY);
    setAutoRefresh(stored === null ? true : stored === "true");
    setHasHydratedAutoRefresh(true);
  }, []);

  // Persist auto-refresh preference
  useEffect(() => {
    if (typeof window === "undefined" || !hasHydratedAutoRefresh) return;
    window.localStorage.setItem(AUTO_REFRESH_STORAGE_KEY, String(autoRefresh));
  }, [autoRefresh, hasHydratedAutoRefresh]);

  // Load auto-ping per-connection configs
  useEffect(() => {
    fetch("/api/settings", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : {}))
      .then((s) => {
        setAutoPingConfigs({
          claude: s?.claudeAutoPing || {},
          codex: s?.codexAutoPing || {},
        });
        setQuotaVisibility(s?.quotaVisibility || {});
        setSmartQuotaUse(s?.smartQuotaUse !== false);
        setSmartQuotaForecast(s?.smartQuotaForecast !== false);
        setSmartQuotaAlerts(s?.smartQuotaAlerts !== false);
        setSmartQuotaBackgroundRefresh(s?.smartQuotaBackgroundRefresh === true);
        setSessionPin({ ...(s?.sessionPin || {}), ...(s?.sessionPin?.codex === undefined && s?.codexSessionPin === true ? { codex: true } : {}) });
        setSessionMaxConcurrent(s?.sessionMaxConcurrent || {});
        setImageMaxConcurrent(s?.imageMaxConcurrent || {});
        if (Number.isInteger(s?.imageQueueTimeoutMs)) setImageQueueTimeoutMs(s.imageQueueTimeoutMs);
      })
      .catch(() => {});
  }, []);

  const handleSaveAutoPing = useCallback(async (connectionId, provider, { reactive, schedule }) => {
    const settingsKey = AUTO_PING_SETTINGS_KEYS[provider];
    if (!settingsKey) return;

    const previous = autoPingConfigs;
    const prevCfg = autoPingConfigs[provider] || {};
    const nextProviderCfg = {
      ...prevCfg,
      connections: { ...(prevCfg.connections || {}), [connectionId]: reactive },
      schedules: { ...(prevCfg.schedules || {}), [connectionId]: schedule },
    };
    const nextConfigs = { ...autoPingConfigs, [provider]: nextProviderCfg };
    setAutoPingConfigs(nextConfigs);

    try {
      const r = await fetch("/api/settings", { cache: "no-store" });
      const s = r.ok ? await r.json() : {};
      const fullCfg = {
        ...(s[settingsKey] || {}),
        connections: nextProviderCfg.connections,
        schedules: nextProviderCfg.schedules,
      };
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [settingsKey]: fullCfg }),
      });
    } catch {
      setAutoPingConfigs(previous);
    }
  }, [autoPingConfigs]);

  const updateQuotaVisibility = useCallback(async (nextVisibility, previousVisibility) => {
    setQuotaVisibility(nextVisibility);
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quotaVisibility: nextVisibility }),
      });
      if (!response.ok) throw new Error("Failed to update quota visibility");
    } catch (error) {
      console.error("Error updating quota visibility:", error);
      setQuotaVisibility(previousVisibility);
    }
  }, []);

  const toggleSmartQuotaUse = useCallback(async () => {
    const nextValue = !smartQuotaUse;
    setSmartQuotaUse(nextValue);
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ smartQuotaUse: nextValue }),
      });
      if (!response.ok) throw new Error("Failed to update Smart Use");
    } catch (error) {
      console.error("Error updating Smart Use:", error);
      setSmartQuotaUse(!nextValue);
    }
  }, [smartQuotaUse]);

  const toggleSmartQuotaSetting = useCallback(async (key, value, setter) => {
    const nextValue = !value;
    setter(nextValue);
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: nextValue }),
      });
      if (!response.ok) throw new Error(`Failed to update ${key}`);
    } catch (error) {
      console.error(`Error updating ${key}:`, error);
      setter(value);
    }
  }, []);

  const toggleSessionPin = useCallback(async (provider) => {
    const next = !(sessionPin[provider] === true);
    setSessionPin((current) => ({ ...current, [provider]: next }));
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionPin: { [provider]: next } }),
      });
      if (!response.ok) throw new Error(`Failed to update ${provider} SessionPin`);
    } catch (error) {
      console.error(`Error updating ${provider} SessionPin:`, error);
      setSessionPin((current) => ({ ...current, [provider]: !next }));
    }
  }, [sessionPin]);

  const updateSessionMaxConcurrent = useCallback(async (provider, value) => {
    // Empty input removes the cap (null = unlimited).
    const parsed = Number.parseInt(value, 10);
    const next = Number.isFinite(parsed) ? Math.max(1, Math.min(32, parsed)) : null;
    const previous = sessionMaxConcurrent[provider] ?? null;
    setSessionMaxConcurrent((current) => ({ ...current, [provider]: next }));
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionMaxConcurrent: { [provider]: next } }),
      });
      if (!response.ok) throw new Error("Failed to update session capacity");
    } catch (error) {
      console.error("Error updating session capacity:", error);
      setSessionMaxConcurrent((current) => ({ ...current, [provider]: previous }));
    }
  }, [sessionMaxConcurrent]);

  const updateImageMaxConcurrent = useCallback(async (provider, value) => {
    // Empty input removes the cap (null = unlimited). Server accepts 1..MAX_IMAGE_CONCURRENT (8).
    const parsed = Number.parseInt(value, 10);
    const next = Number.isFinite(parsed) ? Math.max(1, Math.min(8, parsed)) : null;
    const previous = imageMaxConcurrent[provider] ?? null;
    setImageMaxConcurrent((current) => ({ ...current, [provider]: next }));
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageMaxConcurrent: { [provider]: next } }),
      });
      if (!response.ok) throw new Error("Failed to update image capacity");
    } catch (error) {
      console.error("Error updating image capacity:", error);
      setImageMaxConcurrent((current) => ({ ...current, [provider]: previous }));
    }
  }, [imageMaxConcurrent]);

  const updateImageQueueTimeout = useCallback(async (value) => {
    // Seconds in the UI; the server stores ms (1s..300s).
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return;
    const next = Math.max(1, Math.min(300, parsed)) * 1000;
    const previous = imageQueueTimeoutMs;
    setImageQueueTimeoutMs(next);
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageQueueTimeoutMs: next }),
      });
      if (!response.ok) throw new Error("Failed to update image queue wait");
    } catch (error) {
      console.error("Error updating image queue wait:", error);
      setImageQueueTimeoutMs(previous);
    }
  }, [imageQueueTimeoutMs]);

  const handleHideQuota = useCallback((provider, quota) => {
    const key = getQuotaVisibilityKey(quota);
    if (!provider || !key) return;

    const previous = quotaVisibility;
    const providerVisibility = previous[provider] || {};
    const hidden = new Set(providerVisibility.hidden || []);
    hidden.add(key);
    if (provider === "antigravity") {
      if (key === "gemini") {
        for (const k of hidden) {
          if (k.startsWith("gemini-") && !k.includes("image")) hidden.delete(k);
        }
      } else if (key === "claude") {
        for (const k of hidden) {
          if (k.startsWith("claude-")) hidden.delete(k);
        }
      }
    }
    const next = {
      ...previous,
      [provider]: {
        ...providerVisibility,
        hidden: [...hidden],
      },
    };
    updateQuotaVisibility(next, previous);
  }, [quotaVisibility, updateQuotaVisibility]);

  const handleShowQuota = useCallback((provider, quota) => {
    const key = getQuotaVisibilityKey(quota);
    if (!provider || !key) return;

    const previous = quotaVisibility;
    const providerVisibility = previous[provider] || {};
    const hidden = new Set(providerVisibility.hidden || []);
    hidden.delete(key);
    if (provider === "antigravity") {
      if (key === "gemini") {
        for (const k of hidden) {
          if (k.startsWith("gemini-") && !k.includes("image")) hidden.delete(k);
        }
      } else if (key === "claude") {
        for (const k of hidden) {
          if (k.startsWith("claude-")) hidden.delete(k);
        }
      }
    }
    const next = {
      ...previous,
      [provider]: {
        ...providerVisibility,
        hidden: [...hidden],
      },
    };
    updateQuotaVisibility(next, previous);
  }, [quotaVisibility, updateQuotaVisibility]);

  // Auto-refresh interval
  useEffect(() => {
    if (!hasHydratedAutoRefresh || !autoRefresh) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      if (countdownRef.current) {
        clearInterval(countdownRef.current);
        countdownRef.current = null;
      }
      return;
    }

    // Main refresh interval
    intervalRef.current = setInterval(() => {
      refreshAll();
    }, REFRESH_INTERVAL_MS);

    // Countdown interval
    countdownRef.current = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) return 60;
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, [autoRefresh, refreshAll, hasHydratedAutoRefresh]);

  // Pause auto-refresh when tab is hidden (Page Visibility API)
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
        if (countdownRef.current) {
          clearInterval(countdownRef.current);
          countdownRef.current = null;
        }
      } else if (autoRefresh && hasHydratedAutoRefresh) {
        // Resume auto-refresh when tab becomes visible
        intervalRef.current = setInterval(() => refreshAll(), REFRESH_INTERVAL_MS);
        countdownRef.current = setInterval(() => {
          setCountdown((prev) => (prev <= 1 ? 60 : prev - 1));
        }, 1000);
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [autoRefresh, refreshAll, hasHydratedAutoRefresh]);

  const sortedConnections = useMemo(
    () =>
      sortVisibleConnections(
        connections,
        quotaData,
        expiringFirst,
        providerFilter,
        quotaSortMode,
        { sessionLoad: sessionLoadStatus, imageLoad: imageLoadStatus },
      ),
    [connections, quotaData, expiringFirst, providerFilter, quotaSortMode, sessionLoadStatus, imageLoadStatus],
  );

  const quotaHealthByConnection = useMemo(() => {
    const entries = new Map();
    for (const connection of connections) {
      const quota = quotaData[connection.id];
      entries.set(connection.id, getConnectionQuotaHealth({
        ...connection,
        smartQuotaSnapshot: {
          quotas: quota?.quotas || [],
          fetchedAt: quota?.fetchedAt || quota?.cachedAt,
        },
      }));
    }
    return entries;
  }, [connections, quotaData]);

  const recommendedConnection = useMemo(() => {
    if (!smartQuotaUse) return null;
    const candidates = connections.map((connection) => ({
      ...connection,
      smartQuotaSnapshot: {
        quotas: quotaData[connection.id]?.quotas || [],
        fetchedAt: quotaData[connection.id]?.fetchedAt || quotaData[connection.id]?.cachedAt,
      },
    }));
    return getRecommendedConnection(candidates);
  }, [connections, quotaData, smartQuotaUse]);

  const forecastByConnection = useMemo(() => {
    if (!smartQuotaForecast) return new Map();
    return new Map(connections.map((connection) => {
      const current = quotaData[connection.id];
      const currentSnapshot = current?.fetchedAt ? buildQuotaSnapshot(current.quotas, current.fetchedAt) : null;
      return [connection.id, forecastQuota(
        appendQuotaHistory(connection.smartQuotaHistory || [], currentSnapshot),
        null,
      )];
    }));
  }, [connections, quotaData, smartQuotaForecast]);

  const quotaAlertStateRef = useRef(new Map());
  const previousQuotaRef = useRef(new Map());
  useEffect(() => {
    const now = Date.now();
    const previous = previousQuotaRef.current;
    const next = new Map();
    for (const connection of connections) {
      if (connection.isActive === false) continue;
      const current = quotaData[connection.id];
      const last = previous.get(connection.id);
      const snapshot = current?.fetchedAt
        ? buildQuotaSnapshot(current.quotas, current.fetchedAt)
        : connection.smartQuotaSnapshot;
      const isNew = Date.parse(snapshot?.fetchedAt) > Date.parse(last?.snapshot?.fetchedAt);
      const cooldown = Date.parse(connection.cooldownUntil) > now;
      const credentialError = [401, 403].includes(Number(connection.errorCode)) ||
        current?.authError === true;
      next.set(connection.id, { snapshot: isNew || !last?.snapshot ? snapshot : last.snapshot, cooldown, credentialError });
      if (!smartQuotaAlerts || !last) continue;
      const forecast = forecastByConnection.get(connection.id);
      const alerts = isNew ? buildQuotaAlerts(last.snapshot, snapshot, forecast, now) : [];
      if (cooldown && !last.cooldown) alerts.push({ type: "cooldown", key: "account" });
      if (!cooldown && last.cooldown) alerts.push({ type: "recovered", key: "account" });
      if (credentialError && !last.credentialError) alerts.push({ type: "credential", key: "account" });
      const label = getConnectionLabel(connection) || providerLabel(connection.provider);
      for (const alert of dedupeQuotaAlerts(alerts, quotaAlertStateRef.current, now, connection.id)) {
        const messages = {
          reset: `Quota ${alert.key} reset`,
          forecast: `Quota ${alert.key} may run out within two hours`,
          depleted: `Quota ${alert.key} is depleted`,
          low: `Quota ${alert.key} is at 10% or less`,
          cooldown: "Account entered cooldown",
          recovered: "Account cooldown ended",
          credential: "Provider rejected the account credentials",
        };
        const success = alert.type === "reset" || alert.type === "recovered";
        addNotification({ type: success ? "success" : "warning", title: "Smart Quota", message: `${label}: ${messages[alert.type]}` });
      }
    }
    previousQuotaRef.current = next;
  }, [addNotification, connections, forecastByConnection, quotaData, smartQuotaAlerts]);

  const alertByConnection = useMemo(() => {
    const alerts = new Map();
    for (const connection of connections) {
      const quota = quotaData[connection.id];
      alerts.set(connection.id, getQuotaAlertState({
        quotas: quota?.quotas || [],
      }));
    }
    return alerts;
  }, [connections, quotaData]);

  // Connection is depleted when any quota entry hit the threshold
  const isConnectionDepleted = (conn) => {
    const quotas = quotaData[conn.id]?.quotas;
    if (!quotas?.length) return false;
    return quotas.some((q) => {
      if (!q.total || q.total <= 0) return false;
      return calculatePercentage(q.used, q.total) <= DEPLETED_QUOTA_THRESHOLD;
    });
  };

  const bulkSetActive = useCallback(
    async (targetIds, isActive) => {
      if (!targetIds.length || bulkToggling) return;
      setBulkToggling(true);
      try {
        await Promise.all(
          targetIds.map((id) =>
            fetch(`/api/providers/${id}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ isActive }),
            }),
          ),
        );
        await reconcileConnectionsPage(fetchConnections, page);
      } catch (error) {
        console.error("Error bulk toggling connections:", error);
      } finally {
        setBulkToggling(false);
      }
    },
    [bulkToggling, fetchConnections, page],
  );

  const handleDisableDepleted = () => {
    const ids = sortedConnections
      .filter((c) => (c.isActive ?? true) && isConnectionDepleted(c))
      .map((c) => c.id);
    bulkSetActive(ids, false);
  };

  const handleEnableAvailable = () => {
    const ids = sortedConnections
      .filter((c) => !(c.isActive ?? true) && !isConnectionDepleted(c))
      .map((c) => c.id);
    bulkSetActive(ids, true);
  };

  const selectedProviderLabel =
    providerFilter === "all" ? "All providers" : providerLabel(providerFilter);
  const hasEligibleConnections = totals.eligibleConnections > 0;
  const hasVisibleConnections = sortedConnections.length > 0;
  const emptyState = getConnectionsEmptyMessage(
    totals,
    providerFilter,
    accountFilter,
  );
  const connectionsPageSummary = getConnectionsPaginationSummary(pagination);
  const isCustomPageSize = !ACCOUNT_PAGE_SIZE_OPTIONS.includes(pageSize);
  const pageSizeLabel = getPageSizeLabel(pageSize, isCustomPageSize);

  return (
    <div className="space-y-6">
      {/* Header Controls */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-end">
        <div className="flex flex-wrap items-center gap-1.5">
          <div className="relative">
            <button
              type="button"
              onClick={() => setProviderMenuOpen((prev) => !prev)}
              className="flex h-8 items-center justify-between gap-1 rounded-lg border border-black/10 bg-black/[0.02] px-2 text-xs text-text-primary transition-colors hover:bg-black/5 dark:border-white/10 dark:bg-white/[0.03] dark:hover:bg-white/10"
              aria-haspopup="menu"
              aria-expanded={providerMenuOpen}
              title="Filter quota providers"
            >
              <span className="flex min-w-0 items-center gap-1.5">
                {providerFilter === "all" ? (
                  <span className="material-symbols-outlined text-[14px] text-text-muted">
                    apps
                  </span>
                ) : (
                  <ProviderIcon
                    src={`/providers/${providerFilter}.png`}
                    alt={providerFilter}
                    size={18}
                    className="size-[18px] rounded object-contain"
                    fallbackText={providerFilter.slice(0, 2).toUpperCase()}
                  />
                )}
                <span className="truncate hidden lg:inline">
                  {selectedProviderLabel}
                </span>
              </span>
              <span className="material-symbols-outlined text-[14px] text-text-muted">
                expand_more
              </span>
            </button>

            {providerMenuOpen && (
              <>
                <button
                  type="button"
                  className="fixed inset-0 z-30 bg-transparent"
                  aria-label="Close provider filter"
                  onClick={() => setProviderMenuOpen(false)}
                />
                <div className="absolute left-0 z-40 mt-2 w-64 overflow-hidden rounded-2xl border border-black/10 bg-surface/95 p-1.5 shadow-xl shadow-black/10 backdrop-blur dark:border-white/10 dark:bg-surface/95 sm:w-72">
                  <button
                    type="button"
                    onClick={() => {
                      if (shouldResetPage(providerFilter, "all")) {
                        setPage(1);
                      }
                      setProviderFilter("all");
                      setProviderMenuOpen(false);
                    }}
                    className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors ${providerFilter === "all" ? "bg-primary/10 text-primary" : "text-text-primary hover:bg-black/5 dark:hover:bg-white/10"}`}
                  >
                    <span className="material-symbols-outlined text-[22px]">
                      apps
                    </span>
                    <span className="font-medium">All providers</span>
                    {providerFilter === "all" && (
                      <span className="material-symbols-outlined ml-auto text-[20px]">
                        check
                      </span>
                    )}
                  </button>
                  <div className="my-1 h-px bg-black/10 dark:bg-white/10" />
                  <div className="max-h-72 overflow-y-auto pr-1">
                    {providerOptions.map((provider) => (
                      <button
                        key={provider}
                        type="button"
                        onClick={() => {
                          if (shouldResetPage(providerFilter, provider)) {
                            setPage(1);
                          }
                          setProviderFilter(provider);
                          setProviderMenuOpen(false);
                        }}
                        className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors ${providerFilter === provider ? "bg-primary/10 text-primary" : "text-text-primary hover:bg-black/5 dark:hover:bg-white/10"}`}
                      >
                        <ProviderIcon
                          src={`/providers/${provider}.png`}
                          alt={provider}
                          size={24}
                          className="size-6 rounded-md object-contain"
                          fallbackText={provider.slice(0, 2).toUpperCase()}
                        />
                        <span className="font-medium">
                          {providerLabel(provider)}
                        </span>
                        {providerFilter === provider && (
                          <span className="material-symbols-outlined ml-auto text-[20px]">
                            check
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
          <select
            value={accountFilter}
            onChange={(event) => {
              const nextValue = event.target.value;
              if (shouldResetPage(accountFilter, nextValue)) {
                setPage(1);
              }
              setAccountFilter(nextValue);
            }}
            className="h-8 rounded-lg border border-black/10 bg-black/[0.02] px-2 text-xs text-text-primary outline-none transition-colors hover:bg-black/5 dark:border-white/10 dark:bg-white/[0.03] dark:hover:bg-white/10"
            aria-label="Filter accounts by status"
          >
            {ACCOUNT_FILTER_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>

          <select
            value={quotaSortMode}
            onChange={(event) => setQuotaSortMode(event.target.value)}
            className="h-8 rounded-lg border border-black/10 bg-black/[0.02] px-2 text-xs text-text-primary outline-none transition-colors hover:bg-black/5 dark:border-white/10 dark:bg-white/[0.03] dark:hover:bg-white/10"
            aria-label="Quick sort accounts by quota remaining"
            title="Quick sort accounts by quota remaining"
          >
            {QUOTA_SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>

          {providerFilter !== "all" && (
            <label className="flex h-8 shrink-0 items-center gap-1 rounded-lg border border-black/10 px-2 text-xs dark:border-white/10" title="Maximum concurrent requests per account (empty = unlimited)">
              <span className="material-symbols-outlined text-[14px]">speed</span>
              <span className="hidden sm:inline">Requests</span>
              <input
                type="number"
                min="1"
                max="32"
                value={sessionMaxConcurrent[providerFilter] ?? ""}
                placeholder="∞"
                onChange={(event) => updateSessionMaxConcurrent(providerFilter, event.target.value)}
                className="w-10 bg-transparent text-center text-xs outline-none"
                aria-label={`${providerFilter} maximum concurrent requests per account`}
              />
            </label>
          )}

          {providerFilter !== "all" && (
            <label className="flex h-8 shrink-0 items-center gap-1 rounded-lg border border-black/10 px-2 text-xs dark:border-white/10" title="Maximum concurrent image jobs per account (empty = unlimited). Extra jobs wait in a queue, then get 503.">
              <span className="material-symbols-outlined text-[14px]">image</span>
              <span className="hidden sm:inline">Images</span>
              <input
                type="number"
                min="1"
                max="8"
                value={imageMaxConcurrent[providerFilter] ?? ""}
                placeholder="∞"
                onChange={(event) => updateImageMaxConcurrent(providerFilter, event.target.value)}
                className="w-10 bg-transparent text-center text-xs outline-none"
                aria-label={`${providerFilter} maximum concurrent image jobs per account`}
              />
            </label>
          )}

          {providerFilter !== "all" && imageMaxConcurrent[providerFilter] != null && (
            <label className="flex h-8 shrink-0 items-center gap-1 rounded-lg border border-black/10 px-2 text-xs dark:border-white/10" title="How long an image job waits for a free slot before returning 503 (seconds, all providers)">
              <span className="material-symbols-outlined text-[14px]">hourglass_empty</span>
              <span className="hidden sm:inline">Wait</span>
              <input
                type="number"
                min="1"
                max="300"
                value={Math.round(imageQueueTimeoutMs / 1000)}
                onChange={(event) => updateImageQueueTimeout(event.target.value)}
                className="w-12 bg-transparent text-center text-xs outline-none"
                aria-label="Image queue wait in seconds"
              />
              <span className="text-text-muted">s</span>
            </label>
          )}

          <button
            type="button"
            onClick={() => setExpiringFirst((prev) => !prev)}
            aria-pressed={expiringFirst}
            className={`flex h-8 shrink-0 items-center gap-1 rounded-lg border px-2 text-xs transition-colors ${expiringFirst ? "border-amber-500/40 bg-amber-500/10 text-amber-500" : "border-black/10 text-text-primary hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5"}`}
            title="Sort accounts by earliest quota reset time"
          >
            <span className="material-symbols-outlined text-[14px]">
              hourglass_top
            </span>
            <span className="hidden sm:inline">Expiring first</span>
          </button>

          <button
            type="button"
            onClick={toggleSmartQuotaUse}
            aria-pressed={smartQuotaUse}
            className={`flex h-8 shrink-0 items-center gap-1 rounded-lg border px-2 text-xs transition-colors ${smartQuotaUse ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "border-black/10 text-text-primary hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5"}`}
            title="Prefer accounts with healthier fresh quota"
          >
            <span className="material-symbols-outlined text-[14px]">auto_awesome</span>
            <span className="hidden sm:inline">Smart Use</span>
          </button>

          <button
            type="button"
            onClick={() => toggleSmartQuotaSetting("smartQuotaForecast", smartQuotaForecast, setSmartQuotaForecast)}
            aria-pressed={smartQuotaForecast}
            className={`flex h-8 shrink-0 items-center gap-1 rounded-lg border px-2 text-xs transition-colors ${smartQuotaForecast ? "border-cyan-500/40 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300" : "border-black/10 text-text-primary dark:border-white/10"}`}
            title="Estimate time until quota exhaustion"
          >
            <span className="material-symbols-outlined text-[14px]">query_stats</span>
            <span className="hidden sm:inline">Forecast</span>
          </button>

          <button
            type="button"
            onClick={() => toggleSmartQuotaSetting("smartQuotaAlerts", smartQuotaAlerts, setSmartQuotaAlerts)}
            aria-pressed={smartQuotaAlerts}
            className={`flex h-8 shrink-0 items-center gap-1 rounded-lg border px-2 text-xs transition-colors ${smartQuotaAlerts ? "border-orange-500/40 bg-orange-500/10 text-orange-700 dark:text-orange-300" : "border-black/10 text-text-primary dark:border-white/10"}`}
            title="Show quota forecast warnings"
          >
            <span className="material-symbols-outlined text-[14px]">notifications_active</span>
            <span className="hidden sm:inline">Alerts</span>
          </button>

          <button
            type="button"
            onClick={() => toggleSmartQuotaSetting("smartQuotaBackgroundRefresh", smartQuotaBackgroundRefresh, setSmartQuotaBackgroundRefresh)}
            aria-pressed={smartQuotaBackgroundRefresh}
            className={`flex h-8 shrink-0 items-center gap-1 rounded-lg border px-2 text-xs transition-colors ${smartQuotaBackgroundRefresh ? "border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300" : "border-black/10 text-text-primary dark:border-white/10"}`}
            title="Refresh quota in the background while the dashboard is closed"
          >
            <span className="material-symbols-outlined text-[14px]">sync</span>
            <span className="hidden sm:inline">Background</span>
          </button>

          {providerFilter !== "all" && (
            <button
              type="button"
              onClick={() => toggleSessionPin(providerFilter)}
              aria-pressed={sessionPin[providerFilter] === true}
              className={`flex h-8 shrink-0 items-center gap-1 rounded-lg border px-2 text-xs transition-colors ${sessionPin[providerFilter] === true ? "border-indigo-500/40 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300" : "border-black/10 text-text-primary dark:border-white/10"}`}
              title={`Keep each ${providerLabel(providerFilter)} session on one account until failover`}
            >
              <span className="material-symbols-outlined text-[14px]">push_pin</span>
              <span className="hidden sm:inline">Pin Session</span>
            </button>
          )}

          {/* Bulk: disable depleted */}
          <button
            type="button"
            onClick={handleDisableDepleted}
            disabled={bulkToggling}
            className="flex h-8 shrink-0 items-center gap-1 rounded-lg border border-red-500/30 px-2 text-xs text-red-500 transition-colors hover:bg-red-500/10 disabled:opacity-50"
            title="Disable connections with depleted quota on the current page"
          >
            <span className="material-symbols-outlined text-[14px]">block</span>
            <span className="hidden sm:inline">Turn off Empty</span>
          </button>

          {/* Bulk: enable available */}
          <button
            type="button"
            onClick={handleEnableAvailable}
            disabled={bulkToggling}
            className="flex h-8 shrink-0 items-center gap-1 rounded-lg border border-emerald-500/30 px-2 text-xs text-emerald-500 transition-colors hover:bg-emerald-500/10 disabled:opacity-50"
            title="Enable connections that still have quota on the current page"
          >
            <span className="material-symbols-outlined text-[14px]">
              check_circle
            </span>
            <span className="hidden sm:inline">Turn on Available</span>
          </button>

          {/* Auto-refresh toggle */}
          <button
            onClick={() => setAutoRefresh((prev) => !prev)}
            className="flex h-8 shrink-0 items-center gap-1 rounded-lg border border-black/10 px-2 text-xs transition-colors hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5"
            title={autoRefresh ? "Disable auto-refresh" : "Enable auto-refresh"}
          >
            <span
              className={`material-symbols-outlined text-[14px] ${
                autoRefresh ? "text-primary" : "text-text-muted"
              }`}
            >
              {autoRefresh ? "toggle_on" : "toggle_off"}
            </span>
            <span className="hidden text-text-primary sm:inline">
              Auto-refresh
            </span>
            {autoRefresh && (
              <span className="text-[10px] text-text-muted tabular-nums">
                ({countdown}s)
              </span>
            )}
          </button>


          {/* Refresh all button */}
          <button
            type="button"
            onClick={() => refreshAll(true)}
            disabled={refreshingAll}
            className="flex h-8 shrink-0 items-center gap-1 rounded-lg border border-black/10 px-2 text-xs text-text-primary transition-colors hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5 disabled:opacity-50"
            title="Refresh all"
          >
            <span
              className={`material-symbols-outlined text-[14px] ${refreshingAll ? "animate-spin" : ""}`}
            >
              refresh
            </span>
          </button>
        </div>
      </div>

      {recommendedConnection && (
        <div className="flex items-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
          <span className="material-symbols-outlined text-[16px]">auto_awesome</span>
          <span>
            Smart Use recommends <strong>{getConnectionLabel(recommendedConnection) || providerLabel(recommendedConnection.provider)}</strong> based on fresh quota and reset time.
          </span>
        </div>
      )}

      {!connectionsLoading && !hasVisibleConnections && (
        <Card padding="lg">
          <div className="text-center py-12">
            <span className="material-symbols-outlined text-[64px] text-text-muted opacity-20">
              {emptyState.icon}
            </span>
            <h3 className="mt-4 text-lg font-semibold text-text-primary">
              {!hasEligibleConnections ? "No Providers Connected" : emptyState.title}
            </h3>
            <p className="mt-2 text-sm text-text-muted max-w-md mx-auto">
              {!hasEligibleConnections
                ? "Connect to providers with OAuth to track your API quota limits and usage."
                : emptyState.description}
            </p>
          </div>
        </Card>
      )}

      {/* Provider cards: 2 columns, compact */}
      {expiringFirst && (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          Expiring-first currently reorders accounts inside the current page.
          Cross-page ordering still follows backend pagination.
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {sortedConnections.map((conn) => {
          const quota = quotaData[conn.id];
          const isLoading = loading[conn.id];
          const error = errors[conn.id];

          // Use table layout for all providers
          const isInactive = conn.isActive === false;
          const isCodex = conn.provider === "codex";
          const claudeReset = conn.provider === "claude" ? quota?.raw?.resetCredits : null;
          const resetLabel = isCodex ? "Codex reset credit" : "Claude limit reset";
          const resetCreditCount = getCodexResetCreditCount(quota);
          const isResettingLimit = resettingLimitId === conn.id;
          const rowBusy = deletingId === conn.id || togglingId === conn.id || isResettingLimit;
          const rawQuotas = quota?.quotas || [];
          const visibleQuotas = filterQuotasByVisibility(conn.provider, rawQuotas, quotaVisibility);
          const hiddenQuotaRows = getHiddenQuotaRows(conn.provider, rawQuotas, quotaVisibility);
          const quotaHealth = quotaHealthByConnection.get(conn.id);
          const isRecommended = recommendedConnection?.id === conn.id;
          const forecast = forecastByConnection.get(conn.id);
          const quotaAlert = alertByConnection.get(conn.id);
          const sessionLoad = !isInactive && sessionLoadStatus[conn.id];
          const imageLoad = !isInactive && imageLoadStatus[conn.id];

          return (
            <Card
              key={conn.id}
              padding="none"
              className={`min-w-0 ${isInactive ? "opacity-60" : ""}`}
            >
              <div className="px-3 py-2 border-b border-black/10 dark:border-white/10">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex min-w-0 flex-1 items-start gap-2">
                    <div className="w-8 h-8 shrink-0 rounded-md flex items-center justify-center overflow-hidden">
                      <ProviderIcon
                        src={`/providers/${conn.provider}.png`}
                        alt={conn.provider}
                        size={32}
                        className="object-contain"
                        fallbackText={
                          conn.provider?.slice(0, 2).toUpperCase() || "PR"
                        }
                      />
                    </div>
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold text-text-primary truncate">
                        {providerLabel(conn.provider)}
                      </h3>
                      {isRecommended && (
                        <span className="mt-0.5 inline-flex items-center gap-0.5 rounded-full bg-emerald-500/10 px-1 py-px text-[9px] font-semibold leading-4 text-emerald-700 dark:text-emerald-300" title="Recommended account">
                          <span className="material-symbols-outlined text-[10px]">auto_awesome</span>
                          Top
                        </span>
                      )}
                      {quotaHealth?.stale && (
                        <span className="mt-0.5 inline-flex items-center gap-0.5 rounded-full bg-amber-500/10 px-1 py-px text-[9px] font-semibold leading-4 text-amber-700 dark:text-amber-300" title="Quota data is stale">
                          <span className="material-symbols-outlined text-[10px]">schedule</span>
                          Stale
                        </span>
                      )}
                      {forecast && smartQuotaAlerts && (
                        <span className="mt-0.5 inline-flex items-center gap-0.5 rounded-full bg-orange-500/10 px-1 py-px text-[9px] font-semibold leading-4 text-orange-700 dark:text-orange-300" title="Estimated time until quota exhaustion">
                          <span className="material-symbols-outlined text-[10px]">trending_down</span>
                          ~{Math.max(1, Math.round(forecast.hoursUntilEmpty))}h
                        </span>
                      )}
                      {quotaAlert?.resetSoon && smartQuotaAlerts && (
                        <span className="mt-0.5 inline-flex items-center gap-0.5 rounded-full bg-blue-500/10 px-1 py-px text-[9px] font-semibold leading-4 text-blue-700 dark:text-blue-300" title="Quota reset soon">
                          <span className="material-symbols-outlined text-[10px]">event_upcoming</span>
                          Reset
                        </span>
                      )}
                      {getConnectionLabel(conn) ? (
                        <p className="text-xs text-text-muted truncate">
                          {getConnectionLabel(conn)}
                        </p>
                      ) : null}
                      {sessionLoad && (
                        <p className={`text-[11px] ${sessionLoad.overloaded ? "font-semibold text-amber-700 dark:text-amber-300" : "text-text-muted"}`}>
                          {sessionLoad.activeRequests}/{sessionLoad.maxConcurrent ?? "∞"} requests active
                          {sessionLoad.overloaded && " · At capacity"}
                          {sessionLoad.ewmaLatencyMs > 0 && ` · ${Math.round(sessionLoad.ewmaLatencyMs)}ms avg`}
                          {sessionLoad.recentErrors > 0 && ` · ${sessionLoad.recentErrors} recent error${sessionLoad.recentErrors === 1 ? "" : "s"}`}
                        </p>
                      )}
                      {imageLoad && imageLoad.running > 0 && (
                        <p className={`text-[11px] ${imageLoad.overloaded ? "font-semibold text-orange-700 dark:text-orange-300" : "text-text-muted"}`}>
                          {imageLoad.running}/{imageLoad.maxConcurrent ?? "∞"} image jobs
                        </p>
                      )}
                      {getConnectionSecondaryLabel(conn) ? (
                        <p className="text-[11px] text-text-muted/80 truncate">
                          {getConnectionSecondaryLabel(conn)}
                        </p>
                      ) : null}
                      {conn.provider === "kiro" && (
                        <div className="mt-1 flex flex-wrap items-center gap-1">
                          <span className="rounded-full bg-brand-500/10 px-2 py-0.5 text-[10px] font-semibold text-brand-600 dark:text-brand-300">
                            {kiroMethodLabel(conn)}
                          </span>
                          {kiroRegion(conn) && (
                            <span className="rounded-full bg-blue-500/10 px-2 py-0.5 text-[10px] font-semibold text-blue-600 dark:text-blue-400">
                              {kiroRegion(conn)}
                            </span>
                          )}
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                              isInactive
                                ? "bg-surface-2 text-text-muted"
                                : conn.testStatus === "active" || conn.testStatus === "success"
                                  ? "bg-green-500/10 text-green-600 dark:text-green-400"
                                  : conn.testStatus === "error" || conn.testStatus === "expired" || conn.testStatus === "unavailable"
                                    ? "bg-red-500/10 text-red-600 dark:text-red-400"
                                    : "bg-surface-2 text-text-muted"
                            }`}
                          >
                            {isInactive ? "disabled" : conn.testStatus || "unknown"}
                          </span>
                          {conn.providerSpecificData?.profileArn && (
                            <button
                              type="button"
                              onClick={() => copy(conn.providerSpecificData.profileArn, conn.id)}
                              title={conn.providerSpecificData.profileArn}
                              className="inline-flex max-w-full items-center gap-1 rounded-full border border-border-subtle px-2 py-0.5 text-[10px] text-text-muted transition-colors hover:text-primary"
                            >
                              <span className="material-symbols-outlined text-[12px]">
                                {copied === conn.id ? "check" : "content_copy"}
                              </span>
                              <code className="truncate font-mono">
                                {conn.providerSpecificData.profileArn}
                              </code>
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex w-full shrink-0 flex-wrap items-center justify-end gap-1 sm:w-auto">
                    {(isCodex || claudeReset) && (
                      <>
                        <Tooltip
                          text={
                            resetCreditCount > 0
                              ? claudeReset
                                ? `Use your reset now (${resetCreditCount} left, use by ${formatCreditDate(claudeReset.expiresAt)}) · refills ${formatClaudeResetClears(claudeReset.clears)}`
                                : `Use one ${resetLabel}. Available: ${resetCreditCount}`
                              : `No ${resetLabel}s available`
                          }
                        >
                          <button
                            type="button"
                            onClick={() => setResetConfirmState({ connection: conn, resetCreditCount })}
                            disabled={resetCreditCount <= 0 || isLoading || rowBusy}
                            aria-label={
                              resetCreditCount > 0
                                ? `Use one ${resetLabel}. ${resetCreditCount} available.`
                                : `No ${resetLabel}s available`
                            }
                            className={`flex h-8 min-w-10 items-center justify-center gap-1 rounded-lg border px-2 text-[11px] font-medium tabular-nums transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary/60 disabled:cursor-not-allowed disabled:opacity-60 ${
                              resetCreditCount > 0
                                ? "border-primary/30 bg-primary/5 text-primary hover:bg-primary/10"
                                : "border-black/10 bg-black/[0.02] text-text-muted dark:border-white/10 dark:bg-white/[0.03]"
                            }`}
                          >
                            <span className={`material-symbols-outlined text-[15px] ${isResettingLimit ? "animate-spin" : ""}`}>
                              {isResettingLimit ? "progress_activity" : "restart_alt"}
                            </span>
                            <span>{resetCreditCount}</span>
                          </button>
                        </Tooltip>
                        <Tooltip text={isCodex ? "View Codex reset credit expiry" : "View Claude Code reset expiry"}>
                          <button
                            type="button"
                            onClick={() => (isCodex ? handleViewCodexResetCredits(conn) : handleViewClaudeResets(conn, claudeReset))}
                            disabled={isLoading || rowBusy}
                            aria-label={isCodex ? "View Codex reset credit expiry" : "View Claude Code reset expiry"}
                            className="flex h-8 w-8 items-center justify-center rounded-lg border border-black/10 text-text-muted transition-colors hover:bg-black/5 hover:text-primary disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:hover:bg-white/5"
                          >
                            <span className="material-symbols-outlined text-[17px]">schedule</span>
                          </button>
                        </Tooltip>
                      </>
                    )}
                    {AUTO_PING_SETTINGS_KEYS[conn.provider] && conn.authType === "oauth" && (() => {
                      const cfg = autoPingConfigs[conn.provider] || {};
                      const isReactive = cfg.connections?.[conn.id] === true;
                      const schedule = cfg.schedules?.[conn.id];
                      const isSchedule = schedule?.enabled === true;
                      const isActive = isReactive || isSchedule;

                      const activeModes = [];
                      if (isReactive) activeModes.push("On reset");
                      if (isSchedule) {
                        const summary = getScheduleSlotLabels(schedule).join(" / ");
                        activeModes.push(`Scheduled (${summary || "active"})`);
                      }
                      const tooltipText = activeModes.length > 0
                        ? `Auto-ping active: ${activeModes.join(" + ")}. Click to configure.`
                        : conn.provider === "codex"
                          ? "Auto-starts the next 5h Codex window after reset or on schedule. Click to configure."
                          : "Auto-starts a new window on quota reset or fixed schedule. Click to configure.";

                      return (
                        <Tooltip text={tooltipText}>
                          <button
                            type="button"
                            onClick={() => setScheduleConnection(conn)}
                            aria-label="Configure auto-ping"
                            className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-black/5 dark:hover:bg-white/5 ${isActive ? "text-primary" : "text-text-muted"}`}
                          >
                            <span className="material-symbols-outlined text-[18px]">bolt</span>
                          </button>
                        </Tooltip>
                      );
                    })()}
                    <Tooltip text="Refresh quota">
                      <button
                        type="button"
                        onClick={() => refreshProvider(conn.id, conn.provider)}
                        disabled={isLoading || rowBusy}
                        aria-label="Refresh quota"
                        className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
                      >
                        <span
                          className={`material-symbols-outlined text-[18px] text-text-muted ${isLoading ? "animate-spin" : ""}`}
                        >
                          refresh
                        </span>
                      </button>
                    </Tooltip>
                    <Tooltip text="Edit connection">
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedConnection(conn);
                          setShowEditModal(true);
                        }}
                        disabled={rowBusy}
                        aria-label="Edit connection"
                        className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-text-muted hover:text-primary transition-colors disabled:opacity-50"
                      >
                        <span className="material-symbols-outlined text-[18px]">
                          edit
                        </span>
                      </button>
                    </Tooltip>
                    <Tooltip text="Delete connection">
                      <button
                        type="button"
                        onClick={() => handleDeleteConnection(conn.id)}
                        disabled={rowBusy}
                        aria-label="Delete connection"
                        className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-red-500/10 text-red-500 transition-colors disabled:opacity-50"
                      >
                        <span
                          className={`material-symbols-outlined text-[18px] ${deletingId === conn.id ? "animate-pulse" : ""}`}
                        >
                          delete
                        </span>
                      </button>
                    </Tooltip>
                    <div
                      className="inline-flex items-center pl-0.5"
                      title={
                        (conn.isActive ?? true)
                          ? "Disable connection"
                          : "Enable connection"
                      }
                    >
                      <Toggle
                        size="sm"
                        checked={conn.isActive ?? true}
                        disabled={rowBusy}
                        onChange={(nextActive) =>
                          handleToggleConnectionActive(conn.id, nextActive)
                        }
                      />
                    </div>
                  </div>
                </div>
              </div>

              <div className="px-2 py-1.5">
                {isLoading ? (
                  <div className="text-center py-5 text-text-muted">
                    <span className="material-symbols-outlined text-[28px] animate-spin">
                      progress_activity
                    </span>
                  </div>
                ) : error ? (
                  <div className="text-center py-5">
                    <span className="material-symbols-outlined text-[28px] text-red-500">
                      error
                    </span>
                    <p className="mt-1.5 text-xs text-text-muted">{error}</p>
                  </div>
                ) : quota?.message ? (
                  <div className="text-center py-5">
                    <p className="text-xs text-text-muted">{quota.message}</p>
                  </div>
                ) : (
                  <QuotaTable
                    quotas={visibleQuotas}
                    compact
                    sortMode="default"
                    showSortLabel={
                      conn.provider === "codex" && isRemainingSortMode(quotaSortMode)
                    }
                    onHideQuota={(quotaRow) => handleHideQuota(conn.provider, quotaRow)}
                  />
                )}
                {quota?.message && !error && !isLoading && (
                  <p className="mt-2 px-1 text-[10px] leading-relaxed text-text-muted">
                    {quota.message}
                  </p>
                )}
                {hiddenQuotaRows.length > 0 && (
                  <div className="mt-2 flex min-w-0 items-center gap-1 border-t border-black/5 pt-2 text-[10px] text-text-muted dark:border-white/5">
                    <span className="material-symbols-outlined shrink-0 text-[14px]">
                      visibility_off
                    </span>
                    <span className="shrink-0">Hidden:</span>
                    <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto whitespace-nowrap pb-2">
                      {hiddenQuotaRows.map((quotaRow) => (
                        <button
                          key={getQuotaVisibilityKey(quotaRow)}
                          type="button"
                          onClick={() => handleShowQuota(conn.provider, quotaRow)}
                          className="shrink-0 rounded-md border border-black/10 px-1.5 py-0.5 transition-colors hover:bg-black/5 hover:text-text-primary dark:border-white/10 dark:hover:bg-white/5"
                          title="Show this quota row"
                        >
                          {quotaRow.name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </Card>
          );
        })}
      </div>

      <div className="rounded-xl border border-black/10 bg-black/[0.02] px-3 py-2 dark:border-white/10 dark:bg-white/[0.03]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-text-muted">{connectionsPageSummary}</span>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={isCustomPageSize ? "custom" : String(pageSize)}
                onChange={(event) => {
                  const nextValue = event.target.value;
                  if (nextValue === "custom") return;
                  const nextPageSize = Number.parseInt(nextValue, 10);
                  if (Number.isFinite(nextPageSize)) {
                    setPage(1);
                    setPageSize(nextPageSize);
                    setCustomPageSizeInput(String(nextPageSize));
                  }
                }}
                className="h-8 rounded-lg border border-black/10 bg-black/[0.02] px-2 text-xs text-text-primary outline-none transition-colors hover:bg-black/5 dark:border-white/10 dark:bg-white/[0.03] dark:hover:bg-white/10"
                aria-label="Accounts per page"
              >
                {ACCOUNT_PAGE_SIZE_OPTIONS.map((option) => (
                  <option key={option} value={String(option)}>
                    {option} / page
                  </option>
                ))}
                <option value="custom">Custom</option>
              </select>
              <input
                type="number"
                min="1"
                max={String(ACCOUNT_PAGE_SIZE_MAX)}
                inputMode="numeric"
                value={customPageSizeInput}
                onChange={(event) => setCustomPageSizeInput(event.target.value)}
                onBlur={() => {
                  const parsedValue = Number.parseInt(customPageSizeInput, 10);
                  if (!Number.isFinite(parsedValue)) {
                    setCustomPageSizeInput(String(pageSize));
                    return;
                  }
                  const nextPageSize = Math.min(ACCOUNT_PAGE_SIZE_MAX, Math.max(1, parsedValue));
                  setPage(1);
                  setPageSize(nextPageSize);
                  setCustomPageSizeInput(String(nextPageSize));
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  const parsedValue = Number.parseInt(customPageSizeInput, 10);
                  if (!Number.isFinite(parsedValue)) {
                    setCustomPageSizeInput(String(pageSize));
                    return;
                  }
                  const nextPageSize = Math.min(ACCOUNT_PAGE_SIZE_MAX, Math.max(1, parsedValue));
                  setPage(1);
                  setPageSize(nextPageSize);
                  setCustomPageSizeInput(String(nextPageSize));
                }}
                className="h-8 w-20 rounded-lg border border-black/10 bg-black/[0.02] px-2 text-xs text-text-primary outline-none transition-colors hover:bg-black/5 dark:border-white/10 dark:bg-white/[0.03] dark:hover:bg-white/10"
                aria-label="Custom accounts per page"
                placeholder="Custom"
              />
              <span className="text-xs text-text-muted">Page {pagination.page} / {pagination.totalPages}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setPage(1)}
                disabled={
                  pagination.page <= 1 || connectionsLoading || refreshingAll
                }
                className="flex h-8 items-center rounded-lg border border-black/10 px-3 text-xs text-text-primary transition-colors hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10 dark:hover:bg-white/5"
              >
                First Page
              </button>
              <button
                type="button"
                onClick={() =>
                  setPage((currentPage) => Math.max(1, currentPage - 1))
                }
                disabled={
                  pagination.page <= 1 || connectionsLoading || refreshingAll
                }
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-black/10 text-text-primary transition-colors hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10 dark:hover:bg-white/5"
                aria-label="Previous accounts page"
              >
                <span className="material-symbols-outlined text-[16px]">
                  chevron_left
                </span>
              </button>
              <button
                type="button"
                onClick={() =>
                  setPage((currentPage) =>
                    Math.min(pagination.totalPages, currentPage + 1),
                  )
                }
                disabled={
                  pagination.page >= pagination.totalPages ||
                  connectionsLoading ||
                  refreshingAll
                }
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-black/10 text-text-primary transition-colors hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10 dark:hover:bg-white/5"
                aria-label="Next accounts page"
              >
                <span className="material-symbols-outlined text-[16px]">
                  chevron_right
                </span>
              </button>
              <button
                type="button"
                onClick={() => setPage(pagination.totalPages)}
                disabled={
                  pagination.page >= pagination.totalPages ||
                  connectionsLoading ||
                  refreshingAll
                }
                className="flex h-8 items-center rounded-lg border border-black/10 px-3 text-xs text-text-primary transition-colors hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10 dark:hover:bg-white/5"
              >
                Last Page
              </button>
            </div>
          </div>
        </div>

      <ConfirmModal
        isOpen={Boolean(resetConfirmState)}
        onClose={() => {
          if (!resettingLimitId) setResetConfirmState(null);
        }}
        onConfirm={async () => {
          const connection = resetConfirmState?.connection;
          if (!connection) return;
          await handleResetCodexLimit(connection.id, connection.provider);
          setResetConfirmState(null);
        }}
        title={resetConfirmState?.connection?.provider === "claude" ? "Reset Claude limits?" : "Reset Codex limit?"}
        message={resetConfirmState?.connection?.provider === "claude"
          ? `Refills your ${formatClaudeResetClears(quotaData[resetConfirmState.connection.id]?.raw?.resetCredits?.clears)} now for ${getConnectionLabel(resetConfirmState.connection) || "this account"} · your weekly reset day stays ${formatCreditDate(quotaData[resetConfirmState.connection.id]?.raw?.resetCredits?.weeklyResetsAt)}. This cannot be undone. Resets left: ${resetConfirmState.resetCreditCount ?? 0}.`
          : `Use 1 Codex reset credit for ${getConnectionLabel(resetConfirmState?.connection || {}) || "this account"}. This cannot be undone. Remaining credits: ${resetConfirmState?.resetCreditCount ?? 0}.`}
        confirmText="Reset limit"
        cancelText="Cancel"
        variant="danger"
        loading={Boolean(resettingLimitId)}
      />

      {resetCreditsState && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm">
          <div className="w-full max-w-2xl overflow-hidden rounded-2xl border border-black/15 bg-white shadow-2xl ring-1 ring-black/10 dark:border-white/15 dark:bg-neutral-950 dark:ring-white/10">
            <div className="flex items-start justify-between gap-3 border-b border-black/10 bg-black/[0.03] px-4 py-3 dark:border-white/10 dark:bg-white/[0.04]">
              <div className="min-w-0">
                <h3 className="text-base font-semibold text-text-primary">
                  {resetCreditsState.data?.kind === "claude" ? "Claude Code Limit Resets" : "Codex Reset Credit Expiry"}
                </h3>
                <p className="mt-0.5 truncate text-xs text-text-muted">
                  {getConnectionLabel(resetCreditsState.connection) || (resetCreditsState.data?.kind === "claude" ? "Claude account" : "Codex account")}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setResetCreditsState(null)}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-black/5 hover:text-text-primary dark:hover:bg-white/5"
                aria-label="Close reset credit expiry modal"
              >
                <span className="material-symbols-outlined text-[18px]">close</span>
              </button>
            </div>

            <div className="max-h-[70vh] overflow-auto bg-white p-4 dark:bg-neutral-950">
              {resetCreditsState.loading ? (
                <div className="flex items-center justify-center gap-2 py-10 text-sm text-text-muted">
                  <span className="material-symbols-outlined animate-spin text-[20px]">progress_activity</span>
                  Loading reset credits...
                </div>
              ) : resetCreditsState.error ? (
                <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-300">
                  {resetCreditsState.error}
                </div>
              ) : resetCreditsState.data?.kind === "claude" && resetCreditsState.data.grants?.length ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between rounded-xl border border-black/10 bg-black/[0.02] px-3 py-2 text-xs text-text-muted dark:border-white/10 dark:bg-white/[0.03]">
                    <span>{resetCreditsState.data.availableCount ?? 0} reset{resetCreditsState.data.availableCount === 1 ? "" : "s"} left</span>
                    <span>Weekly reset day: {formatCreditDate(resetCreditsState.data.weeklyResetsAt)}</span>
                  </div>
                  <div className="overflow-x-auto rounded-xl border border-black/10 dark:border-white/10">
                    <table className="w-full min-w-[560px] text-left text-sm">
                      <thead className="bg-black/[0.03] text-xs uppercase tracking-wide text-text-muted dark:bg-white/[0.04]">
                        <tr>
                          <th className="px-3 py-2 font-medium">Reset</th>
                          <th className="px-3 py-2 font-medium">Left</th>
                          <th className="px-3 py-2 font-medium">Refills</th>
                          <th className="px-3 py-2 font-medium">Use By</th>
                          <th className="px-3 py-2 font-medium">Remaining</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(resetCreditsState.data.grants || []).map((grant) => (
                          <tr key={grant.id} className="border-t border-black/5 dark:border-white/5">
                            <td className="px-3 py-2">
                              <div className="text-text-primary">{grant.label || grant.id}</div>
                              <span className="mt-1 inline-block rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                                {claudeGrantStatus(grant)}
                              </span>
                            </td>
                            <td className="whitespace-nowrap px-3 py-2 font-medium tabular-nums text-text-primary">{grant.resetsLeft} / {grant.resetsTotal}</td>
                            <td className="px-3 py-2 text-text-muted">{formatClaudeResetClears(grant.clears)}</td>
                            <td className="px-3 py-2 text-text-primary">{formatCreditDate(grant.endsAt)}</td>
                            <td className="whitespace-nowrap px-3 py-2 font-medium text-text-primary">{formatTimeRemaining(grant.endsAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : resetCreditsState.data?.credits?.length ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between rounded-xl border border-black/10 bg-black/[0.02] px-3 py-2 text-xs text-text-muted dark:border-white/10 dark:bg-white/[0.03]">
                    <span>{resetCreditsState.data.credits.length} reset credit{resetCreditsState.data.credits.length === 1 ? "" : "s"}</span>
                    <span>{resetCreditsState.data.availableCount ?? 0} available</span>
                  </div>
                  <div className="overflow-x-auto rounded-xl border border-black/10 dark:border-white/10">
                    <table className="w-full min-w-[560px] text-left text-sm">
                      <thead className="bg-black/[0.03] text-xs uppercase tracking-wide text-text-muted dark:bg-white/[0.04]">
                        <tr>
                          <th className="px-3 py-2 font-medium">Status</th>
                          <th className="px-3 py-2 font-medium">Granted At</th>
                          <th className="px-3 py-2 font-medium">Expires At</th>
                          <th className="px-3 py-2 font-medium">Remaining</th>
                        </tr>
                      </thead>
                      <tbody>
                        {resetCreditsState.data.credits.map((credit, index) => (
                          <tr key={`${credit.status}-${credit.expiresAt || index}`} className="border-t border-black/5 dark:border-white/5">
                            <td className="px-3 py-2">
                              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                                {credit.status || "unknown"}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-text-muted">{formatCreditDate(credit.grantedAt)}</td>
                            <td className="px-3 py-2 text-text-primary">{formatCreditDate(credit.expiresAt)}</td>
                            <td className="px-3 py-2 font-medium text-text-primary">{formatTimeRemaining(credit.expiresAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border border-black/10 bg-black/[0.02] px-3 py-8 text-center text-sm text-text-muted dark:border-white/10 dark:bg-white/[0.03]">
                  {resetCreditsState.data?.kind === "claude" ? "No limit resets available for this account." : "No reset credit details returned for this account."}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <EditConnectionModal
        isOpen={showEditModal}
        connection={selectedConnection}
        proxyPools={proxyPools}
        onSave={handleUpdateConnection}
        onClose={() => {
          setShowEditModal(false);
          setSelectedConnection(null);
        }}
      />

      {scheduleConnection && (
        <AutoPingScheduleModal
          isOpen={!!scheduleConnection}
          onClose={() => setScheduleConnection(null)}
          connection={scheduleConnection}
          reactive={autoPingConfigs[scheduleConnection.provider]?.connections?.[scheduleConnection.id] === true}
          schedule={autoPingConfigs[scheduleConnection.provider]?.schedules?.[scheduleConnection.id] || null}
          onSave={(result) => handleSaveAutoPing(scheduleConnection.id, scheduleConnection.provider, result)}
        />
      )}
    </div>
  );
}
