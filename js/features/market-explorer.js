const WATCHLIST_STORAGE_KEY = 'samtrade_market_watchlist_v1';
const LAST_SYMBOL_STORAGE_KEY = 'samtrade_market_last_symbol_v1';
const DEFAULT_SYMBOL = 'NASDAQ:AAPL';
const DEFAULT_WATCHLIST = [
  'NASDAQ:AAPL',
  'NASDAQ:MSFT',
  'NASDAQ:NVDA',
  'NASDAQ:TSLA',
  'AMEX:SPY',
  'NASDAQ:QQQ'
];

let config = {};
let initialized = false;
let chartMounted = false;
let snapshotRequestId = 0;
let positionSymbols = [];
let currentSymbol = readStoredSymbol();
let watchlist = readWatchlist();

function cleanText(value) {
  return String(value ?? '').trim();
}

function readStoredSymbol() {
  try {
    return cleanText(localStorage.getItem(LAST_SYMBOL_STORAGE_KEY)).toUpperCase() || DEFAULT_SYMBOL;
  } catch {
    return DEFAULT_SYMBOL;
  }
}

function readWatchlist() {
  try {
    const parsed = JSON.parse(localStorage.getItem(WATCHLIST_STORAGE_KEY) || '[]');
    if (Array.isArray(parsed)) {
      const normalized = parsed.map(item => normalizeTradingViewSymbol(item)).filter(Boolean);
      if (normalized.length) return [...new Set(normalized)].slice(0, 20);
    }
  } catch {
    // A blocked or malformed local storage value should not prevent the chart from loading.
  }

  return [...DEFAULT_WATCHLIST];
}

function persistState() {
  try {
    localStorage.setItem(LAST_SYMBOL_STORAGE_KEY, currentSymbol);
    localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(watchlist));
  } catch {
    // The market screen remains usable even when browser storage is unavailable.
  }
}

function normalizeTradingViewSymbol(value, exchange = 'NASDAQ') {
  const raw = cleanText(value).toUpperCase().replace(/\s+/g, '');
  if (!raw) return '';
  if (raw.includes(':')) {
    const [market, ...tickerParts] = raw.split(':');
    const ticker = tickerParts.join(':').replace(/[^A-Z0-9.\-]/g, '');
    const normalizedMarket = market.replace(/[^A-Z0-9_\-]/g, '');
    return normalizedMarket && ticker ? `${normalizedMarket}:${ticker}` : '';
  }

  const ticker = raw.replace(/[^A-Z0-9.\-]/g, '');
  const normalizedExchange = cleanText(exchange).toUpperCase() || 'NASDAQ';
  return ticker ? `${normalizedExchange}:${ticker}` : '';
}

function tickerFromSymbol(symbol) {
  const normalized = normalizeTradingViewSymbol(symbol);
  return normalized.includes(':') ? normalized.split(':').slice(1).join(':') : normalized;
}

function exchangeFromSymbol(symbol) {
  const normalized = normalizeTradingViewSymbol(symbol);
  return normalized.includes(':') ? normalized.split(':')[0] : 'NASDAQ';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatMoney(value, currency = 'USD') {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';

  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency || 'USD',
      maximumFractionDigits: amount >= 100 ? 2 : 4
    }).format(amount);
  } catch {
    return `$${amount.toFixed(2)}`;
  }
}

function formatNumber(value, digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(number);
}

