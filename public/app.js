const state = {
  filters: {
    q: "",
    level: "active",
    chain: "all",
    minQuoteVol60: 10000,
    minTrades60: 150,
    hideChasing: true,
    sort: "score"
  },
  chains: [],
  controller: null
};

const elements = {
  refreshButton: document.querySelector("#refreshButton"),
  searchInput: document.querySelector("#searchInput"),
  levelSegments: document.querySelector("#levelSegments"),
  chainSelect: document.querySelector("#chainSelect"),
  sortSelect: document.querySelector("#sortSelect"),
  minQuoteInput: document.querySelector("#minQuoteInput"),
  minTradesInput: document.querySelector("#minTradesInput"),
  hideChasingInput: document.querySelector("#hideChasingInput"),
  tokenList: document.querySelector("#tokenList"),
  tokenTemplate: document.querySelector("#tokenTemplate"),
  emptyState: document.querySelector("#emptyState"),
  toast: document.querySelector("#toast"),
  statusText: document.querySelector("#statusText"),
  updatedText: document.querySelector("#updatedText"),
  strongCount: document.querySelector("#strongCount"),
  entryCount: document.querySelector("#entryCount"),
  watchCount: document.querySelector("#watchCount"),
  activeCount: document.querySelector("#activeCount")
};

const levelLabels = {
  strong: "强",
  entry: "准入",
  watch: "观察",
  chase: "追高",
  none: "无"
};

init();

function init() {
  bindEvents();
  registerServiceWorker();
  loadSignals();
  window.setInterval(loadSignals, 60_000);
}

function bindEvents() {
  elements.refreshButton.addEventListener("click", () => loadSignals());
  elements.searchInput.addEventListener("input", debounce((event) => {
    state.filters.q = event.target.value.trim();
    loadSignals();
  }, 260));

  elements.levelSegments.addEventListener("click", (event) => {
    const button = event.target.closest("[data-level]");
    if (!button) return;
    state.filters.level = button.dataset.level;
    for (const node of elements.levelSegments.querySelectorAll(".segment")) {
      node.classList.toggle("is-active", node === button);
    }
    loadSignals();
  });

  elements.chainSelect.addEventListener("change", (event) => {
    state.filters.chain = event.target.value;
    loadSignals();
  });
  elements.sortSelect.addEventListener("change", (event) => {
    state.filters.sort = event.target.value;
    loadSignals();
  });
  elements.minQuoteInput.addEventListener("change", (event) => {
    state.filters.minQuoteVol60 = Number(event.target.value || 0);
    loadSignals();
  });
  elements.minTradesInput.addEventListener("change", (event) => {
    state.filters.minTrades60 = Number(event.target.value || 0);
    loadSignals();
  });
  elements.hideChasingInput.addEventListener("change", (event) => {
    state.filters.hideChasing = event.target.checked;
    loadSignals();
  });
}

async function loadSignals() {
  if (state.controller) state.controller.abort();
  state.controller = new AbortController();
  elements.statusText.textContent = "刷新中";

  try {
    const params = new URLSearchParams({
      q: state.filters.q,
      level: state.filters.level,
      chain: state.filters.chain,
      minQuoteVol60: String(state.filters.minQuoteVol60),
      minTrades60: String(state.filters.minTrades60),
      hideChasing: state.filters.hideChasing ? "1" : "0",
      sort: state.filters.sort
    });
    const response = await fetch(`/api/signals?${params.toString()}`, {
      signal: state.controller.signal,
      headers: { accept: "application/json" }
    });
    const payload = await response.json();
    if (!payload.ok) {
      throw new Error(payload.error || "load_failed");
    }
    renderSummary(payload.summary);
    updateChains(payload.summary.chains || []);
    renderTokens(payload.data || []);
    elements.statusText.textContent = `${payload.data.length} 个结果`;
    elements.updatedText.textContent = payload.summary.latestComputedAt
      ? relativeTime(payload.summary.latestComputedAt)
      : "";
  } catch (error) {
    if (error.name === "AbortError") return;
    elements.statusText.textContent = "读取失败";
    elements.updatedText.textContent = "";
    showToast(error.message === "missing_supabase_env" ? "Supabase 未配置" : "数据读取失败");
  }
}

function renderSummary(summary) {
  elements.strongCount.textContent = summary.strong || 0;
  elements.entryCount.textContent = summary.entry || 0;
  elements.watchCount.textContent = summary.watch || 0;
  elements.activeCount.textContent = summary.total || 0;
}

