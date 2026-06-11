const BINANCE_BASE = "https://www.binance.com";
const FIVE_MINUTES = 5 * 60 * 1000;

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "cache-control": "no-store"
};

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const started = new Date();
  const suppliedKey = url.searchParams.get("key") || "";

  if (env.CRON_SECRET && suppliedKey !== env.CRON_SECRET) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({ ok: false, error: "missing_supabase_env" }, 500);
  }

  const offset = Math.max(0, Number.parseInt(url.searchParams.get("offset") || "0", 10));
  const limit = Math.min(
    160,
    Math.max(1, Number.parseInt(url.searchParams.get("limit") || env.REFRESH_BATCH_LIMIT || "100", 10))
  );
  const bootstrap = url.searchParams.get("bootstrap") === "1";
  const alphaFilter = url.searchParams.get("alphaId");
  const klineLimitBootstrap = Number.parseInt(env.KLINE_LIMIT_BOOTSTRAP || "320", 10);
  const klineLimitIncremental = Number.parseInt(env.KLINE_LIMIT_INCREMENTAL || "24", 10);

  const tokenPayload = await fetchJson(`${BINANCE_BASE}/bapi/defi/v1/public/wallet-direct/buw/wallet/cex/alpha/all/token/list`);
  if (!tokenPayload?.success || !Array.isArray(tokenPayload.data)) {
    return json({ ok: false, error: "token_list_failed", payload: tokenPayload }, 502);
  }

  const activeTokens = tokenPayload.data
    .filter((token) => token.alphaId && token.offline === false && token.fullyDelisted === false)
    .sort((a, b) => String(a.alphaId).localeCompare(String(b.alphaId), undefined, { numeric: true }));

  const selected = alphaFilter
    ? activeTokens.filter((token) => token.alphaId === alphaFilter)
    : activeTokens.slice(offset, offset + limit);

  await upsertTokens(env, selected);

  const results = [];
  for (const token of selected) {
    try {
      const lastOpenTime = bootstrap ? null : await getLastOpenTime(env, token.alphaId);
      const klineRows = await fetchKlines(token.alphaId, lastOpenTime, lastOpenTime ? klineLimitIncremental : klineLimitBootstrap);
      if (klineRows.length) {
        await upsertKlines(env, token.alphaId, klineRows);
      }

      const storedKlines = await getStoredKlines(env, token.alphaId, 330);
      const metrics = computeMetrics(token, storedKlines);
      if (metrics) {
        await upsertCurrentMetric(env, metrics);
        if (["watch", "entry", "strong", "chase"].includes(metrics.signal_level)) {
          await insertSignalSnapshot(env, metrics);
        }
      }

      results.push({
        alphaId: token.alphaId,
        symbol: token.symbol,
        fetchedKlines: klineRows.length,
        storedKlines: storedKlines.length,
        signal: metrics?.signal_level || "none"
      });
    } catch (error) {
      results.push({
        alphaId: token.alphaId,
        symbol: token.symbol,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const metricsWritten = results.filter((item) => item.signal && !item.error).length;
  const errors = results.filter((item) => item.error);

  return json({
    ok: true,
    checkedAt: started.toISOString(),
    offset,
    limit,
    activeTotal: activeTokens.length,
    processed: selected.length,
    metricsWritten,
    errors,
    results
  });
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "accept": "application/json,text/plain,*/*",
      "user-agent": "Mozilla/5.0 AlphaRightsideMonitor/0.1",
      ...(options.headers || {})
    }
  });
  if (!response.ok) {
    throw new Error(`fetch_failed ${response.status} ${url}`);
  }
  return response.json();
}

async function fetchKlines(alphaId, lastOpenTime, limit) {
  const params = new URLSearchParams({
    symbol: `${alphaId}USDT`,
    interval: "5m",
    limit: String(limit)
  });
  if (lastOpenTime) {
    params.set("startTime", String(Number(lastOpenTime) + FIVE_MINUTES));
  }
  const payload = await fetchJson(`${BINANCE_BASE}/bapi/defi/v1/public/alpha-trade/klines?${params.toString()}`);
  if (!payload?.success || !Array.isArray(payload.data)) {
    return [];
  }
  return payload.data.map((row) => ({
    open_time: Number(row[0]),
    open_time_at: new Date(Number(row[0])).toISOString(),
    open: toNumber(row[1]),
    high: toNumber(row[2]),
    low: toNumber(row[3]),
    close: toNumber(row[4]),
    base_volume: toNumber(row[5]),
    quote_volume: toNumber(row[7]),
    trade_count: Number(row[8] || 0),
    taker_buy_base_volume: toNumber(row[9]),
    taker_buy_quote_volume: toNumber(row[10])
  }));
}

