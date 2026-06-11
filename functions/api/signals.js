const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*"
};

const levelRank = {
  strong: 4,
  entry: 3,
  watch: 2,
  chase: 1,
  none: 0
};

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const staleAfterSeconds = Number(env.STALE_AFTER_SECONDS || 600);

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({
      ok: false,
      configured: false,
      error: "missing_supabase_env",
      data: [],
      summary: emptySummary()
    });
  }

  let rows = [];
  try {
    rows = await supabaseFetch(env, env.SUPABASE_TABLE_CURRENT || "alpha_metrics_current");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const tableMissing = message.includes("PGRST205") || message.includes("Could not find the table");
    return json({
      ok: false,
      configured: true,
      error: tableMissing ? "table_missing" : "supabase_read_failed",
      detail: message.slice(0, 240),
      data: [],
      summary: emptySummary()
    }, tableMissing ? 200 : 500);
  }
  const filters = {
    q: (url.searchParams.get("q") || "").trim().toLowerCase(),
    level: url.searchParams.get("level") || "all",
    chain: url.searchParams.get("chain") || "all",
    minQuoteVol60: Number(url.searchParams.get("minQuoteVol60") || "0"),
    minTrades60: Number(url.searchParams.get("minTrades60") || "0"),
    hideChasing: url.searchParams.get("hideChasing") === "1",
    sort: url.searchParams.get("sort") || "score"
  };

  const all = rows.map(normalizeMetric);
  const summary = summarize(all, staleAfterSeconds);
  const data = summary.isStale ? [] : all
    .filter((row) => applyFilters(row, filters))
    .sort((a, b) => compareRows(a, b, filters.sort))
    .slice(0, 600);

  return json({
    ok: true,
    configured: true,
    checkedAt: new Date().toISOString(),
    filters,
    summary,
    data
  }, 200, Number(env.SIGNAL_CACHE_SECONDS || 20));
}

async function supabaseFetch(env, table) {
  const url = `${env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/${table}?select=*&order=signal_score.desc&limit=1000`;
  const response = await fetch(url, {
    headers: {
      "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
      "authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "content-type": "application/json"
    }
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`supabase_${table}_failed ${response.status}: ${body.slice(0, 240)}`);
  }
  return response.json();
}

function normalizeMetric(row) {
  return {
    alphaId: row.alpha_id,
    symbol: row.symbol,
    name: row.name,
    chainId: row.chain_id,
    chainName: row.chain_name,
    contractAddress: row.contract_address,
    iconUrl: row.icon_url,
    price: num(row.price),
    percentChange24h: num(row.percent_change_24h),
    marketCap: num(row.market_cap),
    fdv: num(row.fdv),
    liquidity: num(row.liquidity),
    holders: num(row.holders),
    ret15: num(row.ret_15m),
    ret30: num(row.ret_30m),
    ret60: num(row.ret_60m),
    vol15Ratio: num(row.vol15_ratio),
    vol60Ratio: num(row.vol60_ratio),
    trades15Ratio: num(row.trades15_ratio),
    quoteVol60m: num(row.quote_vol_60m),
    trades60m: num(row.trades_60m),
    range60Ratio: num(row.range60_ratio),
    volatility60m: num(row.volatility_60m),
    signalLevel: row.signal_level || "none",
    signalScore: num(row.signal_score) || 0,
    isChasing: Boolean(row.is_chasing),
    reasons: row.reasons || [],
    computedAt: row.computed_at,
    updatedAt: row.updated_at
  };
}

function applyFilters(row, filters) {
  if (filters.q) {
    const haystack = `${row.symbol || ""} ${row.name || ""} ${row.contractAddress || ""}`.toLowerCase();
    if (!haystack.includes(filters.q)) return false;
  }
  if (filters.chain !== "all" && row.chainName !== filters.chain) return false;
  if (filters.level !== "all") {
    if (filters.level === "active") {
      if (!["watch", "entry", "strong"].includes(row.signalLevel)) return false;
    } else if (row.signalLevel !== filters.level) {
      return false;
    }
  }
  if (filters.hideChasing && row.isChasing) return false;
  if ((row.quoteVol60m || 0) < filters.minQuoteVol60) return false;
  if ((row.trades60m || 0) < filters.minTrades60) return false;
  return true;
}

function compareRows(a, b, sort) {
  if (sort === "vol60") return (b.vol60Ratio || 0) - (a.vol60Ratio || 0);
  if (sort === "ret30") return (b.ret30 || 0) - (a.ret30 || 0);
  if (sort === "quote") return (b.quoteVol60m || 0) - (a.quoteVol60m || 0);
  if (sort === "level") return (levelRank[b.signalLevel] || 0) - (levelRank[a.signalLevel] || 0) || (b.signalScore || 0) - (a.signalScore || 0);
  return (b.signalScore || 0) - (a.signalScore || 0);
}

function summarize(rows, staleAfterSeconds = 600) {
  const chains = [...new Set(rows.map((row) => row.chainName).filter(Boolean))].sort();
  const latest = rows
    .map((row) => row.computedAt)
    .filter(Boolean)
    .sort()
    .at(-1) || null;
  const latestMs = latest ? new Date(latest).getTime() : NaN;
  const ageSeconds = Number.isFinite(latestMs) ? Math.max(0, Math.round((Date.now() - latestMs) / 1000)) : null;
  const isStale = ageSeconds === null || ageSeconds > staleAfterSeconds;
  return {
    total: rows.length,
    strong: rows.filter((row) => row.signalLevel === "strong").length,
    entry: rows.filter((row) => row.signalLevel === "entry").length,
    watch: rows.filter((row) => row.signalLevel === "watch").length,
    chase: rows.filter((row) => row.signalLevel === "chase").length,
    activeSignals: rows.filter((row) => ["strong", "entry", "watch"].includes(row.signalLevel)).length,
    chains,
    latestComputedAt: latest,
    ageSeconds,
    staleAfterSeconds,
    isStale
  };
}

function emptySummary() {
  return {
    total: 0,
    strong: 0,
    entry: 0,
    watch: 0,
    chase: 0,
    activeSignals: 0,
    chains: [],
    latestComputedAt: null,
    ageSeconds: null,
    staleAfterSeconds: 600,
    isStale: true
  };
}

function num(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function json(payload, status = 200, maxAge = 0) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...jsonHeaders,
      "cache-control": maxAge ? `public, max-age=${maxAge}` : "no-store"
    }
  });
}
