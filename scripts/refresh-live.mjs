import { readFileSync } from "node:fs";
import { onRequestGet } from "../functions/api/refresh.js";

loadEnvFile(argValue("--env-file"));

if (process.env.VITE_SUPABASE_URL && !process.env.SUPABASE_URL) {
  process.env.SUPABASE_URL = process.env.VITE_SUPABASE_URL;
}

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
}

const cronSecret = process.env.CRON_SECRET || "local-collector";
const url = new URL("https://local.alpha-rightside-monitor/api/refresh");
url.searchParams.set("key", cronSecret);
url.searchParams.set("offset", argValue("--offset") || "0");
url.searchParams.set("limit", argValue("--limit") || process.env.REFRESH_BATCH_LIMIT || "50");
url.searchParams.set("klineLimit", argValue("--kline-limit") || process.env.WALLET_KLINE_LIMIT || "330");

if (hasArg("--bootstrap")) {
  url.searchParams.set("bootstrap", "1");
}

const env = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  CRON_SECRET: cronSecret,
  SUPABASE_TABLE_TOKENS: process.env.SUPABASE_TABLE_TOKENS || "alpha_tokens",
  SUPABASE_TABLE_KLINES: process.env.SUPABASE_TABLE_KLINES || "alpha_klines_5m",
  SUPABASE_TABLE_CURRENT: process.env.SUPABASE_TABLE_CURRENT || "alpha_metrics_current",
  SUPABASE_TABLE_SNAPSHOTS: process.env.SUPABASE_TABLE_SNAPSHOTS || "alpha_signal_snapshots",
  REFRESH_BATCH_LIMIT: process.env.REFRESH_BATCH_LIMIT || "50",
  WALLET_KLINE_LIMIT: process.env.WALLET_KLINE_LIMIT || "330",
  BINANCE_FETCH_TIMEOUT_MS: process.env.BINANCE_FETCH_TIMEOUT_MS || "12000"
};

const response = await onRequestGet({
  request: new Request(url),
  env
});

const text = await response.text();
console.log(text);

if (!response.ok) {
  process.exitCode = 1;
} else {
  try {
    const payload = JSON.parse(text);
    if (!payload.ok) process.exitCode = 1;
  } catch {
    process.exitCode = 1;
  }
}

function hasArg(name) {
  return process.argv.includes(name);
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

function loadEnvFile(file) {
  if (!file) return;
  const text = readFileSync(file, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...parts] = trimmed.split("=");
    const value = parts.join("=").trim().replace(/^['"]|['"]$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}