async function supabaseFetch(env, table, query = "", options = {}) {
  const url = `${env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/${table}${query}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
      "authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`supabase_${table}_failed ${response.status}: ${body.slice(0, 240)}`);
  }
  if (response.status === 204) {
    return null;
  }
  return response.json();
}

async function upsertTokens(env, tokens) {
  if (!tokens.length) return;
  const rows = tokens.map((token) => ({
    alpha_id: token.alphaId,
    token_id: token.tokenId || null,
    symbol: token.symbol,
    name: token.name || null,
    chain_id: token.chainId || null,
    chain_name: token.chainName || null,
    contract_address: token.contractAddress || null,
    icon_url: token.iconUrl || null,
    price: toNumberOrNull(token.price),
    percent_change_24h: toNumberOrNull(token.percentChange24h),
    volume_24h: toNumberOrNull(token.volume24h),
    market_cap: toNumberOrNull(token.marketCap),
    fdv: toNumberOrNull(token.fdv),
    liquidity: toNumberOrNull(token.liquidity),
    holders: token.holders ? Number(token.holders) : null,
    offline: Boolean(token.offline),
    fully_delisted: Boolean(token.fullyDelisted),
    raw: token,
    updated_at: new Date().toISOString()
  }));
  await supabaseFetch(
    env,
    env.SUPABASE_TABLE_TOKENS || "alpha_tokens",
    "?on_conflict=alpha_id",
    {
      method: "POST",
      headers: { "prefer": "resolution=merge-duplicates" },
      body: JSON.stringify(rows)
    }
  );
}

async function getLastOpenTime(env, alphaId) {
  const table = env.SUPABASE_TABLE_KLINES || "alpha_klines_5m";
  const rows = await supabaseFetch(
    env,
    table,
    `?select=open_time&alpha_id=eq.${encodeURIComponent(alphaId)}&order=open_time.desc&limit=1`
  );
  return rows?.[0]?.open_time || null;
}

async function upsertKlines(env, alphaId, rows) {
  const table = env.SUPABASE_TABLE_KLINES || "alpha_klines_5m";
  const payload = rows.map((row) => ({ alpha_id: alphaId, ...row }));
  for (let index = 0; index < payload.length; index += 120) {
    await supabaseFetch(env, table, "?on_conflict=alpha_id,open_time", {
      method: "POST",
      headers: { "prefer": "resolution=merge-duplicates" },
      body: JSON.stringify(payload.slice(index, index + 120))
    });
  }
}

async function getStoredKlines(env, alphaId, limit) {
  const table = env.SUPABASE_TABLE_KLINES || "alpha_klines_5m";
  const rows = await supabaseFetch(
    env,
    table,
    `?select=*&alpha_id=eq.${encodeURIComponent(alphaId)}&order=open_time.desc&limit=${limit}`
  );
  return (rows || []).reverse().map((row) => ({
    ...row,
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    quote_volume: Number(row.quote_volume),
    trade_count: Number(row.trade_count),
    taker_buy_quote_volume: Number(row.taker_buy_quote_volume)
  }));
}

async function upsertCurrentMetric(env, metrics) {
  await supabaseFetch(env, env.SUPABASE_TABLE_CURRENT || "alpha_metrics_current", "?on_conflict=alpha_id", {
    method: "POST",
    headers: { "prefer": "resolution=merge-duplicates" },
    body: JSON.stringify([{ ...metrics, updated_at: new Date().toISOString() }])
  });
}

async function insertSignalSnapshot(env, metrics) {
  const snapshot = {
    alpha_id: metrics.alpha_id,
    computed_at: metrics.computed_at,
    symbol: metrics.symbol,
    name: metrics.name,
    chain_name: metrics.chain_name,
    contract_address: metrics.contract_address,
    price: metrics.price,
    signal_level: metrics.signal_level,
    signal_score: metrics.signal_score,
    ret_15m: metrics.ret_15m,
    ret_30m: metrics.ret_30m,
    ret_60m: metrics.ret_60m,
    vol15_ratio: metrics.vol15_ratio,
    vol60_ratio: metrics.vol60_ratio,
    trades15_ratio: metrics.trades15_ratio,
    quote_vol_60m: metrics.quote_vol_60m,
    trades_60m: metrics.trades_60m,
    range60_ratio: metrics.range60_ratio,
    reasons: metrics.reasons
  };
  await supabaseFetch(env, env.SUPABASE_TABLE_SNAPSHOTS || "alpha_signal_snapshots", "", {
    method: "POST",
    body: JSON.stringify([snapshot])
  });
}

function computeMetrics(token, rows) {
  if (!rows || rows.length < 80) {
    return null;
  }
  const last = rows.at(-1);
  const now = new Date();
  const close = last.close;
  const ret15 = pct(close, rows.at(-4)?.close);
  const ret30 = pct(close, rows.at(-7)?.close);
  const ret60 = pct(close, rows.at(-13)?.close);
  const quoteVol15 = sum(rows.slice(-3), "quote_volume");
  const quoteVol60 = sum(rows.slice(-12), "quote_volume");
  const trades15 = sum(rows.slice(-3), "trade_count");
  const trades60 = sum(rows.slice(-12), "trade_count");

  const vol15Baseline = median(rollingSums(rows, "quote_volume", 3, 288, 1));
  const vol60Baseline = median(rollingSums(rows, "quote_volume", 12, 288, 1));
  const trades15Baseline = median(rollingSums(rows, "trade_count", 3, 288, 1));
  const range60 = rangePct(rows.slice(-12));
  const range60Baseline = median(rollingRanges(rows, 12, 288, 1));
  const volatility60 = volatilityPct(rows.slice(-13));

  const vol15Ratio = safeRatio(quoteVol15, vol15Baseline);
  const vol60Ratio = safeRatio(quoteVol60, vol60Baseline);
  const trades15Ratio = safeRatio(trades15, trades15Baseline);
  const range60Ratio = safeRatio(range60, range60Baseline);

  const isChasing = (ret60 ?? 0) >= 10 || (ret15 ?? 0) >= 8;
  const quality = quoteVol60 >= 10000 && trades60 >= 150;
  const reasons = [];
  if ((vol60Ratio ?? 0) >= 15) reasons.push("60m成交额>=15x");
  else if ((vol60Ratio ?? 0) >= 10) reasons.push("60m成交额>=10x");
  else if ((vol60Ratio ?? 0) >= 8) reasons.push("60m成交额>=8x");
  if ((ret30 ?? 0) >= 2) reasons.push("30m转强>=2%");
  else if ((ret30 ?? 0) >= 1) reasons.push("30m转强>=1%");
  if ((vol15Ratio ?? 0) >= 5) reasons.push("15m成交加速>=5x");
  if ((trades15Ratio ?? 0) >= 3) reasons.push("15m交易数>=3x");
  if (quality) reasons.push("成交质量达标");
  if (isChasing) reasons.push("追高风险");

  let signalLevel = "none";
  if (isChasing && ((vol60Ratio ?? 0) >= 8 || (ret15 ?? 0) >= 5)) {
    signalLevel = "chase";
  } else if ((vol60Ratio ?? 0) >= 15 && (ret30 ?? 0) >= 2 && (ret60 ?? 0) < 8 && quality) {
    signalLevel = "strong";
  } else if ((vol60Ratio ?? 0) >= 10 && (ret30 ?? 0) >= 2 && (ret60 ?? 0) < 8 && quality) {
    signalLevel = "entry";
  } else if ((vol60Ratio ?? 0) >= 8 && (ret30 ?? 0) >= 1 && (ret60 ?? 0) < 8) {
    signalLevel = "watch";
  }

  const signalScore = scoreSignal({
    signalLevel,
    ret15,
    ret30,
    ret60,
    vol15Ratio,
    vol60Ratio,
    trades15Ratio,
    quoteVol60,
    trades60,
    range60Ratio,
    isChasing
  });

  return {
    alpha_id: token.alphaId,
    computed_at: now.toISOString(),
    kline_open_time: last.open_time,
    symbol: token.symbol,
    name: token.name || null,
    chain_id: token.chainId || null,
    chain_name: token.chainName || null,
    contract_address: token.contractAddress || null,
    icon_url: token.iconUrl || null,
    price: toNumberOrNull(last.close),
    percent_change_24h: toNumberOrNull(token.percentChange24h),
    market_cap: toNumberOrNull(token.marketCap),
    fdv: toNumberOrNull(token.fdv),
    liquidity: toNumberOrNull(token.liquidity),
    holders: token.holders ? Number(token.holders) : null,
    ret_15m: round(ret15),
    ret_30m: round(ret30),
    ret_60m: round(ret60),
    vol15_ratio: round(vol15Ratio),
    vol60_ratio: round(vol60Ratio),
    trades15_ratio: round(trades15Ratio),
    quote_vol_60m: round(quoteVol60, 2),
    trades_60m: Math.round(trades60),
    range60_ratio: round(range60Ratio),
    volatility_60m: round(volatility60),
    signal_level: signalLevel,
    signal_score: round(signalScore),
    is_chasing: isChasing,
    reasons
  };
}

function scoreSignal(values) {
  const levelBase = { strong: 80, entry: 65, watch: 45, chase: 20, none: 0 }[values.signalLevel] || 0;
  const volume = Math.min(20, (values.vol60Ratio || 0) * 1.1);
  const momentum = Math.min(15, Math.max(0, values.ret30 || 0) * 2.5);
  const shortAccel = Math.min(10, (values.vol15Ratio || 0) * 0.8 + (values.trades15Ratio || 0));
  const quality = Math.min(10, Math.log10(Math.max(1, values.quoteVol60 || 0)) + Math.log10(Math.max(1, values.trades60 || 0)));
  const range = Math.min(8, (values.range60Ratio || 0) * 2);
  const chasePenalty = values.isChasing ? 25 : 0;
  return Math.max(0, Math.min(100, levelBase + volume + momentum + shortAccel + quality + range - chasePenalty));
}

function rollingSums(rows, key, window, maxWindows, skipLatestWindows) {
  const end = rows.length - skipLatestWindows;
  const start = Math.max(window, end - maxWindows);
  const values = [];
  for (let index = start; index <= end; index += 1) {
    values.push(sum(rows.slice(index - window, index), key));
  }
  return values.filter((value) => Number.isFinite(value) && value > 0);
}

function rollingRanges(rows, window, maxWindows, skipLatestWindows) {
  const end = rows.length - skipLatestWindows;
  const start = Math.max(window, end - maxWindows);
  const values = [];
  for (let index = start; index <= end; index += 1) {
    values.push(rangePct(rows.slice(index - window, index)));
  }
  return values.filter((value) => Number.isFinite(value) && value > 0);
}

function rangePct(windowRows) {
  if (!windowRows.length) return null;
  const high = Math.max(...windowRows.map((row) => row.high));
  const low = Math.min(...windowRows.map((row) => row.low).filter((value) => value > 0));
  return low ? (high / low - 1) * 100 : null;
}

function volatilityPct(windowRows) {
  if (windowRows.length < 3) return null;
  const returns = [];
  for (let index = 1; index < windowRows.length; index += 1) {
    const previous = windowRows[index - 1].close;
    if (previous) returns.push(windowRows[index].close / previous - 1);
  }
  if (!returns.length) return null;
  const average = returns.reduce((acc, value) => acc + value, 0) / returns.length;
  const variance = returns.reduce((acc, value) => acc + (value - average) ** 2, 0) / returns.length;
  return Math.sqrt(variance) * Math.sqrt(12) * 100;
}

function sum(rows, key) {
  return rows.reduce((total, row) => total + Number(row?.[key] || 0), 0);
}

function median(values) {
  const clean = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!clean.length) return null;
  const middle = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[middle] : (clean[middle - 1] + clean[middle]) / 2;
}

function pct(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return (current / previous - 1) * 100;
}

function safeRatio(value, baseline) {
  if (!Number.isFinite(value) || !Number.isFinite(baseline) || baseline === 0) return null;
  return value / baseline;
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function toNumberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: jsonHeaders
  });
}