function currentTheme() {
  if (typeof config.getTheme === 'function') return config.getTheme();
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function setSearchStatus(message, state = '') {
  const element = document.getElementById('marketSearchStatus');
  if (!element) return;
  element.textContent = message;
  element.className = `market-search-status ${state}`.trim();
}

function setChartHeading() {
  const label = document.getElementById('marketCurrentSymbol');
  const exchange = document.getElementById('marketCurrentExchange');
  const input = document.getElementById('marketSymbolInput');
  const select = document.getElementById('marketExchangeSelect');

  if (label) label.textContent = tickerFromSymbol(currentSymbol);
  if (exchange) exchange.textContent = exchangeFromSymbol(currentSymbol);
  if (input) input.value = tickerFromSymbol(currentSymbol);
  if (select) {
    const market = exchangeFromSymbol(currentSymbol);
    const optionExists = [...select.options].some(option => option.value === market);
    select.value = optionExists ? market : 'AUTO';
  }
}

function renderTradingViewChart() {
  const container = document.getElementById('marketChartContainer');
  if (!container) return;

  chartMounted = true;
  container.innerHTML = `
    <div class="market-chart-loading" aria-live="polite">
      <span class="market-chart-loader" aria-hidden="true"></span>
      <span>טוען גרף עבור ${escapeHtml(tickerFromSymbol(currentSymbol))}</span>
    </div>
  `;

  const widgetContainer = document.createElement('div');
  widgetContainer.className = 'tradingview-widget-container';
  widgetContainer.style.height = '100%';
  widgetContainer.style.width = '100%';
  widgetContainer.dir = 'ltr';

  const widgetHost = document.createElement('div');
  widgetHost.className = 'tradingview-widget-container__widget';
  widgetHost.style.height = 'calc(100% - 28px)';
  widgetHost.style.width = '100%';

  const attribution = document.createElement('div');
  attribution.className = 'tradingview-widget-copyright';
  attribution.innerHTML = `
    <a href="https://www.tradingview.com/symbols/${encodeURIComponent(currentSymbol.replace(':', '-'))}/" rel="noopener nofollow" target="_blank">
      <span class="blue-text">${escapeHtml(tickerFromSymbol(currentSymbol))} chart</span>
    </a>
    <span class="trademark"> by TradingView</span>
  `;

  const script = document.createElement('script');
  script.type = 'text/javascript';
  script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
  script.async = true;
  script.textContent = JSON.stringify({
    autosize: true,
    symbol: currentSymbol,
    interval: 'D',
    timezone: 'exchange',
    theme: currentTheme(),
    style: '1',
    locale: 'he_IL',
    backgroundColor: currentTheme() === 'dark' ? 'rgba(13, 20, 35, 1)' : 'rgba(255, 255, 255, 1)',
    gridColor: currentTheme() === 'dark' ? 'rgba(148, 163, 184, 0.08)' : 'rgba(100, 116, 139, 0.09)',
    withdateranges: true,
    hide_side_toolbar: false,
    hide_top_toolbar: false,
    hide_legend: false,
    hide_volume: false,
    allow_symbol_change: true,
    save_image: true,
    watchlist,
    studies: ['MASimple@tv-basicstudies'],
    details: false,
    hotlist: false,
    calendar: false,
    show_popup_button: true,
    popup_width: '1200',
    popup_height: '760',
    support_host: 'https://www.tradingview.com'
  });

  widgetContainer.append(widgetHost, attribution, script);
  container.replaceChildren(widgetContainer);
}

function renderSummaryLoading() {
  const ids = [
    'marketCompanyName',
    'marketLastPrice',
    'marketDailyChange',
    'marketDayRange',
    'marketOpenPrice',
    'marketPreviousClose'
  ];

  ids.forEach(id => {
    const element = document.getElementById(id);
    if (element) element.textContent = 'טוען';
  });

  const changeCard = document.getElementById('marketDailyChangeCard');
  if (changeCard) changeCard.classList.remove('positive', 'negative');
}

function renderSummary(snapshot = {}) {
  const profile = snapshot.profile || {};
  const quote = snapshot.quote || {};
  const currency = profile.currency || 'USD';
  const companyName = document.getElementById('marketCompanyName');
  const companyMeta = document.getElementById('marketCompanyMeta');
  const logo = document.getElementById('marketCompanyLogo');
  const lastPrice = document.getElementById('marketLastPrice');
  const dailyChange = document.getElementById('marketDailyChange');
  const dayRange = document.getElementById('marketDayRange');
  const openPrice = document.getElementById('marketOpenPrice');
  const previousClose = document.getElementById('marketPreviousClose');
  const changeCard = document.getElementById('marketDailyChangeCard');

  if (companyName) companyName.textContent = profile.name || tickerFromSymbol(currentSymbol);
  if (companyMeta) {
    const parts = [profile.exchange, profile.currency].filter(Boolean);
    companyMeta.textContent = parts.length ? parts.join(' · ') : 'נתוני החברה יוצגו כאשר Finnhub מחובר';
  }

  if (logo) {
    logo.innerHTML = profile.logo
      ? `<img src="${escapeHtml(profile.logo)}" alt="לוגו ${escapeHtml(profile.name || tickerFromSymbol(currentSymbol))}">`
      : `<span>${escapeHtml(tickerFromSymbol(currentSymbol).slice(0, 2))}</span>`;
  }

  if (lastPrice) lastPrice.textContent = formatMoney(quote.price, currency);
  if (dailyChange) {
    const change = Number(quote.change || 0);
    const percent = Number(quote.changePercent || 0);
    const prefix = change > 0 ? '+' : '';
    dailyChange.textContent = Number.isFinite(change)
      ? `${prefix}${formatNumber(change, 4)} (${prefix}${formatNumber(percent, 2)}%)`
      : '—';
  }

  if (changeCard) {
    const change = Number(quote.change || 0);
    changeCard.classList.toggle('positive', change > 0);
    changeCard.classList.toggle('negative', change < 0);
  }

  if (dayRange) {
    const low = formatMoney(quote.low, currency);
    const high = formatMoney(quote.high, currency);
    dayRange.textContent = low === '—' && high === '—' ? '—' : `${low} – ${high}`;
  }
  if (openPrice) openPrice.textContent = formatMoney(quote.open, currency);
  if (previousClose) previousClose.textContent = formatMoney(quote.previousClose, currency);
}

function renderSummaryUnavailable(message) {
  const companyName = document.getElementById('marketCompanyName');
  const companyMeta = document.getElementById('marketCompanyMeta');
  const logo = document.getElementById('marketCompanyLogo');

  if (companyName) companyName.textContent = tickerFromSymbol(currentSymbol);
  if (companyMeta) companyMeta.textContent = message || 'הגרף זמין גם ללא נתוני Finnhub';
  if (logo) logo.innerHTML = `<span>${escapeHtml(tickerFromSymbol(currentSymbol).slice(0, 2))}</span>`;

  ['marketLastPrice', 'marketDailyChange', 'marketDayRange', 'marketOpenPrice', 'marketPreviousClose']
    .forEach(id => {
      const element = document.getElementById(id);
      if (element) element.textContent = '—';
    });
}

async function refreshSnapshot(force = false) {
  const requestId = ++snapshotRequestId;
  renderSummaryLoading();

  if (typeof config.fetchSnapshot !== 'function') {
    renderSummaryUnavailable('נתוני מחיר חיצוניים אינם מוגדרים');
    return null;
  }

  try {
    const snapshot = await config.fetchSnapshot(tickerFromSymbol(currentSymbol), force);
    if (requestId !== snapshotRequestId) return null;

    if (snapshot?.error) {
      renderSummaryUnavailable(snapshot.error);
      return snapshot;
    }

    renderSummary(snapshot || {});
    return snapshot || null;
  } catch (error) {
    if (requestId !== snapshotRequestId) return null;
    renderSummaryUnavailable(error?.message || 'לא ניתן לטעון נתוני מחיר כעת');
    return null;
  }
}

function renderWatchlist() {
  const container = document.getElementById('marketWatchlist');
  const count = document.getElementById('marketWatchlistCount');
  const addButton = document.getElementById('addCurrentToWatchlist');

  if (count) count.textContent = `${watchlist.length}/20`;
  if (addButton) {
    const exists = watchlist.includes(currentSymbol);
    addButton.disabled = exists || watchlist.length >= 20;
    addButton.textContent = exists ? 'נמצא במעקב' : 'הוספה למעקב';
  }

  if (!container) return;
  if (!watchlist.length) {
    container.innerHTML = '<div class="market-list-empty">לא נוספו מניות למעקב.</div>';
    return;
  }

  container.innerHTML = watchlist.map(symbol => `
    <div class="market-watch-item ${symbol === currentSymbol ? 'active' : ''}">
      <button type="button" class="market-watch-symbol" data-market-open="${escapeHtml(symbol)}">
        <strong>${escapeHtml(tickerFromSymbol(symbol))}</strong>
        <span>${escapeHtml(exchangeFromSymbol(symbol))}</span>
      </button>
      <button type="button" class="market-watch-remove" data-market-remove="${escapeHtml(symbol)}" aria-label="הסרת ${escapeHtml(tickerFromSymbol(symbol))} מרשימת המעקב">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
      </button>
    </div>
  `).join('');
}

function mapPositionExchange(exchange, ticker) {
  const text = cleanText(exchange).toUpperCase();
  const normalizedTicker = cleanText(ticker).toUpperCase();

  if (text.includes('NASDAQ')) return 'NASDAQ';
  if (text.includes('NEW YORK') || text === 'NYSE') return 'NYSE';
  if (text.includes('TEL AVIV') || text.includes('TASE')) return 'TASE';
  if (text.includes('AMERICAN') || text.includes('ARCA') || text === 'AMEX') return 'AMEX';
  if (text.includes('LONDON') || text === 'LSE') return 'LSE';
  if (['SPY', 'DIA', 'IWM', 'GLD', 'SLV'].includes(normalizedTicker)) return 'AMEX';
  return 'NASDAQ';
}

function renderPositionSymbols() {
  const container = document.getElementById('marketPositionSymbols');
  const count = document.getElementById('marketPositionCount');
  if (count) count.textContent = String(positionSymbols.length);
  if (!container) return;

  if (!positionSymbols.length) {
    container.innerHTML = '<div class="market-list-empty">אין פוזיציות פתוחות להצגה.</div>';
    return;
  }

  container.innerHTML = positionSymbols.map(item => `
    <button type="button" class="market-position-item ${item.symbol === currentSymbol ? 'active' : ''}" data-market-open="${escapeHtml(item.symbol)}">
      <span class="market-position-main">
        <strong>${escapeHtml(item.ticker)}</strong>
        <small>${escapeHtml(item.companyName || item.exchange)}</small>
      </span>
      <span class="market-position-qty">${escapeHtml(item.quantity)} מניות</span>
    </button>
  `).join('');
}

function addCurrentToWatchlist() {
  if (watchlist.includes(currentSymbol) || watchlist.length >= 20) return;
  watchlist = [...watchlist, currentSymbol];
  persistState();
  renderWatchlist();
  renderTradingViewChart();
}

function removeFromWatchlist(symbol) {
  watchlist = watchlist.filter(item => item !== symbol);
  persistState();
  renderWatchlist();
  renderTradingViewChart();
}

export async function openMarketSymbol(symbol, options = {}) {
  const normalized = normalizeTradingViewSymbol(symbol);
  if (!normalized) {
    setSearchStatus('יש להזין טיקר תקין.', 'error');
    return;
  }

  currentSymbol = normalized;
  persistState();
  setChartHeading();
  renderWatchlist();
  renderPositionSymbols();
  renderTradingViewChart();
  setSearchStatus(`מציג את ${tickerFromSymbol(currentSymbol)} בבורסת ${exchangeFromSymbol(currentSymbol)}.`, 'success');

  if (!options.skipSnapshot) await refreshSnapshot(Boolean(options.force));
}

async function handleSearch() {
  const input = document.getElementById('marketSymbolInput');
  const exchangeSelect = document.getElementById('marketExchangeSelect');
  const raw = cleanText(input?.value);
  const selectedExchange = cleanText(exchangeSelect?.value || 'AUTO').toUpperCase();

  if (!raw) {
    setSearchStatus('יש להזין טיקר.', 'error');
    input?.focus();
    return;
  }

  if (raw.includes(':') || selectedExchange !== 'AUTO') {
    const symbol = raw.includes(':')
      ? normalizeTradingViewSymbol(raw)
      : normalizeTradingViewSymbol(raw, selectedExchange);
    await openMarketSymbol(symbol, { force: true });
    return;
  }

  setSearchStatus('מאתר את הבורסה המתאימה', 'loading');
  let exchange = 'NASDAQ';

  if (typeof config.resolveExchange === 'function') {
    try {
      exchange = await config.resolveExchange(raw) || exchange;
    } catch {
      exchange = 'NASDAQ';
    }
  }

  await openMarketSymbol(normalizeTradingViewSymbol(raw, exchange), { force: true });
}

function handleMarketClick(event) {
  const openButton = event.target.closest('[data-market-open]');
  if (openButton) {
    void openMarketSymbol(openButton.dataset.marketOpen, { force: false });
    return;
  }

  const removeButton = event.target.closest('[data-market-remove]');
  if (removeButton) {
    removeFromWatchlist(removeButton.dataset.marketRemove);
  }
}

export function refreshMarketExplorerPositions(positions = []) {
  const unique = new Map();

  (Array.isArray(positions) ? positions : []).forEach(position => {
    const ticker = cleanText(position?.TICKER).toUpperCase();
    if (!ticker || unique.has(ticker)) return;

    const exchange = mapPositionExchange(position?.COMPANY_EXCHANGE, ticker);
    unique.set(ticker, {
      ticker,
      exchange,
      symbol: normalizeTradingViewSymbol(ticker, exchange),
      companyName: cleanText(position?.COMPANY_NAME),
      quantity: Number(position?.TOTAL_QTY || 0).toLocaleString('en-US')
    });
  });

  positionSymbols = [...unique.values()];
  renderPositionSymbols();
}

export function activateMarketExplorer() {
  setChartHeading();
  renderWatchlist();
  renderPositionSymbols();

  requestAnimationFrame(() => {
    renderTradingViewChart();
    void refreshSnapshot(false);
  });
}

export function initMarketExplorer(options = {}) {
  config = { ...options };
  if (initialized) return;
  initialized = true;

  document.getElementById('marketSymbolForm')?.addEventListener('submit', event => {
    event.preventDefault();
    void handleSearch();
  });

  document.getElementById('marketExplorerRoot')?.addEventListener('click', handleMarketClick);
  document.getElementById('addCurrentToWatchlist')?.addEventListener('click', addCurrentToWatchlist);
  document.getElementById('refreshMarketSnapshot')?.addEventListener('click', () => void refreshSnapshot(true));

  window.addEventListener('samtrade:themechange', () => {
    if (chartMounted && document.querySelector('[data-view="market"].active')) {
      renderTradingViewChart();
    }
  });

  setChartHeading();
  renderWatchlist();
  renderPositionSymbols();
  renderSummaryUnavailable('פתח את מסך השוק כדי לטעון נתונים');
}
