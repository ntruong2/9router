function entriesByRequests(values = {}) {
  return Object.entries(values)
    .map(([key, value]) => ({ key, ...value }))
    .sort((a, b) => (b.requests || 0) - (a.requests || 0));
}

export function deriveUsageInsights(stats = {}) {
  const totalRequests = stats.totalRequests || 0;
  const totalTokens = (stats.totalPromptTokens || 0) + (stats.totalCompletionTokens || 0);
  const cachedTokens = stats.totalCachedTokens || 0;
  const providers = entriesByRequests(stats.byProvider);
  const models = entriesByRequests(stats.byModel);
  const cacheHitRate = stats.totalPromptTokens ? (cachedTokens / stats.totalPromptTokens) * 100 : 0;
  const topProvider = providers[0] || null;
  const topModel = models[0] || null;

  return {
    totalRequests,
    totalTokens,
    cacheHitRate: Math.round(cacheHitRate * 10) / 10,
    topProvider: topProvider ? { name: topProvider.key, requests: topProvider.requests || 0 } : null,
    topModel: topModel ? { name: topModel.rawModel || topModel.key, requests: topModel.requests || 0 } : null,
    recommendations: [
      ...(cacheHitRate < 10 && totalTokens > 1000 ? [{ type: "cache", message: "Cache hit rate thấp, nên giữ session ổn định để tăng reuse context." }] : []),
      ...(topProvider && totalRequests > 20 ? [{ type: "provider", message: `${topProvider.key} đang nhận nhiều request nhất, hãy kiểm tra tải và quota account.` }] : []),
      ...(totalRequests === 0 ? [{ type: "usage", message: "Chưa có request trong khoảng thời gian này." }] : []),
    ],
  };
}