function updateChains(chains) {
  const current = elements.chainSelect.value;
  const next = ["all", ...chains];
  const existing = [...elements.chainSelect.options].map((option) => option.value);
  if (JSON.stringify(existing) === JSON.stringify(next)) return;
  elements.chainSelect.replaceChildren(...next.map((chain) => {
    const option = document.createElement("option");
    option.value = chain;
    option.textContent = chain === "all" ? "全部" : chain;
    return option;
  }));
  elements.chainSelect.value = next.includes(current) ? current : "all";
}

function renderTokens(tokens) {
  elements.tokenList.replaceChildren();
  elements.emptyState.hidden = tokens.length > 0;

  const fragment = document.createDocumentFragment();
  for (const token of tokens) {
    fragment.appendChild(renderToken(token));
  }
  elements.tokenList.appendChild(fragment);
}

function renderToken(token) {
  const node = elements.tokenTemplate.content.firstElementChild.cloneNode(true);
  const icon = node.querySelector(".token-icon");
  const symbol = node.querySelector(".token-symbol");
  const name = node.querySelector(".token-name");
  const pill = node.querySelector(".signal-pill");
  const price = node.querySelector(".token-price strong");
  const change = node.querySelector(".token-price span");
  const chain = node.querySelector(".chain-chip");
  const contract = node.querySelector(".contract-line code");
  const copy = node.querySelector(".copy-btn");
  const reasons = node.querySelector(".reason-row");

  icon.src = token.iconUrl || "/assets/icon.svg";
  symbol.textContent = token.symbol || "-";
  name.textContent = token.name || "";
  pill.textContent = levelLabels[token.signalLevel] || token.signalLevel || "无";
  pill.classList.add(token.signalLevel || "none");
  price.textContent = formatPrice(token.price);
  change.textContent = formatPercent(token.percentChange24h);
  change.classList.toggle("up", Number(token.percentChange24h) > 0);
  change.classList.toggle("down", Number(token.percentChange24h) < 0);
  chain.textContent = token.chainName || "-";
  contract.textContent = token.contractAddress || "-";
  copy.addEventListener("click", () => copyContract(token.contractAddress));

  setField(node, "ret30", formatPercent(token.ret30));
  setField(node, "ret60", formatPercent(token.ret60));
  setField(node, "vol60", formatRatio(token.vol60Ratio));
  setField(node, "vol15", formatRatio(token.vol15Ratio));
  setField(node, "trades15", formatRatio(token.trades15Ratio));
  setField(node, "quote60", formatUsd(token.quoteVol60m));
  setField(node, "trades60", compact(token.trades60m));
  setField(node, "mcap", formatUsd(token.marketCap));

  const reasonItems = (token.reasons || []).slice(0, 4);
  reasons.replaceChildren(...reasonItems.map((reason) => {
    const span = document.createElement("span");
    span.textContent = reason;
    return span;
  }));
  if (!reasonItems.length) reasons.remove();

  return node;
}

function setField(node, field, value) {
  const target = node.querySelector(`[data-field="${field}"]`);
  if (target) target.textContent = value;
}

async function copyContract(address) {
  if (!address) return;
  try {
    await navigator.clipboard.writeText(address);
    showToast("合约已复制");
  } catch {
    showToast("复制失败");
  }
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("is-visible");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    elements.toast.classList.remove("is-visible");
  }, 1800);
}

function formatPrice(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  if (number >= 1) return `$${number.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
  if (number >= 0.01) return `$${number.toLocaleString(undefined, { maximumFractionDigits: 6 })}`;
  return `$${number.toLocaleString(undefined, { maximumSignificantDigits: 6 })}`;
}

function formatPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return `${number > 0 ? "+" : ""}${number.toFixed(Math.abs(number) >= 10 ? 1 : 2)}%`;
}

function formatRatio(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return `${number.toFixed(number >= 10 ? 1 : 2)}x`;
}

function formatUsd(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  if (number >= 1_000_000_000) return `$${(number / 1_000_000_000).toFixed(2)}B`;
  if (number >= 1_000_000) return `$${(number / 1_000_000).toFixed(2)}M`;
  if (number >= 1_000) return `$${(number / 1_000).toFixed(1)}K`;
  return `$${number.toFixed(0)}`;
}

function compact(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(number);
}

function relativeTime(iso) {
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  if (seconds < 60) return `${seconds}s 前`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m 前`;
  const hours = Math.round(minutes / 60);
  return `${hours}h 前`;
}

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/service-worker.js").catch(() => {});
  });
}
