import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const outputsDir = path.resolve(root, "../analysis_outputs");
const tokenSnapshot = await readLatestCsv("binance_alpha_active_rolling60m_snapshot_");
const sampleSnapshot = await readLatestCsv("binance_alpha_pump_samples_");

loadEnvFile(process.argv.includes("--env-file") ? process.argv[process.argv.indexOf("--env-file") + 1] : "");

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRole) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
}

const tokenRows = parseCsv(tokenSnapshot.content);
const sampleRows = parseCsv(sampleSnapshot.content);
const activeTokens = tokenRows.filter((row) => row.alphaId && bool(row.offline) === false && bool(row.fullyDelisted) === false);
const latestSampleByAlphaId = latestBy(sampleRows, "alphaId", "open_time_utc");
const computedAt = new Date().toISOString();

const tokenPayload = activeTokens.map((token) => ({
  alpha_id: token.alphaId,
  token_id: emptyToNull(token.tokenId),
  symbol: token.symbol,
  name: emptyToNull(token.name),
  chain_id: emptyToNull(token.chainId),
  chain_name: emptyToNull(token.chainName),
  contract_address: emptyToNull(token.contractAddress),
  icon_url: emptyToNull(token.iconUrl),
  price: numOrNull(token.price),
  percent_change_24h: numOrNull(token.percentChange24h),
  volume_24h: numOrNull(token.volume24h),
  market_cap: numOrNull(token.marketCap),
  fdv: numOrNull(token.fdv),
  liquidity: numOrNull(token.liquidity),
  holders: intOrNull(token.holders),
  offline: bool(token.offline),
  fully_delisted: bool(token.fullyDelisted),
  raw: token,
  updated_at: computedAt
}));

await upsert("alpha_tokens", tokenPayload, "alpha_id");

const metricPayload = activeTokens
  .map((token) => buildMetric(token, latestSampleByAlphaId.get(token.alphaId), computedAt))
  .filter(Boolean);

await upsert("alpha_metrics_current", metricPayload, "alpha_id");

const signalPayload = metricPayload
  .filter((row) => ["watch", "entry", "strong", "chase"].includes(row.signal_level))
  .map((row) => ({
    alpha_id: row.alpha_id,
    computed_at: row.computed_at,
    symbol: row.symbol,
    name: row.name,
    chain_name: row.chain_name,
    contract_address: row.contract_address,
    price: row.price,
    signal_level: row.signal_level,
    signal_score: row.signal_score,
    ret_15m: row.ret_15m,
    ret_30m: row.ret_30m,
    ret_60m: row.ret_60m,
    vol15_ratio: row.vol15_ratio,
    vol60_ratio: row.vol60_ratio,
    trades15_ratio: row.trades15_ratio,
    quote_vol_60m: row.quote_vol_60m,
    trades_60m: row.trades_60m,
    range60_ratio: row.range60_ratio,
    reasons: row.reasons
  }));

if (signalPayload.length) {
  await insert("alpha_signal_snapshots", signalPayload);
}

console.log(JSON.stringify({
  ok: true,
  tokenSnapshot: tokenSnapshot.file,
  sampleSnapshot: sampleSnapshot.file,
  tokens: tokenPayload.length,
  metrics: metricPayload.length,
  signals: signalPayload.length,
  computedAt
}, null, 2));

async function readLatestCsv(prefix) {
  const files = (await readdir(outputsDir))
    .filter((file) => file.startsWith(prefix) && file.endsWith(".csv"))
    .sort();
  if (!files.length) {
    throw new Error(`No CSV found for ${prefix}`);
  }
  const file = files.at(-1);
  return {
    file,
    content: await readFile(path.join(outputsDir, file), "utf8")
  };
}

