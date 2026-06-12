const BINANCE_BASE = "https://www.binance.com";
const WEB3_BASE = "https://web3.binance.com";
const DQUERY_BASE = "https://dquery.sintral.io";
const FIVE_MINUTES = 5 * 60 * 1000;
const DEFAULT_FETCH_TIMEOUT_MS = 12_000;

const WALLET_KLINE_PLATFORMS = {
  "1": "ethereum",
  "56": "bsc",
  "8453": "base",
  CT_501: "solana"
};

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
  const alphaFilter = url.searchParams.get("alphaId");
  const klineLimitOverride = Number.parseInt(url.searchParams.get("klineLimit") || "", 10);
  const klineLimit = clamp(
    Number.isFinite(klineLimitOverride) ? klineLimitOverride : Number.parseInt(env.WALLET_KLINE_LIMIT || "330", 10),
    80,
    330
  );
  const fetchTimeoutMs = clamp(Number.parseInt(env.BINANCE_FETCH_TIMEOUT_MS || "12000", 10), 3000, 25000);

  const tokenPayload = await fetchJson(`${BINANCE_BASE}/bapi/defi/v1/public/wallet-direct/buw/wallet/cex/alpha/all/token/list`, {
    timeoutMs: fetchTimeoutMs
  });
  if (!tokenPayload?.success || !Array.isArray(tokenPayload.data)) {
    return json({ ok: false, error: "token_list_failed", payload: tokenPayload }, 502);
  }

  const activeTokens = tokenPayload.data
    .filter((token) => token.alphaId && token.offline === false && token.fullyDelisted === false)
    .sort((a, b) => String(a.alphaId).localeCompare(String(b.alphaId), undefined, { numeric: true }));

  const selected = alphaFilter
    ? activeTokens.filter((token) => token.alphaId === alphaFilter)
    : activeTokens.slice(offset, offset + limit);

  try {
    await upsertTokens(env, selected);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({
      ok: false,
      error: message.includes("PGRST205") || message.includes("Could not find the table")
        ? "table_missing"
        : "token_upsert_failed",
      detail: message.slice(0, 260),
      hint: "Run supabase/schema.sql in Supabase SQL Editor before refreshing data."
    }, 200);
  }

  const results = [];
  for (const token of selected) {
    try {
      let dynamic = null;
      let dynamicError = "";
      try {
        dynamic = await fetchWalletDynamic(token, fetchTimeoutMs);
      } catch (error) {
        dynamicError = error instanceof Error ? error.message : String(error);
      }

      let klineRows = [];
      let klineError = "";
      try {
        klineRows = await fetchWalletKlines(token, dynamic, klineLimit, fetchTimeoutMs);
      } catch (error) {
        klineError = error instanceof Error ? error.message : String(error);
      }

      if (klineRows.length) {
        await upsertKlines(env, token.alphaId, klineRows);
      }

      const storedKlines = klineRows;
      const metrics = computeMetrics(token, storedKlines, dynamic);
      if (metrics) {
        await upsertCurrentMetric(env, metrics);
        if (["watch", "entry", "strong", "chase"].includes(metrics.signal_level)) {
          await insertSignalSnapshot(env, metrics);
        }
      }

      results.push({
        alphaId: token.alphaId,
        symbol: token.symbol,
        source: "web3_wallet",
        platform: WALLET_KLINE_PLATFORMS[token.chainId] || null,
        fetchedKlines: klineRows.length,
        storedKlines: storedKlines.length,
        dynamic: Boolean(dynamic),
        signal: metrics?.signal_level || "none",
        dynamicError: dynamicError ? dynamicError.slice(0, 180) : undefined,
        klineError: klineError ? klineError.slice(0, 180) : undefined
      });
    } catch (error) {
      results.push({
        alphaId: token.alphaId,
        symbol: token.symbol,
        source: "web3_wallet",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const metricsWritten = results.filter((item) => item.signal && !item.error).length;
  const errors = results.filter((item) => item.error);

  return json({
    ok: true,
    source: "binance_web3_wallet_dynamic_and_dquery_kline",
    checkedAt: started.toISOString(),
    offset,
    limit,
    klineLimit,
    activeTotal: activeTokens.length,
    processed: selected.length,
    metricsWritten,
    errors,
    results
  });
}

async function fetchJson(url, options = {}) {
  const { timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, retries = 2, ...fetchOptions } = options;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("timeout"), timeoutMs);
    try {
      const response = await fetch(url, {
        ...fetchOptions,
        signal: controller.signal,
        headers: {
          accept: "application/json,text/plain,*/*",
          "user-agent": "Mozilla/5.0 AlphaRightsideMonitor/0.2",
          ...(fetchOptions.headers || {})
        }
      });
      if (!response.ok) {
        throw new Error(`fetch_failed ${response.status} ${url}`);
      }
      return response.json();
    } catch (error) {
      lastError = error;
      if (attempt >= retries) break;
      await wait(350 * (attempt + 1));
    } finally {
      clearTimeout(timeout);
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`fetch_failed ${detail} ${url}`);
}

async function fetchWalletDynamic(token, fetchTimeoutMs) {
  if (!token.chainId || !token.contractAddress) return null;
  const params = new URLSearchParams({
    chainId: token.chainId,
    contractAddress: token.contractAddress
  });
  const payload = await fetchJson(`${WEB3_BASE}/bapi/defi/v4/public/wallet-direct/buw/wallet/market/token/dynamic/info/ai?${params.toString()}`, {
    timeoutMs: fetchTimeoutMs,
    retries: 1
  });
  return payload?.data && typeof payload.data === "object" ? payload.data : null;
}

async function fetchWalletKlines(token, dynamic, limit, fetchTimeoutMs) {
  const platform = WALLET_KLINE_PLATFORMS[token.chainId];
  if (!platform || !token.contractAddress) return [];

  const endTime = floorToInterval(Date.now(), FIVE_MINUTES);
  const params = new URLSearchParams({
    platform,
    address: token.contractAddress,
    interval: "5min",
    to: String(Date.now()),
    limit: String(limit)
  });
  const payload = await fetchJson(`${DQUERY_BASE}/u-kline/v1/k-line/candles?${params.toString()}`, {
    timeoutMs: fetchTimeoutMs,
    retries: 1
  });
  const status = payload?.status || {};
  if (String(status.error_code) !== "0" || !Array.isArray(payload.data)) return [];

  const rawRows = payload.data
    .map(parseWalletKlineRow)
    .filter(Boolean)
    .sort((a, b) => a.open_time - b.open_time);

  return densifyWalletKlines(rawRows, limit, endTime, firstNumber(dynamic?.price, dynamic?.aggPrice, token.price));
}

function parseWalletKlineRow(row) {
  if (!Array.isArray(row) || row.length < 7) return null;
  const openTime = Number(row[5]);
  const open = toNumberOrNull(row[0]);
  const high = toNumberOrNull(row[1]);
  const low = toNumberOrNull(row[2]);
  const close = toNumberOrNull(row[3]);
  if (![openTime, open, high, low, close].every(Number.isFinite)) return null;
  return {
    open_time: floorToInterval(openTime, FIVE_MINUTES),
    open,
    high,
    low,
    close,
    base_volume: 0,
    quote_volume: toNumber(row[4]),
    trade_count: Math.round(toNumber(row[6])),
    taker_buy_base_volume: 0,
    taker_buy_quote_volume: 0
  };
}

function densifyWalletKlines(rawRows, limit, endTime, fallbackPrice) {
  if (!rawRows.length && !Number.isFinite(fallbackPrice)) return [];

  const startTime = endTime - (limit - 1) * FIVE_MINUTES;
  const rowsByTime = new Map();
  let previousClose = Number.isFinite(fallbackPrice) ? fallbackPrice : null;
  for (const row of rawRows) {
    if (row.open_time < startTime && Number.isFinite(row.close)) {
      previousClose = row.close;
      continue;
    }
    rowsByTime.set(row.open_time, row);
  }

  if (!Number.isFinite(previousClose) && rawRows[0]?.close) {
    previousClose = rawRows[0].close;
  }

  const dense = [];
  for (let openTime = startTime; openTime <= endTime; openTime += FIVE_MINUTES) {
    const raw = rowsByTime.get(openTime);
    if (raw) {
      previousClose = raw.close;
      dense.push({
        ...raw,
        open_time: openTime,
        open_time_at: new Date(openTime).toISOString()
      });
      continue;
    }
    if (!Number.isFinite(previousClose)) continue;
    dense.push({
      open_time: openTime,
      open_time_at: new Date(openTime).toISOString(),
      open: previousClose,
      high: previousClose,
      low: previousClose,
      close: previousClose,
      base_volume: 0,
      quote_volume: 0,
      trade_count: 0,
      taker_buy_base_volume: 0,
      taker_buy_quote_volume: 0
    });
  }
  return dense;
}

async function supabaseFetch(env, table, query = "", options = {}) {
  const url = `${env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/${table}${query}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
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
  const body = await response.text();
  return body ? JSON.parse(body) : null;
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
      headers: { prefer: "resolution=merge-duplicates" },
      body: JSON.stringify(rows)
    }
  );
}

async function upsertKlines(env, alphaId, rows) {
  const table = env.SUPABASE_TABLE_KLINES || "alpha_klines_5m";
  const payload = rows.map((row) => ({ alpha_id: alphaId, ...row }));
  for (let index = 0; index < payload.length; index += 120) {
    await supabaseFetch(env, table, "?on_conflict=alpha_id,open_time", {
      method: "POST",
      headers: { prefer: "resolution=merge-duplicates" },
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
    headers: { prefer: "resolution=merge-duplicates" },
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

function computeMetrics(token, rows, dynamic) {
  const dyn = dynamic || {};
  const last = rows?.at(-1) || null;
  const now = new Date();
  const close = firstNumber(dyn.price, dyn.aggPrice, last?.close, token.price);
  if (!Number.isFinite(close)) return null;

  const ret15 = rows?.length >= 4 ? pct(close, rows.at(-4)?.close) : null;
  const ret30 = rows?.length >= 7 ? pct(close, rows.at(-7)?.close) : null;
  const ret60FromKline = rows?.length >= 13 ? pct(close, rows.at(-13)?.close) : null;
  const ret60 = firstNumber(dyn.percentChange1h, ret60FromKline);
  const quoteVol5 = firstNumber(dyn.volume5m, rows?.length ? sum(rows.slice(-1), "quote_volume") : null);
  const quoteVol15 = rows?.length >= 3 ? sum(rows.slice(-3), "quote_volume") : null;
  const quoteVol60FromKline = rows?.length >= 12 ? sum(rows.slice(-12), "quote_volume") : null;
  const quoteVol60 = firstNumber(dyn.volume1h, quoteVol60FromKline);
  const trades15 = rows?.length >= 3 ? sum(rows.slice(-3), "trade_count") : null;
  const trades60FromKline = rows?.length >= 12 ? sum(rows.slice(-12), "trade_count") : null;
  const trades60 = firstNumber(dyn.count1h, trades60FromKline);

  const hasBaseline = rows?.length >= 80;
  const vol5Baseline = hasBaseline ? median(rollingSums(rows, "quote_volume", 1, 288, 1)) : null;
  const vol15Baseline = hasBaseline ? median(rollingSums(rows, "quote_volume", 3, 288, 1)) : null;
  const vol60Baseline = hasBaseline ? median(rollingSums(rows, "quote_volume", 12, 288, 1)) : null;
  const trades15Baseline = hasBaseline ? median(rollingSums(rows, "trade_count", 3, 288, 1)) : null;
  const range60 = rows?.length >= 12 ? rangePct(rows.slice(-12)) : null;
  const range60Baseline = hasBaseline ? median(rollingRanges(rows, 12, 288, 1)) : null;
  const volatility60 = rows?.length >= 13 ? volatilityPct(rows.slice(-13)) : null;

  const vol5Ratio = safeRatio(quoteVol5, vol5Baseline);
  const vol15Ratio = safeRatio(quoteVol15, vol15Baseline);
  const vol60Ratio = safeRatio(quoteVol60, vol60Baseline);
  const trades15Ratio = safeRatio(trades15, trades15Baseline);
  const range60Ratio = safeRatio(range60, range60Baseline);

  const isChasing = (ret60 ?? 0) >= 8 || (ret15 ?? 0) >= 8;
  const walletQuality = (quoteVol60 ?? 0) >= 1000 && (trades60 ?? 0) >= 10;
  const mainEntry =
    (vol60Ratio ?? 0) >= 5 &&
    (ret30 ?? 0) >= 2 &&
    walletQuality &&
    (ret60 ?? 0) < 8;
  const shortBurst =
    (vol5Ratio ?? 0) >= 10 &&
    (quoteVol5 ?? 0) >= 500 &&
    (ret15 ?? 0) >= 0.5 &&
    (ret60 ?? 0) < 8;
  const fifteenMinuteAcceleration =
    (vol15Ratio ?? 0) >= 5 &&
    (trades15 ?? 0) >= 5 &&
    (ret15 ?? 0) >= 1 &&
    (ret60 ?? 0) < 8;

  const reasons = [];
  if ((vol60Ratio ?? 0) >= 15) reasons.push("60m放量>=15x");
  else if ((vol60Ratio ?? 0) >= 8) reasons.push("60m放量>=8x");
  else if ((vol60Ratio ?? 0) >= 5) reasons.push("60m放量>=5x");
  if ((ret30 ?? 0) >= 3) reasons.push("30m转强>=3%");
  else if ((ret30 ?? 0) >= 2) reasons.push("30m转强>=2%");
  else if ((ret30 ?? 0) >= 1) reasons.push("30m转强>=1%");
  if ((ret15 ?? 0) >= 3) reasons.push("15m转强>=3%");
  if ((vol15Ratio ?? 0) >= 5) reasons.push("15m放量>=5x");
  if ((vol5Ratio ?? 0) >= 10) reasons.push("5m放量>=10x");
  if ((quoteVol60 ?? 0) >= 1000) reasons.push("60m额>=1000");
  if ((trades60 ?? 0) >= 10) reasons.push("60m笔数>=10");
  if ((trades15 ?? 0) >= 5) reasons.push("15m交易>=5笔");
  if (isChasing) reasons.push("追高风险");
  if (!WALLET_KLINE_PLATFORMS[token.chainId]) reasons.push("仅钱包动态");

  let signalLevel = "none";
  if (isChasing && ((ret15 ?? 0) >= 5 || (ret30 ?? 0) >= 5 || (vol60Ratio ?? 0) >= 5)) {
    signalLevel = "chase";
  } else if (mainEntry && ((ret30 ?? 0) >= 3 || (ret15 ?? 0) >= 3 || (vol60Ratio ?? 0) >= 8)) {
    signalLevel = "strong";
  } else if (mainEntry) {
    signalLevel = "entry";
  } else if (((vol60Ratio ?? 0) >= 5 && (ret30 ?? 0) >= 1 && (ret60 ?? 0) < 8) || shortBurst || fifteenMinuteAcceleration) {
    signalLevel = "watch";
  }

  const signalScore = scoreSignal({
    signalLevel,
    ret15,
    ret30,
    ret60,
    vol15Ratio,
    vol60Ratio,
    trades15,
    quoteVol60,
    trades60,
    range60Ratio,
    isChasing
  });

  return {
    alpha_id: token.alphaId,
    computed_at: now.toISOString(),
    kline_open_time: last?.open_time || null,
    symbol: token.symbol,
    name: token.name || null,
    chain_id: token.chainId || null,
    chain_name: token.chainName || null,
    contract_address: token.contractAddress || null,
    icon_url: token.iconUrl || null,
    price: round(close, 12),
    percent_change_24h: round(firstNumber(dyn.percentChange24h, token.percentChange24h), 6),
    market_cap: round(firstNumber(dyn.marketCap, token.marketCap), 2),
    fdv: round(firstNumber(dyn.fdv, token.fdv), 2),
    liquidity: round(firstNumber(dyn.liquidity, token.liquidity), 2),
    holders: Math.round(firstNumber(dyn.holders, token.holders) ?? 0) || null,
    ret_15m: round(ret15),
    ret_30m: round(ret30),
    ret_60m: round(ret60),
    vol15_ratio: round(vol15Ratio),
    vol60_ratio: round(vol60Ratio),
    trades15_ratio: round(trades15Ratio),
    quote_vol_60m: round(quoteVol60, 2),
    trades_60m: Math.round(trades60 ?? 0),
    range60_ratio: round(range60Ratio),
    volatility_60m: round(volatility60),
    signal_level: signalLevel,
    signal_score: round(signalScore),
    is_chasing: isChasing,
    reasons
  };
}

function scoreSignal(values) {
  const levelBase = { strong: 78, entry: 62, watch: 42, chase: 18, none: 0 }[values.signalLevel] || 0;
  const volume = Math.min(18, (values.vol60Ratio || 0) * 2);
  const momentum = Math.min(18, Math.max(0, values.ret30 || 0) * 3 + Math.max(0, values.ret15 || 0) * 1.2);
  const shortAccel = Math.min(10, (values.vol15Ratio || 0) * 1.2 + Math.min(5, (values.trades15 || 0) / 2));
  const quality = Math.min(12, Math.log10(Math.max(1, values.quoteVol60 || 0)) * 1.8 + Math.log10(Math.max(1, values.trades60 || 0)) * 1.8);
  const range = Math.min(6, (values.range60Ratio || 0) * 1.5);
  const chasePenalty = values.isChasing ? 24 : 0;
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

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function floorToInterval(value, interval) {
  return Math.floor(Number(value) / interval) * interval;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function firstNumber(...values) {
  for (const value of values) {
    const number = toNumberOrNull(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
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