function buildMetric(token, sample, computedAt) {
  const ret15 = sample ? numOrNull(sample.ret_15m_pct) : null;
  const ret30 = sample ? numOrNull(sample.ret_30m_pct) : null;
  const ret60 = sample ? numOrNull(sample.ret_60m_pct) : numOrNull(token.rolling_60m_change_pct);
  const vol15Ratio = sample ? numOrNull(sample.vol15_ratio) : null;
  const vol60Ratio = sample ? numOrNull(sample.vol60_ratio) : numOrNull(token.quote_volume_1h_vs_prev);
  const trades15Ratio = sample ? numOrNull(sample.trades15_ratio) : null;
  const quoteVol60 = sample ? numOrNull(sample.quote_vol_60m) : numOrNull(token.rolling_60m_quote_volume);
  const trades60 = sample ? intOrNull(sample.trades_60m) : intOrNull(token.rolling_60m_trade_count);
  const range60Ratio = sample ? numOrNull(sample.range60_ratio) : null;
  const volatility60 = sample ? numOrNull(sample.volatility_60m_pct) : null;
  const price = sample ? numOrNull(sample.close) : numOrNull(token.price);
  const klineTime = sample?.open_time_utc ? Date.parse(sample.open_time_utc) : Number(token.kline_1h_open_time || token.rolling_60m_latest_open_utc || 0);
  const signal = classifySignal({ ret15, ret30, ret60, vol15Ratio, vol60Ratio, trades15Ratio, quoteVol60, trades60, range60Ratio });

  return {
    alpha_id: token.alphaId,
    computed_at: computedAt,
    kline_open_time: Number.isFinite(klineTime) && klineTime > 0 ? klineTime : null,
    symbol: token.symbol,
    name: emptyToNull(token.name),
    chain_id: emptyToNull(token.chainId),
    chain_name: emptyToNull(token.chainName),
    contract_address: emptyToNull(token.contractAddress),
    icon_url: emptyToNull(token.iconUrl),
    price,
    percent_change_24h: numOrNull(token.percentChange24h),
    market_cap: numOrNull(token.marketCap),
    fdv: numOrNull(token.fdv),
    liquidity: numOrNull(token.liquidity),
    holders: intOrNull(token.holders),
    ret_15m: round(ret15),
    ret_30m: round(ret30),
    ret_60m: round(ret60),
    vol15_ratio: round(vol15Ratio),
    vol60_ratio: round(vol60Ratio),
    trades15_ratio: round(trades15Ratio),
    quote_vol_60m: round(quoteVol60, 2),
    trades_60m: trades60,
    range60_ratio: round(range60Ratio),
    volatility_60m: round(volatility60),
    signal_level: signal.level,
    signal_score: round(signal.score),
    is_chasing: signal.isChasing,
    reasons: signal.reasons,
    updated_at: computedAt
  };
}

function classifySignal(values) {
  const isChasing = (values.ret60 ?? 0) >= 10 || (values.ret15 ?? 0) >= 8;
  const quality = (values.quoteVol60 ?? 0) >= 10000 && (values.trades60 ?? 0) >= 150;
  const reasons = [];
  if ((values.vol60Ratio ?? 0) >= 15) reasons.push("60m成交额>=15x");
  else if ((values.vol60Ratio ?? 0) >= 10) reasons.push("60m成交额>=10x");
  else if ((values.vol60Ratio ?? 0) >= 8) reasons.push("60m成交额>=8x");
  if ((values.ret30 ?? 0) >= 2) reasons.push("30m转强>=2%");
  else if ((values.ret30 ?? 0) >= 1) reasons.push("30m转强>=1%");
  if ((values.vol15Ratio ?? 0) >= 5) reasons.push("15m成交加速>=5x");
  if ((values.trades15Ratio ?? 0) >= 3) reasons.push("15m交易数>=3x");
  if (quality) reasons.push("成交质量达标");
  if (isChasing) reasons.push("追高风险");

  let level = "none";
  if (isChasing && ((values.vol60Ratio ?? 0) >= 8 || (values.ret15 ?? 0) >= 5)) {
    level = "chase";
  } else if ((values.vol60Ratio ?? 0) >= 15 && (values.ret30 ?? 0) >= 2 && (values.ret60 ?? 0) < 8 && quality) {
    level = "strong";
  } else if ((values.vol60Ratio ?? 0) >= 10 && (values.ret30 ?? 0) >= 2 && (values.ret60 ?? 0) < 8 && quality) {
    level = "entry";
  } else if ((values.vol60Ratio ?? 0) >= 8 && (values.ret30 ?? 0) >= 1 && (values.ret60 ?? 0) < 8) {
    level = "watch";
  }

  const levelBase = { strong: 80, entry: 65, watch: 45, chase: 20, none: 0 }[level] || 0;
  const volume = Math.min(20, (values.vol60Ratio || 0) * 1.1);
  const momentum = Math.min(15, Math.max(0, values.ret30 || 0) * 2.5);
  const shortAccel = Math.min(10, (values.vol15Ratio || 0) * 0.8 + (values.trades15Ratio || 0));
  const qualityScore = Math.min(10, Math.log10(Math.max(1, values.quoteVol60 || 0)) + Math.log10(Math.max(1, values.trades60 || 0)));
  const range = Math.min(8, (values.range60Ratio || 0) * 2);
  const chasePenalty = isChasing ? 25 : 0;

  return {
    level,
    score: Math.max(0, Math.min(100, levelBase + volume + momentum + shortAccel + qualityScore + range - chasePenalty)),
    isChasing,
    reasons
  };
}

async function upsert(table, rows, conflict) {
  for (const chunk of chunks(rows, 200)) {
    await supabase(table, `?on_conflict=${conflict}`, {
      method: "POST",
      headers: { prefer: "resolution=merge-duplicates" },
      body: JSON.stringify(chunk)
    });
  }
}

async function insert(table, rows) {
  for (const chunk of chunks(rows, 200)) {
    await supabase(table, "", {
      method: "POST",
      body: JSON.stringify(chunk)
    });
  }
}

async function supabase(table, query, options) {
  const response = await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/${table}${query}`, {
    ...options,
    headers: {
      apikey: serviceRole,
      authorization: `Bearer ${serviceRole}`,
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${table} ${response.status}: ${body.slice(0, 500)}`);
  }
}

function latestBy(rows, key, timeKey) {
  const map = new Map();
  for (const row of rows) {
    if (!row[key]) continue;
    const previous = map.get(row[key]);
    if (!previous || Date.parse(row[timeKey]) > Date.parse(previous[timeKey])) {
      map.set(row[key], row);
    }
  }
  return map;
}

function parseCsv(text) {
  const records = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (quoted) {
      if (char === "\"" && next === "\"") {
        field += "\"";
        index += 1;
      } else if (char === "\"") {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === "\"") {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      records.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field || row.length) {
    row.push(field);
    records.push(row);
  }
  const header = records.shift() || [];
  return records
    .filter((record) => record.some((value) => value !== ""))
    .map((record) => Object.fromEntries(header.map((name, index) => [name, record[index] ?? ""])));
}

function loadEnvFile(file) {
  if (!file) return;
  const absolute = path.resolve(root, file);
  const text = readFileSync(absolute, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...parts] = trimmed.split("=");
    const value = parts.join("=").trim().replace(/^['"]|['"]$/g, "");
    if (!process.env[key]) process.env[key] = value;
    if (key === "VITE_SUPABASE_URL" && !process.env.SUPABASE_URL) process.env.SUPABASE_URL = value;
  }
}

function chunks(rows, size) {
  const output = [];
  for (let index = 0; index < rows.length; index += size) {
    output.push(rows.slice(index, index + size));
  }
  return output;
}

function emptyToNull(value) {
  return value === "" || value === undefined ? null : value;
}

function numOrNull(value) {
  if (value === "" || value === undefined || value === null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function intOrNull(value) {
  const number = numOrNull(value);
  return number === null ? null : Math.round(number);
}

function bool(value) {
  return String(value).toLowerCase() === "true";
}

function round(value, places = 4) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
