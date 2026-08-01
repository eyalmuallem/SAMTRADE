import { initializeApp as initializeFirebaseApp } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js';
import { firebaseConfig } from './core/firebase-config.js';
import { FINNHUB_BASE_URL, MARKET_TOKEN_STORAGE_KEY, MARKET_CACHE_STORAGE_KEY, QUOTE_CACHE_MS, PROFILE_CACHE_MS } from './core/constants.js';
import { initTheme, toggleTheme, syncThemeControl, getCurrentTheme } from './core/theme.js';
import { initNavigation } from './core/navigation.js';
import {
  averageRating,
  buildJournalDailyRows,
  buildRatingBreakdown,
  describeCorrelation,
  getJournalDimension,
  pearsonCorrelation
} from './features/journal-analytics.js';
import {
  activateMarketExplorer,
  initMarketExplorer,
  refreshMarketExplorerPositions
} from './features/market-explorer.js';
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js';
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  serverTimestamp,
  writeBatch
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js';



let auth = null;
let db = null;
let currentUser = null;
let appData = {
  openPositions: [],
  closedPositions: [],
  transactions: [],
  journalEntries: [],
  portfolioSnapshots: [],
  stats: {}
};


const marketQuotes = new Map();
const marketProfiles = new Map();
let tickerLookupTimer = null;
let activeTickerLookup = null;
let marketRefreshInProgress = false;
let showWorkspaceView = null;
let selectedJournalDate = '';
let selectedJournalDimension = 'mood';
let selectedPortfolioMode = 'closed';
const portfolioSeriesVisibility = { realized: true, total: true };
let portfolioSnapshotPermissionWarningShown = false;


const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

function isFirebaseConfigReady() {
  const requiredKeys = ['apiKey', 'authDomain', 'projectId', 'appId'];
  return requiredKeys.every(key => {
    const value = String(firebaseConfig[key] || '');
    return value && !value.includes('PASTE_');
  });
}

function bootFirebase() {
  if (!isFirebaseConfigReady()) {
    updateAuthUi(null, 'יש להגדיר firebaseConfig בקובץ js/core/firebase-config.js');
    renderSignedOutState('המערכת מוכנה, אך Firebase עדיין לא הוגדר.');
    return;
  }

  try {
    const firebaseApp = initializeFirebaseApp(firebaseConfig);
    auth = getAuth(firebaseApp);
    db = getFirestore(firebaseApp);

    onAuthStateChanged(auth, async user => {
      currentUser = user || null;
      updateAuthUi(currentUser);

      if (currentUser) {
        await loadDashboard();
      } else {
        renderSignedOutState('יש להתחבר עם Google כדי להציג את יומן המסחר.');
      }
    });
  } catch (error) {
    handleServerError(error);
    updateAuthUi(null, 'הגדרת Firebase אינה תקינה');
  }
}

async function toggleAuth() {
  if (!auth) {
    showToast('יש לבדוק את הגדרות Firebase בקובץ js/core/firebase-config.js.', 'error');
    return;
  }

  try {
    if (currentUser) {
      await signOut(auth);
      return;
    }

    await signInWithPopup(auth, googleProvider);
  } catch (error) {
    handleServerError(error);
  }
}

function updateAuthUi(user, overrideMessage = '') {
  const status = document.getElementById('authStatus');
  const button = document.getElementById('authButton');
  const openButton = document.getElementById('openPositionButton');

  if (!status || !button || !openButton) return;

  if (overrideMessage) {
    status.textContent = overrideMessage;
    button.textContent = 'התחברות עם Google';
    openButton.disabled = true;
    return;
  }

  if (user) {
    status.textContent = user.email || user.displayName || 'מחובר';
    button.textContent = 'התנתקות';
    openButton.disabled = false;
  } else {
    status.textContent = 'לא מחובר';
    button.textContent = 'התחברות עם Google';
    openButton.disabled = true;
  }
}

function renderSignedOutState(message) {
  appData = {
    openPositions: [],
    closedPositions: [],
    transactions: [],
    journalEntries: [],
    portfolioSnapshots: [],
    stats: { openCount: 0, closedCount: 0, winRate: 0, totalPl: 0, averageTrade: 0 }
  };

  renderDashboard();
  renderPortfolioOverview();
  renderJournalPage(selectedJournalDate || todayIso());
  renderStatistics();
  refreshMarketExplorerPositions([]);
  document.getElementById('openPositionsContainer').innerHTML =
    `<div class="empty-state">${escapeHtml(message)}</div>`;
  document.getElementById('closedPositionsContainer').innerHTML =
    '<div class="empty-state">לאחר ההתחברות יוצגו כאן העסקאות שנסגרו.</div>';
}

function requireUser() {
  if (currentUser && db) return true;
  showToast('יש להתחבר עם Google לפני ביצוע הפעולה.', 'error');
  return false;
}

function positionsCollection() {
  if (!requireUser()) throw new Error('המשתמש אינו מחובר.');
  return collection(db, 'users', currentUser.uid, 'positions');
}

function transactionsCollection() {
  if (!requireUser()) throw new Error('המשתמש אינו מחובר.');
  return collection(db, 'users', currentUser.uid, 'transactions');
}

function journalCollection() {
  if (!requireUser()) throw new Error('המשתמש אינו מחובר.');
  return collection(db, 'users', currentUser.uid, 'dailyJournal');
}

function journalDocument(date) {
  if (!requireUser()) throw new Error('המשתמש אינו מחובר.');
  return doc(db, 'users', currentUser.uid, 'dailyJournal', cleanText(date));
}

function portfolioSnapshotsCollection() {
  if (!requireUser()) throw new Error('המשתמש אינו מחובר.');
  return collection(db, 'users', currentUser.uid, 'portfolioSnapshots');
}

function portfolioSnapshotDocument(date) {
  if (!requireUser()) throw new Error('המשתמש אינו מחובר.');
  return doc(db, 'users', currentUser.uid, 'portfolioSnapshots', cleanText(date));
}

function positionDocument(positionId) {
  if (!requireUser()) throw new Error('המשתמש אינו מחובר.');
  return doc(db, 'users', currentUser.uid, 'positions', positionId);
}

async function loadDashboard() {
  if (!currentUser || !db) {
    renderSignedOutState('יש להתחבר עם Google כדי להציג את יומן המסחר.');
    return;
  }

  setLoading(true);

  try {
    const [positionsSnapshot, transactionsSnapshot, journalResult, portfolioSnapshotResult] = await Promise.all([
      getDocs(positionsCollection()),
      getDocs(transactionsCollection()),
      getDocs(journalCollection())
        .then(snapshot => ({ snapshot, error: null }))
        .catch(error => ({ snapshot: null, error })),
      getDocs(portfolioSnapshotsCollection())
        .then(snapshot => ({ snapshot, error: null }))
        .catch(error => ({ snapshot: null, error }))
    ]);

    const positions = positionsSnapshot.docs.map(snapshot => ({
      ...snapshot.data(),
      POSITION_ID: snapshot.id
    }));

    const transactions = transactionsSnapshot.docs.map(snapshot => ({
      ...snapshot.data(),
      TRANSACTION_ID: snapshot.id
    }));

    const journalEntries = journalResult.snapshot
      ? journalResult.snapshot.docs
        .map(snapshot => ({
          ...snapshot.data(),
          JOURNAL_DATE: snapshot.id,
          DATE: snapshot.data().DATE || snapshot.id
        }))
        .sort((a, b) => String(b.DATE || '').localeCompare(String(a.DATE || '')))
      : [];

    const portfolioSnapshots = portfolioSnapshotResult.snapshot
      ? portfolioSnapshotResult.snapshot.docs
        .map(snapshot => ({
          ...snapshot.data(),
          SNAPSHOT_DATE: snapshot.id,
          DATE: snapshot.data().DATE || snapshot.id
        }))
        .sort((a, b) => String(a.DATE || '').localeCompare(String(b.DATE || '')))
      : [];

    if (journalResult.error) {
      console.warn('Daily journal data could not be loaded.', journalResult.error);
      showToast('נתוני העסקאות נטענו, אך יש לעדכן הרשאה לאוסף dailyJournal ב-Firestore.', 'error');
    }

    if (portfolioSnapshotResult.error) {
      console.warn('Portfolio snapshots could not be loaded.', portfolioSnapshotResult.error);
      updatePortfolioSnapshotStatus('מגמת התיק תוצג מהעסקאות הסגורות; לא קיימת הרשאה לצילומים יומיים.', 'warning');
    }

    const openPositions = positions
      .filter(position => position.STATUS === 'OPEN')
      .sort((a, b) => String(b.OPEN_DATE || '').localeCompare(String(a.OPEN_DATE || '')));

    const closedPositions = positions
      .filter(position => position.STATUS === 'CLOSED')
      .sort((a, b) => String(b.CLOSE_DATE || '').localeCompare(String(a.CLOSE_DATE || '')));

    const winningTrades = closedPositions.filter(position =>
      Number(position.PL_DOLLAR || 0) > 0
    ).length;

    const totalPl = closedPositions.reduce((total, position) =>
      total + Number(position.PL_DOLLAR || 0), 0
    );

    appData = {
      openPositions,
      closedPositions,
      transactions,
      journalEntries,
      portfolioSnapshots,
      stats: {
        openCount: openPositions.length,
        closedCount: closedPositions.length,
        winRate: closedPositions.length
          ? roundNumber(winningTrades / closedPositions.length * 100, 2)
          : 0,
        totalPl: roundNumber(totalPl, 2),
        averageTrade: closedPositions.length ? roundNumber(totalPl / closedPositions.length, 2) : 0
      }
    };

    renderDashboard();
    renderPortfolioOverview();
    renderJournalPage(selectedJournalDate || todayIso());
    renderStatistics();
    refreshMarketExplorerPositions(openPositions);
    void refreshMarketPrices(false);
  } catch (error) {
    handleServerError(error);
  } finally {
    setLoading(false);
  }
}

async function createPosition(data) {
  if (!requireUser()) throw new Error('המשתמש אינו מחובר.');

  const ticker = cleanText(data.ticker).toUpperCase();
  const openDate = cleanText(data.openDate);
  const quantity = positiveNumber(data.quantity, 'כמות מניות');
  const price = positiveNumber(data.price, 'מחיר קנייה');
  const stopLoss = positiveNumber(data.stopLoss, 'Stop Loss');
  const targetPrice = positiveNumber(data.targetPrice, 'מחיר יעד');
  const pattern = cleanText(data.pattern);
  const marketDirection = cleanText(data.marketDirection);
  const notes = cleanText(data.notes);
  const companyName = cleanText(data.companyName);
  const companyLogo = cleanText(data.companyLogo);
  const companyCurrency = cleanText(data.companyCurrency) || 'USD';
  const companyExchange = cleanText(data.companyExchange);
  const tickerVerified = String(data.tickerVerified || '') === 'true';

  if (!ticker) throw new Error('חובה להזין טיקר.');
  if (!openDate) throw new Error('חובה להזין תאריך פתיחה.');
  if (!pattern) throw new Error('חובה להזין תבנית.');
  if (!['עולה', 'יורד'].includes(marketDirection)) {
    throw new Error('יש לבחור כיוון שוק.');
  }

  validatePrices(price, stopLoss, targetPrice);
  const calculations = calculatePosition(quantity, price, stopLoss, targetPrice);

  const positionRef = doc(positionsCollection());
  const transactionRef = doc(transactionsCollection());
  const batch = writeBatch(db);

  batch.set(positionRef, {
    POSITION_ID: positionRef.id,
    STATUS: 'OPEN',
    TICKER: ticker,
    OPEN_DATE: openDate,
    CLOSE_DATE: '',
    PATTERN: pattern,
    MARKET_DIRECTION: marketDirection,
    TOTAL_QTY: quantity,
    AVG_PRICE: price,
    STOP_LOSS: stopLoss,
    TARGET_PRICE: targetPrice,
    PLANNED_RISK_DOLLAR: calculations.riskDollar,
    PLANNED_RISK_PERCENT: calculations.riskPercent,
    POTENTIAL_DOLLAR: calculations.potentialDollar,
    POTENTIAL_PERCENT: calculations.potentialPercent,
    RISK_REWARD: calculations.riskReward,
    EXIT_PRICE: null,
    PL_DOLLAR: null,
    PL_PERCENT: null,
    NOTES: notes,
    COMPANY_NAME: companyName,
    COMPANY_LOGO: companyLogo,
    COMPANY_CURRENCY: companyCurrency,
    COMPANY_EXCHANGE: companyExchange,
    TICKER_VERIFIED: tickerVerified,
    CREATED_AT: serverTimestamp(),
    UPDATED_AT: serverTimestamp()
  });

  batch.set(transactionRef, {
    TRANSACTION_ID: transactionRef.id,
    POSITION_ID: positionRef.id,
    TYPE: 'OPEN',
    DATE: openDate,
    QUANTITY: quantity,
    PRICE: price,
    STOP_LOSS: stopLoss,
    TARGET_PRICE: targetPrice,
    NOTES: notes,
    CREATED_AT: serverTimestamp()
  });

  await batch.commit();
  return { success: true, positionId: positionRef.id };
}

async function addToPosition(data) {
  if (!requireUser()) throw new Error('המשתמש אינו מחובר.');

  const positionId = cleanText(data.positionId);
  const date = cleanText(data.date);
  const addedQuantity = positiveNumber(data.quantity, 'כמות להוספה');
  const addedPrice = positiveNumber(data.price, 'מחיר ההוספה');
  const notes = cleanText(data.notes);

  const positionRef = positionDocument(positionId);
  const snapshot = await getDoc(positionRef);

  if (!snapshot.exists()) throw new Error('הפוזיציה לא נמצאה.');

  const position = snapshot.data();
  if (position.STATUS !== 'OPEN') {
    throw new Error('לא ניתן להוסיף לפוזיציה שכבר נסגרה.');
  }

  const oldQuantity = Number(position.TOTAL_QTY || 0);
  const oldAverage = Number(position.AVG_PRICE || 0);
  const newQuantity = oldQuantity + addedQuantity;
  const newAverage = (
    oldQuantity * oldAverage + addedQuantity * addedPrice
  ) / newQuantity;

  const newStopLoss = data.stopLoss
    ? positiveNumber(data.stopLoss, 'Stop Loss חדש')
    : Number(position.STOP_LOSS || 0);

  const newTargetPrice = data.targetPrice
    ? positiveNumber(data.targetPrice, 'מחיר יעד חדש')
    : Number(position.TARGET_PRICE || 0);

  validatePrices(newAverage, newStopLoss, newTargetPrice);
  const calculations = calculatePosition(
    newQuantity,
    newAverage,
    newStopLoss,
    newTargetPrice
  );

  const transactionRef = doc(transactionsCollection());
  const batch = writeBatch(db);

  batch.update(positionRef, {
    TOTAL_QTY: roundNumber(newQuantity, 4),
    AVG_PRICE: roundNumber(newAverage, 4),
    STOP_LOSS: newStopLoss,
    TARGET_PRICE: newTargetPrice,
    PLANNED_RISK_DOLLAR: calculations.riskDollar,
    PLANNED_RISK_PERCENT: calculations.riskPercent,
    POTENTIAL_DOLLAR: calculations.potentialDollar,
    POTENTIAL_PERCENT: calculations.potentialPercent,
    RISK_REWARD: calculations.riskReward,
    NOTES: appendNote(position.NOTES, notes),
    UPDATED_AT: serverTimestamp()
  });

  batch.set(transactionRef, {
    TRANSACTION_ID: transactionRef.id,
    POSITION_ID: positionId,
    TYPE: 'ADD',
    DATE: date,
    QUANTITY: addedQuantity,
    PRICE: addedPrice,
    STOP_LOSS: newStopLoss,
    TARGET_PRICE: newTargetPrice,
    NOTES: notes,
    CREATED_AT: serverTimestamp()
  });

  await batch.commit();

  return {
    success: true,
    newAverage: roundNumber(newAverage, 4),
    newQuantity: roundNumber(newQuantity, 4)
  };
}

async function closePosition(data) {
  if (!requireUser()) throw new Error('המשתמש אינו מחובר.');

  const positionId = cleanText(data.positionId);
  const closeDate = cleanText(data.closeDate);
  const exitPrice = positiveNumber(data.exitPrice, 'מחיר המכירה');
  const notes = cleanText(data.notes);

  const positionRef = positionDocument(positionId);
  const snapshot = await getDoc(positionRef);

  if (!snapshot.exists()) throw new Error('הפוזיציה לא נמצאה.');

  const position = snapshot.data();
  if (position.STATUS !== 'OPEN') {
    throw new Error('הפוזיציה כבר סגורה.');
  }

  const quantity = Number(position.TOTAL_QTY || 0);
  const averagePrice = Number(position.AVG_PRICE || 0);
  const plDollar = (exitPrice - averagePrice) * quantity;
  const plPercent = averagePrice
    ? (exitPrice / averagePrice - 1) * 100
    : 0;

  const transactionRef = doc(transactionsCollection());
  const batch = writeBatch(db);

  batch.update(positionRef, {
    STATUS: 'CLOSED',
    CLOSE_DATE: closeDate,
    EXIT_PRICE: exitPrice,
    PL_DOLLAR: roundNumber(plDollar, 2),
    PL_PERCENT: roundNumber(plPercent, 2),
    NOTES: appendNote(position.NOTES, notes),
    UPDATED_AT: serverTimestamp()
  });

  batch.set(transactionRef, {
    TRANSACTION_ID: transactionRef.id,
    POSITION_ID: positionId,
    TYPE: 'CLOSE',
    DATE: closeDate,
    QUANTITY: quantity,
    PRICE: exitPrice,
    STOP_LOSS: position.STOP_LOSS,
    TARGET_PRICE: position.TARGET_PRICE,
    NOTES: notes,
    CREATED_AT: serverTimestamp()
  });

  await batch.commit();

  return {
    success: true,
    plDollar: roundNumber(plDollar, 2),
    plPercent: roundNumber(plPercent, 2)
  };
}

async function deleteClosedPosition(positionId) {
  if (!requireUser()) throw new Error('המשתמש אינו מחובר.');

  const cleanPositionId = cleanText(positionId);
  const position = appData.closedPositions.find(item =>
    item.POSITION_ID === cleanPositionId
  );

  if (!position) {
    throw new Error('הפוזיציה הסגורה לא נמצאה.');
  }

  const relatedTransactions = appData.transactions.filter(transaction =>
    transaction.POSITION_ID === cleanPositionId
  );

  if (relatedTransactions.length + 1 > 500) {
    throw new Error('לפוזיציה זו יש יותר מדי רשומות למחיקה בפעולה אחת.');
  }

  const batch = writeBatch(db);
  batch.delete(positionDocument(cleanPositionId));

  relatedTransactions.forEach(transaction => {
    if (!transaction.TRANSACTION_ID) return;

    const transactionRef = doc(
      db,
      'users',
      currentUser.uid,
      'transactions',
      transaction.TRANSACTION_ID
    );

    batch.delete(transactionRef);
  });

  await batch.commit();

  return {
    success: true,
    deletedTransactions: relatedTransactions.length
  };
}

function journalRating(value, fieldName) {
  const rating = Number(value);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new Error(`יש לבחור דירוג בין 1 ל-5 עבור ${fieldName}.`);
  }
  return rating;
}

async function saveJournalEntry(data) {
  if (!requireUser()) throw new Error('המשתמש אינו מחובר.');

  const date = cleanText(data.date);
  const mood = journalRating(data.mood, 'מצב הרוח');
  const fatigue = journalRating(data.fatigue, 'רמת העייפות');
  const dayQuality = journalRating(data.dayQuality, 'איכות היום');
  const notes = cleanText(data.notes).slice(0, 600);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('יש לבחור תאריך תקין.');
  }

  if (date > todayIso()) {
    throw new Error('לא ניתן למלא שאלון יומי לתאריך עתידי.');
  }

  const journalRef = journalDocument(date);
  const existing = await getDoc(journalRef);
  const payload = {
    DATE: date,
    MOOD: mood,
    FATIGUE: fatigue,
    DAY_QUALITY: dayQuality,
    NOTES: notes,
    UPDATED_AT: serverTimestamp()
  };

  if (!existing.exists()) {
    payload.CREATED_AT = serverTimestamp();
  }

  await setDoc(journalRef, payload, { merge: true });
  return { success: true, date };
}

function calculatePosition(quantity, averagePrice, stopLoss, targetPrice) {
  const riskPerShare = Math.max(averagePrice - stopLoss, 0);
  const potentialPerShare = Math.max(targetPrice - averagePrice, 0);

  return {
    riskDollar: roundNumber(riskPerShare * quantity, 2),
    riskPercent: roundNumber(averagePrice ? riskPerShare / averagePrice * 100 : 0, 2),
    potentialDollar: roundNumber(potentialPerShare * quantity, 2),
    potentialPercent: roundNumber(averagePrice ? potentialPerShare / averagePrice * 100 : 0, 2),
    riskReward: roundNumber(riskPerShare ? potentialPerShare / riskPerShare : 0, 2)
  };
}

function validatePrices(price, stopLoss, targetPrice) {
  if (stopLoss >= price) {
    throw new Error('בפוזיציית Long, ה-Stop Loss חייב להיות נמוך ממחיר הקנייה.');
  }

  if (targetPrice <= price) {
    throw new Error('בפוזיציית Long, מחיר היעד חייב להיות גבוה ממחיר הקנייה.');
  }
}

function positiveNumber(value, fieldName) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${fieldName} חייב להיות מספר גדול מאפס.`);
  }
  return number;
}

function cleanText(value) {
  return String(value ?? '').trim();
}

function roundNumber(value, digits = 0) {
  const multiplier = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * multiplier) / multiplier;
}

function appendNote(oldNote, newNote) {
  const existing = cleanText(oldNote);
  const addition = cleanText(newNote);
  if (!addition) return existing;
  if (!existing) return addition;
  return `${existing}\n${addition}`;
}


function getMarketApiToken() {
  return cleanText(localStorage.getItem(MARKET_TOKEN_STORAGE_KEY));
}

function getMarketCache() {
  try {
    const parsed = JSON.parse(localStorage.getItem(MARKET_CACHE_STORAGE_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveMarketCache(cache) {
  try {
    localStorage.setItem(MARKET_CACHE_STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // Local storage may be blocked. The app still works without caching.
  }
}

function marketCacheKey(type, ticker) {
  return `${type}:${String(ticker || '').toUpperCase()}`;
}

function getCachedMarketItem(type, ticker, maxAge) {
  const cache = getMarketCache();
  const item = cache[marketCacheKey(type, ticker)];

  if (!item || !item.savedAt || Date.now() - item.savedAt > maxAge) {
    return null;
  }

  return item.data || null;
}

function setCachedMarketItem(type, ticker, data) {
  const cache = getMarketCache();
  cache[marketCacheKey(type, ticker)] = {
    savedAt: Date.now(),
    data
  };
  saveMarketCache(cache);
}

async function fetchFinnhub(endpoint, params = {}) {
  const token = getMarketApiToken();

  if (!token) {
    throw new Error('לא הוגדר מפתח Finnhub. לחץ על "הגדרת נתוני שוק".');
  }

  const url = new URL(`${FINNHUB_BASE_URL}${endpoint}`);
  Object.entries({ ...params, token }).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  });

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store'
  });

  if (response.status === 429) {
    throw new Error('חרגת זמנית ממכסת הבקשות של מקור המחירים. המתן מעט ונסה שוב.');
  }

  if (!response.ok) {
    throw new Error(`מקור המחירים החזיר שגיאה ${response.status}.`);
  }

  const data = await response.json();

  if (data && typeof data === 'object' && data.error) {
    throw new Error(data.error);
  }

  return data;
}

async function resolveTickerSymbol(query, force = false) {
  const normalized = cleanText(query).toUpperCase();
  if (!normalized) return null;

  const cacheKey = `resolve:${normalized}`;
  if (!force) {
    const cached = getCachedMarketItem('resolve', normalized, PROFILE_CACHE_MS);
    if (cached) return cached;
  }

  const data = await fetchFinnhub('/search', { q: normalized });
  const results = Array.isArray(data?.result) ? data.result : [];

  const exact = results.find(item =>
    String(item.displaySymbol || '').toUpperCase() === normalized ||
    String(item.symbol || '').toUpperCase() === normalized
  );

  const resolved = exact || results[0] || null;

  if (resolved) {
    setCachedMarketItem('resolve', normalized, resolved);
  }

  return resolved;
}

async function getTickerProfile(ticker, force = false) {
  const normalized = cleanText(ticker).toUpperCase();
  if (!normalized) return null;

  if (!force && marketProfiles.has(normalized)) {
    return marketProfiles.get(normalized);
  }

  if (!force) {
    const cached = getCachedMarketItem('profile', normalized, PROFILE_CACHE_MS);
    if (cached) {
      marketProfiles.set(normalized, cached);
      return cached;
    }
  }

  const profile = await fetchFinnhub('/stock/profile2', { symbol: normalized });

  if (profile && (profile.name || profile.ticker || profile.logo)) {
    const normalizedProfile = {
      ticker: cleanText(profile.ticker) || normalized,
      name: cleanText(profile.name),
      logo: cleanText(profile.logo),
      currency: cleanText(profile.currency) || 'USD',
      exchange: cleanText(profile.exchange),
      weburl: cleanText(profile.weburl)
    };

    marketProfiles.set(normalized, normalizedProfile);
    setCachedMarketItem('profile', normalized, normalizedProfile);
    return normalizedProfile;
  }

  return null;
}

async function getTickerQuote(ticker, force = false) {
  const normalized = cleanText(ticker).toUpperCase();
  if (!normalized) return null;

  if (!force && marketQuotes.has(normalized)) {
    const inMemory = marketQuotes.get(normalized);
    if (Date.now() - Number(inMemory.fetchedAt || 0) <= QUOTE_CACHE_MS) {
      return inMemory;
    }
  }

  if (!force) {
    const cached = getCachedMarketItem('quote', normalized, QUOTE_CACHE_MS);
    if (cached) {
      marketQuotes.set(normalized, cached);
      return cached;
    }
  }

  const quote = await fetchFinnhub('/quote', { symbol: normalized });
  const price = Number(quote?.c);

  if (!Number.isFinite(price) || price <= 0) {
    return null;
  }

  const normalizedQuote = {
    price,
    change: Number(quote?.d || 0),
    changePercent: Number(quote?.dp || 0),
    open: Number(quote?.o || 0),
    high: Number(quote?.h || 0),
    low: Number(quote?.l || 0),
    previousClose: Number(quote?.pc || 0),
    marketTimestamp: Number(quote?.t || 0) * 1000,
    fetchedAt: Date.now()
  };

  marketQuotes.set(normalized, normalizedQuote);
  setCachedMarketItem('quote', normalized, normalizedQuote);
  return normalizedQuote;
}

function mapFinnhubExchangeToTradingView(exchange, ticker = '') {
  const value = cleanText(exchange).toUpperCase();
  const normalizedTicker = cleanText(ticker).toUpperCase();

  if (value.includes('NASDAQ')) return 'NASDAQ';
  if (value.includes('NEW YORK STOCK EXCHANGE') || value === 'NYSE') return 'NYSE';
  if (value.includes('TEL AVIV') || value.includes('TASE')) return 'TASE';
  if (value.includes('NYSE ARCA') || value.includes('AMERICAN') || value === 'AMEX') return 'AMEX';
  if (value.includes('LONDON') || value === 'LSE') return 'LSE';
  if (['SPY', 'DIA', 'IWM', 'GLD', 'SLV'].includes(normalizedTicker)) return 'AMEX';
  return 'NASDAQ';
}

async function resolveMarketExchange(ticker) {
  const profile = await getTickerProfile(ticker, false);
  return mapFinnhubExchangeToTradingView(profile?.exchange, ticker);
}

async function getMarketExplorerSnapshot(ticker, force = false) {
  const normalized = cleanText(ticker).toUpperCase();
  if (!normalized) return { error: 'יש להזין טיקר תקין.' };

  const [profileResult, quoteResult] = await Promise.allSettled([
    getTickerProfile(normalized, force),
    getTickerQuote(normalized, force)
  ]);

  const profile = profileResult.status === 'fulfilled' ? profileResult.value : null;
  const quote = quoteResult.status === 'fulfilled' ? quoteResult.value : null;

  if (!profile && !quote) {
    const error = profileResult.status === 'rejected'
      ? profileResult.reason
      : quoteResult.status === 'rejected'
        ? quoteResult.reason
        : null;
    return { error: error?.message || 'לא ניתן לטעון כרגע את נתוני Finnhub.' };
  }

  return {
    ticker: normalized,
    profile,
    quote,
    exchangeCode: mapFinnhubExchangeToTradingView(profile?.exchange, normalized)
  };
}

function updateMarketStatus(message, state = '') {
  const textElement = document.getElementById('marketDataStatus');
  const dot = document.getElementById('marketStatusDot');

  if (textElement) textElement.textContent = message;
  if (dot) dot.className = `market-dot ${state}`.trim();
}

async function refreshMarketPrices(force = false) {
  if (marketRefreshInProgress) return;

  const token = getMarketApiToken();

  if (!token) {
    updateMarketStatus('לא הוגדר מקור מחירים — לחץ על הגדרת נתוני שוק');
    renderOpenPositions();
    renderPortfolioOverview();
    updatePortfolioSnapshotStatus('כדי לשמור את שווי הפוזיציות הפתוחות בצילום היומי יש להגדיר Finnhub API.', 'pending');
    return;
  }

  const tickers = [...new Set(
    appData.openPositions
      .map(position => cleanText(position.TICKER).toUpperCase())
      .filter(Boolean)
  )];

  if (!tickers.length) {
    updateMarketStatus('אין פוזיציות פתוחות לעדכון');
    renderPortfolioOverview();
    await persistPortfolioSnapshot();
    return;
  }

  marketRefreshInProgress = true;
  updateMarketStatus(`מעדכן ${tickers.length} טיקרים...`, 'loading');

  let successCount = 0;

  try {
    for (let index = 0; index < tickers.length; index += 1) {
      const ticker = tickers[index];

      try {
        const [quote, profile] = await Promise.all([
          getTickerQuote(ticker, force),
          getTickerProfile(ticker, false)
        ]);

        if (quote) successCount += 1;
        if (profile) marketProfiles.set(ticker, profile);
      } catch (error) {
        console.warn(`Market data failed for ${ticker}`, error);
      }

      if (index < tickers.length - 1) {
        await sleep(250);
      }
    }

    renderOpenPositions();
    renderPortfolioOverview();

    if (successCount) {
      updateMarketStatus(
        `עודכנו ${successCount}/${tickers.length} טיקרים · ${formatDateTime(Date.now())}`,
        'live'
      );
      await persistPortfolioSnapshot();
    } else {
      updateMarketStatus('לא התקבלו מחירים. בדוק את מפתח ה-API והטיקרים.', 'error');
      updatePortfolioSnapshotStatus('הצילום היומי לא נשמר משום שלא התקבלו מחירי שוק.', 'warning');
    }
  } finally {
    marketRefreshInProgress = false;
  }
}

function scheduleTickerLookup() {
  clearTimeout(tickerLookupTimer);
  resetTickerVerification();

  const ticker = cleanText(document.getElementById('ticker')?.value).toUpperCase();
  if (ticker.length < 1) {
    setTickerLookupState('idle');
    return;
  }

  tickerLookupTimer = setTimeout(() => {
    void lookupTickerForForm(false);
  }, 700);
}

function resetTickerVerification() {
  const fields = [
    'companyName',
    'companyLogo',
    'companyCurrency',
    'companyExchange',
    'tickerVerified'
  ];

  fields.forEach(id => {
    const element = document.getElementById(id);
    if (element) element.value = id === 'tickerVerified' ? 'false' : '';
  });
}

function setTickerLookupState(state, payload = {}) {
  const card = document.getElementById('tickerLookupCard');
  if (!card) return;

  const logo = cleanText(payload.logo);
  const title = cleanText(payload.title);
  const subtitle = cleanText(payload.subtitle);

  if (state === 'idle') {
    card.className = 'ticker-lookup-card';
    card.innerHTML = '';
    return;
  }

  card.className = `ticker-lookup-card show ${state === 'error' ? 'error' : state === 'loading' ? 'loading' : ''}`.trim();

  const logoHtml = logo
    ? `<img class="company-logo" src="${escapeHtml(logo)}" alt="" referrerpolicy="no-referrer" onerror="this.style.display='none'">`
    : `<div class="company-logo-placeholder">${escapeHtml((payload.ticker || '?').slice(0, 2))}</div>`;

  card.innerHTML = `
    ${logoHtml}
    <div class="ticker-lookup-details">
      <div class="ticker-lookup-title">${escapeHtml(title)}</div>
      <div class="ticker-lookup-subtitle">${escapeHtml(subtitle)}</div>
    </div>
  `;
}

async function lookupTickerForForm(force = true) {
  const tickerInput = document.getElementById('ticker');
  const requestedTicker = cleanText(tickerInput?.value).toUpperCase();

  if (!requestedTicker) {
    setTickerLookupState('error', {
      title: 'יש להזין טיקר',
      subtitle: 'לדוגמה: AAPL'
    });
    return null;
  }

  if (!getMarketApiToken()) {
    setTickerLookupState('error', {
      ticker: requestedTicker,
      title: 'לא הוגדר מפתח לנתוני שוק',
      subtitle: 'לחץ על "הגדרת נתוני שוק" בראש המסך'
    });
    return null;
  }

  const lookupId = `${requestedTicker}_${Date.now()}`;
  activeTickerLookup = lookupId;

  setTickerLookupState('loading', {
    ticker: requestedTicker,
    title: `בודק את ${requestedTicker}...`,
    subtitle: 'מחפש סימול, חברה ומחיר עדכני'
  });

  try {
    const resolved = await resolveTickerSymbol(requestedTicker, force);

    if (!resolved) {
      throw new Error('לא נמצא טיקר מתאים.');
    }

    const resolvedTicker = cleanText(resolved.symbol || resolved.displaySymbol).toUpperCase();
    const [profile, quote] = await Promise.all([
      getTickerProfile(resolvedTicker, force),
      getTickerQuote(resolvedTicker, force)
    ]);

    if (activeTickerLookup !== lookupId) return null;

    if (!profile && !quote) {
      throw new Error('הטיקר נמצא, אך לא התקבלו פרטי חברה או מחיר.');
    }

    if (tickerInput) tickerInput.value = resolvedTicker;

    const name = profile?.name || cleanText(resolved.description) || resolvedTicker;
    const currency = profile?.currency || 'USD';
    const priceText = quote
      ? `${formatMoneyCurrency(quote.price, currency)} · שינוי יומי ${formatSignedPercent(quote.changePercent)}`
      : 'לא התקבל מחיר נוכחי';

    const hiddenValues = {
      companyName: name,
      companyLogo: profile?.logo || '',
      companyCurrency: currency,
      companyExchange: profile?.exchange || '',
      tickerVerified: 'true'
    };

    Object.entries(hiddenValues).forEach(([id, value]) => {
      const element = document.getElementById(id);
      if (element) element.value = value;
    });

    setTickerLookupState('success', {
      ticker: resolvedTicker,
      logo: profile?.logo || '',
      title: `${name} (${resolvedTicker})`,
      subtitle: [
        profile?.exchange || '',
        priceText,
        quote?.marketTimestamp ? `מחיר לזמן ${formatDateTime(quote.marketTimestamp)}` : ''
      ].filter(Boolean).join(' · ')
    });

    updateOpenPreview();
    return { ticker: resolvedTicker, profile, quote };
  } catch (error) {
    if (activeTickerLookup !== lookupId) return null;

    resetTickerVerification();
    setTickerLookupState('error', {
      ticker: requestedTicker,
      title: 'לא הצלחנו לזהות את הטיקר',
      subtitle: error?.message || 'בדוק את הסימול ונסה שוב'
    });
    return null;
  }
}

function showMarketSettingsModal() {
  const currentToken = getMarketApiToken();

  openModal('הגדרת נתוני שוק', `
    <form id="marketSettingsForm" class="form-grid" onsubmit="saveMarketSettings(event)">
      <div class="field full">
        <label for="marketApiToken">Finnhub API Token</label>
        <input
          id="marketApiToken"
          name="marketApiToken"
          type="password"
          autocomplete="off"
          value="${escapeHtml(currentToken)}"
          placeholder="הדבק כאן את ה-API Token"
          required
        >
        <span class="help-text">המפתח נשמר רק בדפדפן הנוכחי באמצעות localStorage.</span>
      </div>
      <div class="field full">
        <div class="api-note">
          המערכת משתמשת ב-Finnhub לצורך זיהוי טיקר, פרטי חברה, לוגו ומחיר נוכחי.
          המחירים עשויים להיות מושהים ואינם מיועדים לביצוע פקודות מסחר.
          באתר ציבורי מומלץ להעביר את הקריאות לשרת או ל-Cloud Function כדי לא לחשוף את המפתח למשתמשי האתר.
        </div>
      </div>
    </form>
  `, `
    <button class="btn btn-secondary" onclick="closeModal()">ביטול</button>
    <button class="btn btn-primary" onclick="document.getElementById('marketSettingsForm').requestSubmit()">שמירה ובדיקה</button>
  `);
}

async function saveMarketSettings(event) {
  event.preventDefault();

  const token = cleanText(new FormData(event.target).get('marketApiToken'));

  if (!token) {
    showToast('יש להזין API Token.', 'error');
    return;
  }

  localStorage.setItem(MARKET_TOKEN_STORAGE_KEY, token);
  closeModal();
  showToast('מפתח נתוני השוק נשמר בדפדפן.', 'success');

  try {
    setLoading(true);
    await fetchFinnhub('/quote', { symbol: 'AAPL' });
    showToast('החיבור לנתוני השוק תקין.', 'success');
    await refreshMarketPrices(true);
  } catch (error) {
    updateMarketStatus('החיבור לנתוני השוק נכשל', 'error');
    showToast(error?.message || 'בדיקת החיבור נכשלה.', 'error');
  } finally {
    setLoading(false);
  }
}

function getPositionMarketView(position) {
  const ticker = cleanText(position.TICKER).toUpperCase();
  const quote = marketQuotes.get(ticker) || null;
  const profile = marketProfiles.get(ticker) || null;
  const currency = profile?.currency || position.COMPANY_CURRENCY || 'USD';
  const currentPrice = Number(quote?.price || 0);
  const averagePrice = Number(position.AVG_PRICE || 0);
  const quantity = Number(position.TOTAL_QTY || 0);
  const plDollar = currentPrice ? (currentPrice - averagePrice) * quantity : null;
  const plPercent = currentPrice && averagePrice
    ? (currentPrice / averagePrice - 1) * 100
    : null;

  return {
    ticker,
    quote,
    profile,
    currency,
    currentPrice,
    plDollar,
    plPercent
  };
}

function companyCell(position) {
  const market = getPositionMarketView(position);
  const logo = market.profile?.logo || position.COMPANY_LOGO || '';
  const companyName = market.profile?.name || position.COMPANY_NAME || '';

  const logoHtml = logo
    ? `<img class="company-logo" src="${escapeHtml(logo)}" alt="" referrerpolicy="no-referrer" onerror="this.style.display='none'">`
    : `<div class="company-logo-placeholder">${escapeHtml(market.ticker.slice(0, 2))}</div>`;

  return `
    <div class="ticker-cell">
      ${logoHtml}
      <div class="ticker-meta">
        ${tickerLink(market.ticker)}
        ${companyName ? `<span class="company-name" title="${escapeHtml(companyName)}">${escapeHtml(companyName)}</span>` : ''}
      </div>
    </div>
  `;
}

function currentPriceCell(position) {
  const market = getPositionMarketView(position);

  if (!market.quote) {
    return '<span class="neutral">לא זמין</span>';
  }

  return `
    <span class="quote-price">${formatMoneyCurrency(market.currentPrice, market.currency)}</span>
    <span class="${plClass(market.quote.change)}">${formatSignedPercent(market.quote.changePercent)} היום</span>
    <span class="quote-time">${formatDateTime(market.quote.marketTimestamp || market.quote.fetchedAt)}</span>
  `;
}

function livePlCell(position) {
  const market = getPositionMarketView(position);

  if (market.plDollar === null || market.plPercent === null) {
    return '<span class="neutral">ממתין למחיר</span>';
  }

  return `
    <span class="live-pl-card ${plClass(market.plDollar)}">
      <strong>${formatMoneyCurrency(market.plDollar, market.currency)}</strong>
      <small>${formatSignedPercent(market.plPercent)} מאז הקנייה</small>
    </span>
  `;
}

function daysHeld(openDate) {
  if (!openDate) return '';
  const start = new Date(`${String(openDate).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(start.getTime())) return '';
  const today = new Date();
  const diff = Math.max(0, Math.floor((today - start) / 86400000));
  return `${diff} ימים בפוזיציה`;
}

function formatMoneyCurrency(value, currency = 'USD') {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency || 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(Number(value || 0));
  } catch {
    return formatMoney(value);
  }
}

function formatSignedPercent(value) {
  const number = Number(value || 0);
  const prefix = number > 0 ? '+' : '';
  return `${prefix}${number.toFixed(2)}%`;
}

function formatDateTime(value) {
  const date = new Date(Number(value || 0));
  if (Number.isNaN(date.getTime()) || !Number(value)) return '—';

  return new Intl.DateTimeFormat('he-IL', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}


function friendlyFirebaseError(error) {
  const code = error?.code || '';

  const messages = {
    'auth/unauthorized-domain': 'הדומיין של האתר אינו מורשה ב-Firebase Authentication. הוסף אותו ל-Authorized domains.',
    'auth/popup-closed-by-user': 'חלון ההתחברות נסגר לפני השלמת הפעולה.',
    'auth/popup-blocked': 'הדפדפן חסם את חלון ההתחברות. אפשר חלונות קופצים ונסה שוב.',
    'permission-denied': 'Firestore חסם את הפעולה. בדוק שכללי האבטחה פורסמו ושהמשתמש מחובר.',
    'failed-precondition': 'Firestore עדיין לא הוגדר במלואו או שחסרה הגדרה נדרשת.'
  };

  return messages[code] || error?.message || String(error || 'שגיאה לא ידועה');
}



function allPositions() {
  return [...(appData.openPositions || []), ...(appData.closedPositions || [])];
}

function journalEntryForDate(date) {
  return (appData.journalEntries || []).find(entry =>
    String(entry.DATE || entry.JOURNAL_DATE || '').slice(0, 10) === String(date || '').slice(0, 10)
  ) || null;
}

function formatLongDate(value) {
  const date = new Date(`${String(value || '').slice(0, 10)}T12:00:00`);
  if (Number.isNaN(date.getTime())) return formatDate(value);
  return new Intl.DateTimeFormat('he-IL', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  }).format(date);
}

function setRatingValue(form, name, value) {
  if (!form) return;
  const input = form.querySelector(`input[name="${name}"][value="${Number(value)}"]`);
  if (input) input.checked = true;
}

function setFormAvailability(form, available) {
  if (!form) return;
  form.querySelectorAll('input, textarea, button').forEach(element => {
    if (element.type === 'hidden') return;
    element.disabled = !available;
  });
}

function todayPositionSummary(date) {
  const positions = allPositions().filter(position =>
    String(position.OPEN_DATE || '').slice(0, 10) === date
  );
  const closed = positions.filter(position => position.STATUS === 'CLOSED');
  const totalPl = closed.reduce((sum, position) => sum + Number(position.PL_DOLLAR || 0), 0);

  if (!positions.length) {
    return 'טרם נפתחו עסקאות בתאריך זה. עסקאות חדשות יקושרו אוטומטית לרשומה.';
  }

  if (!closed.length) {
    return `${positions.length} עסקאות נפתחו בתאריך זה. התוצאה תתווסף לניתוח לאחר סגירתן.`;
  }

  return `${positions.length} עסקאות נפתחו בתאריך זה, מתוכן ${closed.length} נסגרו. P/L ממומש: ${formatMoney(totalPl)}.`;
}

function renderTodayJournal() {
  const date = todayIso();
  const entry = journalEntryForDate(date);
  const dateLabel = document.getElementById('todayJournalDateLabel');
  const status = document.getElementById('todayJournalStatus');
  const statusText = status?.querySelector('.daily-journal-status-text');
  const trigger = document.getElementById('todayJournalTrigger');

  if (dateLabel) dateLabel.textContent = formatLongDate(date);

  if (entry) {
    if (statusText) statusText.textContent = 'השאלון היומי מולא';
    if (status) status.className = 'daily-journal-status completed';
    if (trigger) {
      trigger.classList.add('completed');
      trigger.setAttribute('aria-label', 'פתיחת השאלון היומי שמולא להיום');
    }
    return;
  }

  if (statusText) {
    statusText.textContent = currentUser ? 'טרם מולא שאלון יומי' : 'יש להתחבר כדי למלא';
  }

  if (status) {
    status.className = `daily-journal-status ${currentUser ? 'pending' : 'locked'}`;
  }

  if (trigger) {
    trigger.classList.remove('completed');
    trigger.setAttribute('aria-label', currentUser
      ? 'פתיחת השאלון היומי שטרם מולא'
      : 'פתיחת השאלון היומי והתחברות למערכת');
  }
}

function openTodayJournalModal() {
  const date = todayIso();
  const entry = journalEntryForDate(date);
  const formattedDate = formatLongDate(date);

  if (!currentUser) {
    openModal(
      'השאלון היומי',
      `
        <div class="journal-signin-prompt">
          <strong>${escapeHtml(formattedDate)}</strong>
          <p>יש להתחבר עם Google כדי למלא ולשמור את השאלון היומי.</p>
        </div>
      `,
      `
        <button class="btn btn-secondary" type="button" onclick="closeModal()">סגירה</button>
        <button class="btn btn-primary" type="button" onclick="closeModal(); toggleAuth();">התחברות עם Google</button>
      `
    );
    return;
  }

  const formBody = `
    <form id="todayJournalForm" class="journal-form modal-journal-form" onsubmit="submitTodayJournal(event)">
      <input id="todayJournalDate" name="date" type="hidden" value="${escapeHtml(date)}">

      <div class="journal-modal-intro">
        <span class="section-kicker">בדיקה יומית לפני המסחר</span>
        <p>מילוי קצר שמאפשר להשוות בהמשך בין המצב האישי לבין העסקאות שנפתחו היום.</p>
      </div>

      ${ratingFieldsetHtml('mood', 'מה מצב הרוח שלי לפני המסחר?', 'נמוך', 'גבוה', entry?.MOOD)}
      ${ratingFieldsetHtml('fatigue', 'מה רמת העייפות שלי?', 'ערני', 'עייף מאוד', entry?.FATIGUE)}
      ${ratingFieldsetHtml('dayQuality', 'איך היה היום שלי עד עכשיו?', 'קשה', 'מצוין', entry?.DAY_QUALITY)}

      <div class="field journal-notes-field">
        <label for="todayJournalNotes">הערה קצרה ליום</label>
        <textarea id="todayJournalNotes" name="notes" maxlength="600" placeholder="מחשבות, אירועים או משהו שכדאי לזכור לפני המסחר">${escapeHtml(entry?.NOTES || '')}</textarea>
      </div>

      <div id="todayTradeLinkSummary" class="journal-modal-trade-summary">
        ${escapeHtml(todayPositionSummary(date))}
      </div>
    </form>
  `;

  const footer = `
    <button class="btn btn-secondary" type="button" onclick="closeModal()">ביטול</button>
    <button id="todayJournalSaveButton" class="btn btn-primary" type="submit" form="todayJournalForm">
      ${entry ? 'עדכון השאלון' : 'שמירת השאלון'}
    </button>
  `;

  openModal(`השאלון היומי <span class="modal-title-date">${escapeHtml(formattedDate)}</span>`, formBody, footer);
}

function ratingFieldsetHtml(name, legend, lowCaption, highCaption, selectedValue = 0) {
  const options = [1, 2, 3, 4, 5].map(value => `
    <label>
      <input type="radio" name="${name}" value="${value}" ${Number(selectedValue) === value ? 'checked' : ''} required>
      <span>${value}</span>
    </label>
  `).join('');

  return `
    <fieldset class="rating-fieldset">
      <legend>${escapeHtml(legend)}</legend>
      <div class="rating-scale">${options}</div>
      <div class="rating-captions"><span>${escapeHtml(lowCaption)}</span><span>${escapeHtml(highCaption)}</span></div>
    </fieldset>
  `;
}

function journalEditorHtml(date, entry) {
  return `
    <form id="journalEditorForm" class="journal-form journal-editor-form" onsubmit="submitJournalEntry(event)">
      <input name="date" type="hidden" value="${escapeHtml(date)}">
      <div class="journal-editor-heading">
        <div>
          <span class="section-kicker">${entry ? 'עריכת רשומה' : 'רשומה חדשה'}</span>
          <h3>${escapeHtml(formatLongDate(date))}</h3>
        </div>
        <span class="journal-status ${entry ? 'completed' : ''}">${entry ? 'רשומה קיימת' : 'טרם מולא'}</span>
      </div>
      ${ratingFieldsetHtml('mood', 'מה היה מצב הרוח לפני המסחר?', 'נמוך', 'גבוה', entry?.MOOD)}
      ${ratingFieldsetHtml('fatigue', 'מה הייתה רמת העייפות?', 'ערני', 'עייף מאוד', entry?.FATIGUE)}
      ${ratingFieldsetHtml('dayQuality', 'איך היה היום עד אותו רגע?', 'קשה', 'מצוין', entry?.DAY_QUALITY)}
      <div class="field journal-notes-field">
        <label for="journalEditorNotes">הערה קצרה ליום</label>
        <textarea id="journalEditorNotes" name="notes" maxlength="600" placeholder="מחשבות, אירועים או משהו שכדאי לזכור">${escapeHtml(entry?.NOTES || '')}</textarea>
      </div>
      <div class="journal-form-footer">
        <p>${escapeHtml(todayPositionSummary(date))}</p>
        <button class="btn btn-primary" type="submit" ${currentUser ? '' : 'disabled'}>${entry ? 'עדכון הרשומה' : 'שמירת הרשומה'}</button>
      </div>
    </form>
  `;
}

function renderJournalHistory() {
  const container = document.getElementById('journalHistoryList');
  const count = document.getElementById('journalHistoryCount');
  if (!container) return;

  const entries = appData.journalEntries || [];
  if (count) count.textContent = `${entries.length} רשומות`;

  if (!currentUser) {
    container.innerHTML = '<div class="empty-state">יש להתחבר כדי להציג את רשומות היומן.</div>';
    return;
  }

  if (!entries.length) {
    container.innerHTML = '<div class="empty-state">עדיין לא נשמרו שאלונים יומיים.</div>';
    return;
  }

  const rows = buildJournalDailyRows(entries, allPositions());
  const rowByDate = new Map(rows.map(row => [row.date, row]));

  container.innerHTML = entries.map(entry => {
    const date = String(entry.DATE || entry.JOURNAL_DATE || '').slice(0, 10);
    const row = rowByDate.get(date);
    const pl = Number(row?.totalPl || 0);
    const tradeText = row?.openedTrades
      ? `${row.openedTrades} עסקאות נפתחו, ${row.closedTrades} נסגרו`
      : 'לא נפתחו עסקאות';

    return `
      <button class="journal-history-card" type="button" onclick="openJournalDate('${escapeJs(date)}')">
        <div class="journal-history-date">
          <strong>${escapeHtml(formatLongDate(date))}</strong>
          <span>${escapeHtml(tradeText)}</span>
        </div>
        <div class="journal-history-ratings">
          <span><small>מצב רוח</small><strong>${Number(entry.MOOD || 0)}/5</strong></span>
          <span><small>עייפות</small><strong>${Number(entry.FATIGUE || 0)}/5</strong></span>
          <span><small>איכות היום</small><strong>${Number(entry.DAY_QUALITY || 0)}/5</strong></span>
        </div>
        <div class="journal-history-result ${plClass(pl)}">
          <small>P/L של עסקאות מאותו יום</small>
          <strong>${row?.closedTrades ? formatMoney(pl) : 'טרם מומש'}</strong>
        </div>
        ${entry.NOTES ? `<p>${escapeHtml(entry.NOTES)}</p>` : ''}
      </button>
    `;
  }).join('');
}

function renderJournalPage(date = selectedJournalDate || todayIso()) {
  selectedJournalDate = date && date <= todayIso() ? date : todayIso();
  const picker = document.getElementById('journalDatePicker');
  const editor = document.getElementById('journalEditorContainer');

  if (picker) {
    picker.value = selectedJournalDate;
    picker.max = todayIso();
  }

  if (editor) {
    const entry = journalEntryForDate(selectedJournalDate);
    editor.innerHTML = journalEditorHtml(selectedJournalDate, entry);
    setFormAvailability(document.getElementById('journalEditorForm'), Boolean(currentUser));
  }

  renderJournalHistory();
}

function openJournalView() {
  selectedJournalDate = todayIso();
  renderJournalPage(selectedJournalDate);
  if (showWorkspaceView) showWorkspaceView('journal');
}

function loadSelectedJournalDate() {
  const picker = document.getElementById('journalDatePicker');
  const date = picker?.value || todayIso();
  if (date > todayIso()) {
    showToast('לא ניתן לפתוח רשומה לתאריך עתידי.', 'error');
    return;
  }
  renderJournalPage(date);
}

function openJournalDate(date) {
  selectedJournalDate = String(date || '').slice(0, 10) || todayIso();
  renderJournalPage(selectedJournalDate);
  if (showWorkspaceView) showWorkspaceView('journal');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function submitTodayJournal(event) {
  event.preventDefault();
  const data = formToObject(event.target);
  setLoading(true);

  try {
    await saveJournalEntry(data);
    closeModal();
    showToast('השאלון היומי נשמר.', 'success');
    await loadDashboard();
  } catch (error) {
    handleServerError(error);
  } finally {
    setLoading(false);
  }
}

async function submitJournalEntry(event) {
  event.preventDefault();
  const data = formToObject(event.target);
  setLoading(true);

  try {
    const result = await saveJournalEntry(data);
    selectedJournalDate = result.date;
    showToast('רשומת היומן נשמרה.', 'success');
    await loadDashboard();
    renderJournalPage(result.date);
  } catch (error) {
    handleServerError(error);
  } finally {
    setLoading(false);
  }
}


function portfolioNumber(record, ...keys) {
  for (const key of keys) {
    const value = Number(record?.[key]);
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

function getPortfolioLiveSummary() {
  const openPositions = appData.openPositions || [];
  const closedPositions = appData.closedPositions || [];
  const realizedPl = closedPositions.reduce((sum, position) => sum + Number(position.PL_DOLLAR || 0), 0);
  const openCostBasis = openPositions.reduce((sum, position) => (
    sum + Number(position.AVG_PRICE || 0) * Number(position.TOTAL_QTY || 0)
  ), 0);

  let unrealizedPl = 0;
  let openMarketValue = 0;
  let pricedOpenCount = 0;
  let latestQuoteAt = 0;

  openPositions.forEach(position => {
    const market = getPositionMarketView(position);
    const quantity = Number(position.TOTAL_QTY || 0);
    if (market.currentPrice > 0 && market.plDollar !== null) {
      unrealizedPl += Number(market.plDollar || 0);
      openMarketValue += market.currentPrice * quantity;
      pricedOpenCount += 1;
      latestQuoteAt = Math.max(latestQuoteAt, Number(market.quote?.fetchedAt || market.quote?.marketTimestamp || 0));
    }
  });

  const winningTrades = closedPositions.filter(position => Number(position.PL_DOLLAR || 0) > 0).length;

  return {
    realizedPl: roundNumber(realizedPl, 2),
    unrealizedPl: roundNumber(unrealizedPl, 2),
    totalPl: roundNumber(realizedPl + unrealizedPl, 2),
    openMarketValue: roundNumber(openMarketValue, 2),
    openCostBasis: roundNumber(openCostBasis, 2),
    openCount: openPositions.length,
    closedCount: closedPositions.length,
    pricedOpenCount,
    winRate: closedPositions.length ? roundNumber(winningTrades / closedPositions.length * 100, 2) : 0,
    latestQuoteAt,
    hasCompleteOpenPricing: !openPositions.length || pricedOpenCount === openPositions.length
  };
}

function setPortfolioMoney(id, value, include = true) {
  const element = document.getElementById(id);
  if (!element) return;
  element.classList.remove('positive', 'negative', 'neutral');
  if (!include) {
    element.textContent = 'לא נכלל';
    element.classList.add('neutral');
    return;
  }
  element.textContent = formatMoney(value);
  element.classList.add(plClass(value));
}

function updatePortfolioSnapshotStatus(message, state = '') {
  const element = document.getElementById('portfolioSnapshotStatus');
  if (!element) return;
  element.textContent = message;
  element.className = `portfolio-snapshot-status ${state}`.trim();
}

function setPortfolioMode(mode) {
  selectedPortfolioMode = ['closed', 'all', 'open'].includes(mode) ? mode : 'closed';
  if (selectedPortfolioMode === 'closed') portfolioSeriesVisibility.realized = true;
  if (selectedPortfolioMode === 'open') portfolioSeriesVisibility.total = true;
  renderPortfolioOverview();
}

function togglePortfolioSeries(series) {
  if (!Object.prototype.hasOwnProperty.call(portfolioSeriesVisibility, series)) return;
  const currentlyVisible = Object.values(portfolioSeriesVisibility).filter(Boolean).length;
  if (portfolioSeriesVisibility[series] && currentlyVisible === 1) {
    showToast('יש להשאיר לפחות קו אחד פעיל בגרף.', 'error');
    return;
  }
  portfolioSeriesVisibility[series] = !portfolioSeriesVisibility[series];
  renderPortfolioTrendChart(getPortfolioLiveSummary());
}

function portfolioModeConfig() {
  const configs = {
    closed: {
      title: 'פוזיציות סגורות בלבד',
      description: 'המדדים והטבלה מבוססים על תוצאות שמומשו בפועל.',
      tableTitle: 'פוזיציות סגורות',
      tableSubtitle: 'תוצאות שמומשו בפועל'
    },
    all: {
      title: 'תמונה מלאה כולל פוזיציות פתוחות',
      description: 'הרווח הכולל משלב תוצאות ממומשות עם מחירי השוק האחרונים.',
      tableTitle: 'כל הפוזיציות',
      tableSubtitle: 'פתוחות וסגורות ברשימה אחת'
    },
    open: {
      title: 'פוזיציות פתוחות בלבד',
      description: 'תצוגה חיה של החשיפה והרווח או ההפסד שטרם מומשו.',
      tableTitle: 'פוזיציות פתוחות',
      tableSubtitle: 'מחירי השוק והרווח הנוכחי'
    }
  };
  return configs[selectedPortfolioMode] || configs.closed;
}

function renderPortfolioOverview() {
  const root = document.querySelector('[data-view="portfolio"]');
  if (!root) return;

  const summary = getPortfolioLiveSummary();
  const config = portfolioModeConfig();
  const includesClosed = selectedPortfolioMode !== 'open';
  const includesOpen = selectedPortfolioMode !== 'closed';

  document.querySelectorAll('[data-portfolio-mode]').forEach(button => {
    const active = button.dataset.portfolioMode === selectedPortfolioMode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });

  const title = document.getElementById('portfolioModeTitle');
  const description = document.getElementById('portfolioModeDescription');
  if (title) title.textContent = config.title;
  if (description) description.textContent = config.description;

  setPortfolioMoney('portfolioRealizedPl', summary.realizedPl, includesClosed);
  setPortfolioMoney('portfolioUnrealizedPl', summary.unrealizedPl, includesOpen);
  setPortfolioMoney(
    'portfolioTotalPl',
    selectedPortfolioMode === 'closed'
      ? summary.realizedPl
      : selectedPortfolioMode === 'open'
        ? summary.unrealizedPl
        : summary.totalPl,
    true
  );
  setPortfolioMoney('portfolioOpenValue', summary.openMarketValue, includesOpen);
  setPortfolioMoney('portfolioExposure', summary.openMarketValue, includesOpen);

  const openCost = document.getElementById('portfolioOpenCost');
  if (openCost) openCost.textContent = includesOpen ? `עלות בסיס ${formatMoney(summary.openCostBasis)}` : 'לא נכלל במצב הנוכחי';

  const coverage = document.getElementById('portfolioQuoteCoverage');
  if (coverage) {
    coverage.textContent = includesOpen
      ? `${summary.pricedOpenCount} מתוך ${summary.openCount} פוזיציות מתומחרות`
      : 'לא נכלל במצב הנוכחי';
  }

  const values = {
    portfolioOpenCount: summary.openCount,
    portfolioClosedCount: summary.closedCount,
    portfolioWinRate: formatPercent(summary.winRate)
  };
  Object.entries(values).forEach(([id, value]) => {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
  });

  const updated = document.getElementById('portfolioUpdatedAt');
  if (updated) {
    if (summary.latestQuoteAt) {
      updated.textContent = `מחירי שוק עודכנו ${formatDateTime(summary.latestQuoteAt)}`;
    } else if (summary.openCount) {
      updated.textContent = 'מחירי הפוזיציות הפתוחות טרם נטענו';
    } else {
      updated.textContent = 'אין פוזיציות פתוחות לתמחור';
    }
  }

  renderPortfolioTrendChart(summary);
  renderPortfolioPositionsTable(summary);
}

function buildPortfolioTrendRows(summary) {
  const closedByDate = new Map();
  (appData.closedPositions || []).forEach(position => {
    const date = String(position.CLOSE_DATE || position.OPEN_DATE || '').slice(0, 10);
    if (!date) return;
    closedByDate.set(date, (closedByDate.get(date) || 0) + Number(position.PL_DOLLAR || 0));
  });

  const snapshotByDate = new Map();
  (appData.portfolioSnapshots || []).forEach(snapshot => {
    const date = String(snapshot.DATE || snapshot.SNAPSHOT_DATE || '').slice(0, 10);
    if (date) snapshotByDate.set(date, snapshot);
  });

  const dates = [...new Set([...closedByDate.keys(), ...snapshotByDate.keys()])].sort();
  if (!dates.length && ((appData.closedPositions || []).length || (appData.openPositions || []).length)) {
    dates.push(todayIso());
  }

  let runningRealized = 0;
  const rows = dates.map(date => {
    runningRealized += Number(closedByDate.get(date) || 0);
    const snapshot = snapshotByDate.get(date);
    const snapshotRealized = snapshot
      ? portfolioNumber(snapshot, 'REALIZED_PL', 'realizedPl', 'realizedProfit')
      : runningRealized;
    const snapshotTotal = snapshot
      ? portfolioNumber(snapshot, 'TOTAL_PL', 'totalPl', 'totalProfit')
      : null;
    const snapshotUnrealized = snapshot
      ? portfolioNumber(snapshot, 'UNREALIZED_PL', 'unrealizedPl', 'unrealizedProfit')
      : null;
    return {
      date,
      realized: roundNumber(snapshotRealized, 2),
      total: snapshot ? roundNumber(snapshotTotal, 2) : null,
      unrealized: snapshot ? roundNumber(snapshotUnrealized, 2) : null
    };
  });

  const today = todayIso();
  const currentRow = rows.find(row => row.date === today);
  if (currentRow) {
    currentRow.realized = summary.realizedPl;
    if (summary.hasCompleteOpenPricing) {
      currentRow.total = summary.totalPl;
      currentRow.unrealized = summary.unrealizedPl;
    }
  } else if (rows.length || summary.realizedPl || summary.openCount) {
    rows.push({
      date: today,
      realized: summary.realizedPl,
      total: summary.hasCompleteOpenPricing ? summary.totalPl : null,
      unrealized: summary.hasCompleteOpenPricing ? summary.unrealizedPl : null
    });
  }

  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

function portfolioChartPath(points) {
  return points.map((point, index) => `${index ? 'L' : 'M'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' ');
}

function renderPortfolioTrendChart(summary) {
  const container = document.getElementById('portfolioTrendChart');
  if (!container) return;

  const realizedLegend = document.getElementById('portfolioRealizedLegend');
  const totalLegend = document.getElementById('portfolioTotalLegend');
  const totalLegendLabel = document.getElementById('portfolioTotalLegendLabel');
  if (realizedLegend) {
    realizedLegend.classList.toggle('active', portfolioSeriesVisibility.realized);
    realizedLegend.classList.toggle('unavailable', selectedPortfolioMode === 'open');
    realizedLegend.disabled = selectedPortfolioMode === 'open';
  }
  if (totalLegend) {
    totalLegend.classList.toggle('active', portfolioSeriesVisibility.total);
    totalLegend.classList.toggle('unavailable', selectedPortfolioMode === 'closed');
    totalLegend.disabled = selectedPortfolioMode === 'closed';
  }
  if (totalLegendLabel) totalLegendLabel.textContent = selectedPortfolioMode === 'open' ? 'פתוחות בלבד' : 'כולל פתוחות';

  const subtitle = document.getElementById('portfolioChartSubtitle');
  if (subtitle) {
    subtitle.textContent = selectedPortfolioMode === 'closed'
      ? 'מגמת הרווח הממומש לפי מועד סגירת העסקאות.'
      : selectedPortfolioMode === 'open'
        ? 'מגמת הרווח הלא ממומש מתוך הצילומים היומיים של הפוזיציות הפתוחות.'
        : 'הקו הממומש מבוסס על עסקאות סגורות והקו הכולל משלב את הפוזיציות הפתוחות.';
  }

  const rows = buildPortfolioTrendRows(summary);
  if (!rows.length) {
    container.innerHTML = '<div class="empty-state">לאחר סגירת עסקה או טעינת פוזיציה פתוחה תוצג כאן מגמת התיק.</div>';
    return;
  }

  const showRealized = portfolioSeriesVisibility.realized && selectedPortfolioMode !== 'open';
  const showTotal = portfolioSeriesVisibility.total && selectedPortfolioMode !== 'closed';
  const secondaryKey = selectedPortfolioMode === 'open' ? 'unrealized' : 'total';
  const availableValues = [];
  if (showRealized) rows.forEach(row => availableValues.push(row.realized));
  if (showTotal) rows.forEach(row => { if (row[secondaryKey] !== null) availableValues.push(row[secondaryKey]); });

  if (!availableValues.length) {
    container.innerHTML = '<div class="empty-state">אין עדיין מספיק מחירי שוק ליצירת קו התיק הכולל.</div>';
    return;
  }

  const width = 960;
  const height = 320;
  const padding = { top: 24, right: 24, bottom: 52, left: 72 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  let minValue = Math.min(0, ...availableValues);
  let maxValue = Math.max(0, ...availableValues);
  if (minValue === maxValue) {
    minValue -= 1;
    maxValue += 1;
  }
  const span = maxValue - minValue;
  const xAt = index => padding.left + (rows.length === 1 ? plotWidth / 2 : index / (rows.length - 1) * plotWidth);
  const yAt = value => padding.top + (maxValue - value) / span * plotHeight;

  const realizedPoints = rows.map((row, index) => ({ x: xAt(index), y: yAt(row.realized), value: row.realized, date: row.date }));
  const totalPoints = rows
    .map((row, index) => row[secondaryKey] === null ? null : ({ x: xAt(index), y: yAt(row[secondaryKey]), value: row[secondaryKey], date: row.date }))
    .filter(Boolean);

  const tickValues = Array.from({ length: 5 }, (_, index) => maxValue - index * span / 4);
  const labelStep = Math.max(1, Math.ceil(rows.length / 6));
  const dateLabels = rows.map((row, index) => ({ row, index })).filter(({ index }) => index % labelStep === 0 || index === rows.length - 1);
  const zeroY = yAt(0);

  const grid = tickValues.map(value => {
    const y = yAt(value);
    return `<g><line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" class="portfolio-grid-line"/><text x="${padding.left - 12}" y="${y + 4}" text-anchor="end" class="portfolio-axis-label">${escapeHtml(formatMoney(value))}</text></g>`;
  }).join('');

  const labels = dateLabels.map(({ row, index }) => `<text x="${xAt(index)}" y="${height - 18}" text-anchor="middle" class="portfolio-axis-label">${escapeHtml(formatDate(row.date).replace(/\/\d{4}$/, ''))}</text>`).join('');
  const realizedPath = showRealized && realizedPoints.length
    ? `<path d="${portfolioChartPath(realizedPoints)}" class="portfolio-chart-path realized"/>${realizedPoints.map(point => `<circle cx="${point.x}" cy="${point.y}" r="4" class="portfolio-chart-point realized"><title>${escapeHtml(formatDate(point.date))}: ${escapeHtml(formatMoney(point.value))}</title></circle>`).join('')}`
    : '';
  const totalPath = showTotal && totalPoints.length
    ? `<path d="${portfolioChartPath(totalPoints)}" class="portfolio-chart-path total"/>${totalPoints.map(point => `<circle cx="${point.x}" cy="${point.y}" r="4" class="portfolio-chart-point total"><title>${escapeHtml(formatDate(point.date))}: ${escapeHtml(formatMoney(point.value))}</title></circle>`).join('')}`
    : '';

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="גרף מגמת רווח התיק">
      ${grid}
      <line x1="${padding.left}" y1="${zeroY}" x2="${width - padding.right}" y2="${zeroY}" class="portfolio-zero-line"/>
      ${realizedPath}
      ${totalPath}
      ${labels}
    </svg>
  `;
}

function portfolioHoldingPeriod(position) {
  const startValue = String(position.OPEN_DATE || '').slice(0, 10);
  const endValue = String(position.STATUS === 'CLOSED' ? position.CLOSE_DATE : todayIso()).slice(0, 10);
  const start = new Date(`${startValue}T12:00:00`);
  const end = new Date(`${endValue}T12:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return '—';
  const days = Math.max(0, Math.round((end - start) / 86400000));
  return days === 1 ? 'יום אחד' : `${days} ימים`;
}

function portfolioOpenRow(position) {
  const market = getPositionMarketView(position);
  const plAvailable = market.plDollar !== null && market.plPercent !== null;
  return {
    sortDate: String(position.OPEN_DATE || ''),
    html: `
      <tr>
        <td data-label="טיקר">${companyCell(position)}</td>
        <td data-label="סטטוס"><span class="portfolio-status-badge open">פתוחה</span></td>
        <td data-label="תאריך">${formatDate(position.OPEN_DATE)}</td>
        <td data-label="כמות" class="number">${formatQuantity(position.TOTAL_QTY)}</td>
        <td data-label="מחיר כניסה" class="number">${formatMoneyCurrency(position.AVG_PRICE, market.currency)}</td>
        <td data-label="מחיר נוכחי / יציאה" class="number">${market.currentPrice ? formatMoneyCurrency(market.currentPrice, market.currency) : '<span class="neutral">לא נטען</span>'}</td>
        <td data-label="P/L" class="number ${plAvailable ? plClass(market.plDollar) : 'neutral'}">${plAvailable ? formatMoneyCurrency(market.plDollar, market.currency) : 'ממתין למחיר'}</td>
        <td data-label="תשואה" class="number ${plAvailable ? plClass(market.plPercent) : 'neutral'}">${plAvailable ? formatSignedPercent(market.plPercent) : '—'}</td>
        <td data-label="משך החזקה">${escapeHtml(portfolioHoldingPeriod(position))}</td>
      </tr>`
  };
}

function portfolioClosedRow(position) {
  const pl = Number(position.PL_DOLLAR || 0);
  const currency = position.COMPANY_CURRENCY || 'USD';
  return {
    sortDate: String(position.CLOSE_DATE || position.OPEN_DATE || ''),
    html: `
      <tr>
        <td data-label="טיקר">${companyCell(position)}</td>
        <td data-label="סטטוס"><span class="portfolio-status-badge closed">סגורה</span></td>
        <td data-label="תאריך">${formatDate(position.OPEN_DATE)}<br><small>עד ${formatDate(position.CLOSE_DATE)}</small></td>
        <td data-label="כמות" class="number">${formatQuantity(position.TOTAL_QTY)}</td>
        <td data-label="מחיר כניסה" class="number">${formatMoneyCurrency(position.AVG_PRICE, currency)}</td>
        <td data-label="מחיר נוכחי / יציאה" class="number">${formatMoneyCurrency(position.EXIT_PRICE, currency)}</td>
        <td data-label="P/L" class="number ${plClass(pl)}">${formatMoneyCurrency(pl, currency)}</td>
        <td data-label="תשואה" class="number ${plClass(position.PL_PERCENT)}">${formatSignedPercent(position.PL_PERCENT)}</td>
        <td data-label="משך החזקה">${escapeHtml(portfolioHoldingPeriod(position))}</td>
      </tr>`
  };
}

function renderPortfolioPositionsTable() {
  const container = document.getElementById('portfolioPositionsContainer');
  if (!container) return;

  const config = portfolioModeConfig();
  const title = document.getElementById('portfolioTableTitle');
  const subtitle = document.getElementById('portfolioTableSubtitle');
  if (title) title.textContent = config.tableTitle;
  if (subtitle) subtitle.textContent = config.tableSubtitle;

  let rows = [];
  if (selectedPortfolioMode !== 'open') rows.push(...(appData.closedPositions || []).map(portfolioClosedRow));
  if (selectedPortfolioMode !== 'closed') rows.push(...(appData.openPositions || []).map(portfolioOpenRow));
  rows.sort((a, b) => b.sortDate.localeCompare(a.sortDate));

  const count = document.getElementById('portfolioTableCount');
  if (count) count.textContent = `${rows.length} פוזיציות`;

  if (!rows.length) {
    const message = selectedPortfolioMode === 'open'
      ? 'אין כרגע פוזיציות פתוחות.'
      : selectedPortfolioMode === 'closed'
        ? 'עדיין אין פוזיציות סגורות.'
        : 'עדיין לא נשמרו פוזיציות.';
    container.innerHTML = `<div class="empty-state">${message}</div>`;
    return;
  }

  container.innerHTML = `
    <table>
      <thead><tr><th>טיקר</th><th>סטטוס</th><th>תאריך</th><th>כמות</th><th>מחיר כניסה</th><th>מחיר נוכחי / יציאה</th><th>P/L</th><th>תשואה</th><th>משך החזקה</th></tr></thead>
      <tbody>${rows.map(row => row.html).join('')}</tbody>
    </table>`;
}

async function persistPortfolioSnapshot() {
  if (!currentUser || !db) return;
  const summary = getPortfolioLiveSummary();

  if (!summary.hasCompleteOpenPricing) {
    updatePortfolioSnapshotStatus(`הצילום היומי ממתין למחירים עבור ${summary.openCount - summary.pricedOpenCount} פוזיציות פתוחות.`, 'pending');
    return;
  }

  const date = todayIso();
  const payload = {
    DATE: date,
    REALIZED_PL: summary.realizedPl,
    UNREALIZED_PL: summary.unrealizedPl,
    TOTAL_PL: summary.totalPl,
    OPEN_MARKET_VALUE: summary.openMarketValue,
    OPEN_COST_BASIS: summary.openCostBasis,
    OPEN_POSITIONS_COUNT: summary.openCount,
    PRICED_OPEN_POSITIONS: summary.pricedOpenCount,
    CLIENT_UPDATED_AT: Date.now(),
    UPDATED_AT: serverTimestamp()
  };

  try {
    await setDoc(portfolioSnapshotDocument(date), payload, { merge: true });
    const localSnapshot = { ...payload, SNAPSHOT_DATE: date };
    appData.portfolioSnapshots = [
      ...(appData.portfolioSnapshots || []).filter(snapshot => String(snapshot.DATE || snapshot.SNAPSHOT_DATE || '').slice(0, 10) !== date),
      localSnapshot
    ].sort((a, b) => String(a.DATE || '').localeCompare(String(b.DATE || '')));
    updatePortfolioSnapshotStatus(`הצילום היומי נשמר עבור ${formatDate(date)}.`, 'saved');
    renderPortfolioTrendChart(summary);
  } catch (error) {
    console.warn('Portfolio snapshot could not be saved.', error);
    updatePortfolioSnapshotStatus('לא ניתן לשמור צילום יומי. ייתכן שיש לעדכן הרשאה לאוסף portfolioSnapshots.', 'warning');
    if (!portfolioSnapshotPermissionWarningShown) {
      portfolioSnapshotPermissionWarningShown = true;
    }
  }
}

async function refreshPortfolioOverview() {
  if (!currentUser || !db) {
    showToast('יש להתחבר עם Google כדי לרענן את תמונת המצב.', 'error');
    return;
  }
  if ((appData.openPositions || []).length && getMarketApiToken()) {
    await refreshMarketPrices(true);
  } else {
    renderPortfolioOverview();
    await persistPortfolioSnapshot();
  }
}

function renderDashboard() {
      document.getElementById('closedCount').textContent = appData.stats.closedCount || 0;
      document.getElementById('winRate').textContent = formatPercent(appData.stats.winRate || 0);

      const totalPlElement = document.getElementById('totalPl');
      const totalPl = Number(appData.stats.totalPl || 0);
      totalPlElement.textContent = formatMoney(totalPl);
      totalPlElement.className = 'stat-value ' + plClass(totalPl);

      const averageTradeElement = document.getElementById('dashboardAvgTrade');
      const averageTrade = Number(appData.stats.averageTrade || 0);
      if (averageTradeElement) {
        averageTradeElement.textContent = formatMoney(averageTrade);
        averageTradeElement.className = 'stat-value ' + plClass(averageTrade);
      }

      renderOpenPositions();
      renderClosedPositions();
      renderTodayJournal();
    }

    function renderOpenPositions() {
      const container = document.getElementById('openPositionsContainer');
      if (!appData.openPositions.length) {
        container.innerHTML = '<div class="empty-state">אין כרגע פוזיציות פתוחות.</div>';
        return;
      }

      container.innerHTML = `
        <table>
          <thead>
            <tr>
              <th>טיקר</th>
              <th>תאריך פתיחה</th>
              <th>תבנית</th>
              <th>כיוון השוק</th>
              <th>כמות</th>
              <th>מחיר ממוצע</th>
              <th>מחיר נוכחי</th>
              <th>P/L נוכחי</th>
              <th>Stop Loss</th>
              <th>יעד</th>
              <th>סיכון</th>
              <th>פוטנציאל</th>
              <th>R/R</th>
              <th>פעולות</th>
            </tr>
          </thead>
          <tbody>
            ${appData.openPositions.map(position => `
              <tr>
                <td data-label="טיקר">${companyCell(position)}</td>
                <td data-label="תאריך פתיחה">
                  ${formatDate(position.OPEN_DATE)}
                  <br><small class="neutral">${escapeHtml(daysHeld(position.OPEN_DATE))}</small>
                </td>
                <td data-label="תבנית">${escapeHtml(position.PATTERN || '')}</td>
                <td data-label="כיוון השוק"><span class="badge ${position.MARKET_DIRECTION === 'עולה' ? 'badge-up' : 'badge-down'}">${escapeHtml(position.MARKET_DIRECTION || '')}</span></td>
                <td data-label="כמות" class="number">${formatQuantity(position.TOTAL_QTY)}</td>
                <td data-label="מחיר ממוצע" class="number">${formatMoneyCurrency(position.AVG_PRICE, position.COMPANY_CURRENCY || 'USD')}</td>
                <td data-label="מחיר נוכחי" class="number">${currentPriceCell(position)}</td>
                <td data-label="P/L נוכחי" class="number">${livePlCell(position)}</td>
                <td data-label="Stop Loss" class="number">${formatMoneyCurrency(position.STOP_LOSS, position.COMPANY_CURRENCY || 'USD')}</td>
                <td data-label="יעד" class="number">${formatMoneyCurrency(position.TARGET_PRICE, position.COMPANY_CURRENCY || 'USD')}</td>
                <td data-label="סיכון" class="number">${formatMoneyCurrency(position.PLANNED_RISK_DOLLAR, position.COMPANY_CURRENCY || 'USD')}<br><small>${formatPercent(position.PLANNED_RISK_PERCENT)}</small></td>
                <td data-label="פוטנציאל" class="number positive">${formatMoneyCurrency(position.POTENTIAL_DOLLAR, position.COMPANY_CURRENCY || 'USD')}<br><small>${formatPercent(position.POTENTIAL_PERCENT)}</small></td>
                <td data-label="R/R" class="number">1:${formatNumber(position.RISK_REWARD)}</td>
                <td data-label="פעולות" class="trade-actions-cell">
                  <div class="button-row">
                    <button class="btn btn-secondary btn-small" onclick="showAddModal('${escapeJs(position.POSITION_ID)}')">הוספה</button>
                    <button class="btn btn-danger btn-small" onclick="showCloseModal('${escapeJs(position.POSITION_ID)}')">סגירה</button>
                  </div>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;
    }

    function renderClosedPositions() {
      const container = document.getElementById('closedPositionsContainer');
      if (!appData.closedPositions.length) {
        container.innerHTML = '<div class="empty-state">עדיין אין עסקאות סגורות.</div>';
        return;
      }

      container.innerHTML = `
        <table>
          <thead>
            <tr>
              <th>טיקר</th><th>תקופה</th><th>תבנית</th><th>כיוון השוק</th>
              <th>כמות</th><th>מחיר ממוצע</th><th>מחיר מכירה</th>
              <th>סיכון מתוכנן</th><th>פוטנציאל מתוכנן</th><th>R/R</th>
              <th>P/L בפועל</th><th>פעולות</th>
            </tr>
          </thead>
          <tbody>
            ${appData.closedPositions.map(position => {
              const pl = Number(position.PL_DOLLAR || 0);
              return `
                <tr>
                  <td data-label="טיקר">${companyCell(position)}</td>
                  <td data-label="תקופה">${formatDate(position.OPEN_DATE)}<br><small>עד ${formatDate(position.CLOSE_DATE)}</small></td>
                  <td data-label="תבנית">${escapeHtml(position.PATTERN || '')}</td>
                  <td data-label="כיוון השוק"><span class="badge ${position.MARKET_DIRECTION === 'עולה' ? 'badge-up' : 'badge-down'}">${escapeHtml(position.MARKET_DIRECTION || '')}</span></td>
                  <td data-label="כמות" class="number">${formatQuantity(position.TOTAL_QTY)}</td>
                  <td data-label="מחיר ממוצע" class="number">${formatMoney(position.AVG_PRICE)}</td>
                  <td data-label="מחיר מכירה" class="number">${formatMoney(position.EXIT_PRICE)}</td>
                  <td data-label="סיכון מתוכנן" class="number negative">${formatMoney(position.PLANNED_RISK_DOLLAR)}<br><small>${formatPercent(position.PLANNED_RISK_PERCENT)}</small></td>
                  <td data-label="פוטנציאל מתוכנן" class="number positive">${formatMoney(position.POTENTIAL_DOLLAR)}<br><small>${formatPercent(position.POTENTIAL_PERCENT)}</small></td>
                  <td data-label="R/R" class="number">1:${formatNumber(position.RISK_REWARD)}</td>
                  <td data-label="P/L בפועל" class="number ${plClass(pl)}">${formatMoney(pl)}<br><small>${formatPercent(position.PL_PERCENT)}</small></td>
                  <td data-label="פעולות" class="trade-actions-cell">
                    <button
                      class="btn btn-danger btn-small"
                      onclick="showDeletePositionModal('${escapeJs(position.POSITION_ID)}')"
                    >מחיקה</button>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      `;
    }


    function showDeletePositionModal(positionId) {
      const position = appData.closedPositions.find(item =>
        item.POSITION_ID === positionId
      );

      if (!position) {
        showToast('הפוזיציה הסגורה לא נמצאה.', 'error');
        return;
      }

      const ticker = escapeHtml(position.TICKER || 'ללא טיקר');
      const period = `${formatDate(position.OPEN_DATE)} עד ${formatDate(position.CLOSE_DATE)}`;

      openModal(`מחיקת פוזיציית ${ticker}`, `
        <div class="form-grid">
          <div class="delete-warning">
            <strong>שים לב: זו מחיקה לצמיתות.</strong><br>
            הפוזיציה ${ticker}, וכל פעולות הפתיחה, ההוספה והסגירה המקושרות אליה,
            יימחקו מ-Firebase ולא יהיה ניתן לשחזר אותן מתוך המערכת.<br><br>
            תקופת העסקה: ${escapeHtml(period)}
          </div>

          <label class="danger-check" for="deletePositionConfirmation">
            <input
              id="deletePositionConfirmation"
              type="checkbox"
              onchange="toggleDeletePositionButton()"
            >
            <span>אני מבין שהפעולה אינה ניתנת לשחזור ורוצה להמשיך למחיקה.</span>
          </label>
        </div>
      `, `
        <button class="btn btn-secondary" onclick="closeModal()">ביטול</button>
        <button
          id="deletePositionButton"
          class="btn btn-danger"
          onclick="confirmDeletePosition('${escapeJs(position.POSITION_ID)}')"
          disabled
        >המשך למחיקה</button>
      `);
    }

    function toggleDeletePositionButton() {
      const checkbox = document.getElementById('deletePositionConfirmation');
      const button = document.getElementById('deletePositionButton');

      if (button) {
        button.disabled = !checkbox?.checked;
      }
    }

    async function confirmDeletePosition(positionId) {
      const checkbox = document.getElementById('deletePositionConfirmation');

      if (!checkbox?.checked) {
        showToast('יש לאשר שהמחיקה אינה ניתנת לשחזור.', 'error');
        return;
      }

      const position = appData.closedPositions.find(item =>
        item.POSITION_ID === positionId
      );

      if (!position) {
        showToast('הפוזיציה הסגורה לא נמצאה.', 'error');
        return;
      }

      const ticker = position.TICKER || 'הפוזיציה';
      const finalApproval = window.confirm(
        `בדיקה אחרונה: האם למחוק לצמיתות את ${ticker}?\n\n` +
        'הפוזיציה וכל היסטוריית הפעולות שלה יימחקו ולא ניתן יהיה לשחזר אותם.'
      );

      if (!finalApproval) return;

      setLoading(true);

      try {
        const result = await deleteClosedPosition(positionId);
        closeModal();
        showToast(
          `הפוזיציה נמחקה לצמיתות יחד עם ${result.deletedTransactions} פעולות מקושרות.`,
          'success'
        );
        await loadDashboard();
      } catch (error) {
        handleServerError(error);
      } finally {
        setLoading(false);
      }
    }

    function showOpenPositionModal() {
      if (!requireUser()) return;
      const today = todayIso();

      openModal('פתיחת פוזיציה חדשה', `
        <form id="openPositionForm" class="form-grid" onsubmit="submitOpenPosition(event)">
          <div class="field">
            <label for="ticker">טיקר</label>
            <div class="inline-field-row">
              <input
                id="ticker"
                name="ticker"
                maxlength="20"
                required
                placeholder="לדוגמה AAPL"
                oninput="this.value=this.value.toUpperCase(); scheduleTickerLookup()"
                onblur="lookupTickerForForm(false)"
              >
              <button type="button" class="btn btn-secondary" onclick="lookupTickerForForm(true)">זיהוי</button>
            </div>
            <span class="help-text">בעת הזיהוי יוצגו שם החברה, הלוגו והמחיר העכשווי.</span>
          </div>

          <div class="field">
            <label for="openDate">תאריך קנייה</label>
            <input id="openDate" name="openDate" type="date" value="${today}" required>
          </div>

          <input id="companyName" name="companyName" type="hidden">
          <input id="companyLogo" name="companyLogo" type="hidden">
          <input id="companyCurrency" name="companyCurrency" type="hidden" value="USD">
          <input id="companyExchange" name="companyExchange" type="hidden">
          <input id="tickerVerified" name="tickerVerified" type="hidden" value="false">

          <div id="tickerLookupCard" class="ticker-lookup-card"></div>

          <div class="field">
            <label for="quantity">כמות מניות</label>
            <input id="quantity" name="quantity" type="number" min="0.0001" step="0.0001" required oninput="updateOpenPreview()">
          </div>
          <div class="field">
            <label for="price">מחיר קנייה</label>
            <input id="price" name="price" type="number" min="0.0001" step="0.0001" required oninput="updateOpenPreview()">
          </div>
          <div class="field">
            <label for="stopLoss">Stop Loss</label>
            <input id="stopLoss" name="stopLoss" type="number" min="0.0001" step="0.0001" required oninput="updateOpenPreview()">
          </div>
          <div class="field">
            <label for="targetPrice">מחיר יעד</label>
            <input id="targetPrice" name="targetPrice" type="number" min="0.0001" step="0.0001" required oninput="updateOpenPreview()">
            <span class="help-text">נדרש כדי לחשב פוטנציאל ויחס סיכון/סיכוי.</span>
          </div>
          <div class="field">
            <label for="pattern">איזו תבנית בחרת?</label>
            <input id="pattern" name="pattern" required placeholder="כתיבה חופשית">
          </div>
          <div class="field">
            <label for="marketDirection">כיוון השוק</label>
            <select id="marketDirection" name="marketDirection" required>
              <option value="">בחירה</option>
              <option value="עולה">עולה</option>
              <option value="יורד">יורד</option>
            </select>
          </div>
          <div id="openPreview" class="preview-box">
            ${previewItem('עלות הפוזיציה', '$0.00')}
            ${previewItem('סיכון מתוכנן', '$0.00')}
            ${previewItem('פוטנציאל מתוכנן', '$0.00')}
            ${previewItem('יחס R/R', '—')}
          </div>
          <div class="field full">
            <label for="notes">הערות</label>
            <textarea id="notes" name="notes" placeholder="אופציונלי"></textarea>
          </div>
        </form>
      `, `
        <button class="btn btn-secondary" onclick="closeModal()">ביטול</button>
        <button class="btn btn-primary" onclick="document.getElementById('openPositionForm').requestSubmit()">שמירת הפוזיציה</button>
      `);
    }

    function showAddModal(positionId) {
      if (!requireUser()) return;
      const position = appData.openPositions.find(item => item.POSITION_ID === positionId);
      if (!position) return showToast('הפוזיציה לא נמצאה.', 'error');

      openModal(`הוספה לפוזיציית ${escapeHtml(position.TICKER)}`, `
        <form id="addPositionForm" class="form-grid" onsubmit="submitAddPosition(event)">
          <input type="hidden" name="positionId" value="${escapeHtml(position.POSITION_ID)}">
          <div class="field full">
            <div class="preview-box">
              ${previewItem('כמות נוכחית', formatQuantity(position.TOTAL_QTY))}
              ${previewItem('ממוצע נוכחי', formatMoney(position.AVG_PRICE))}
              ${previewItem('Stop נוכחי', formatMoney(position.STOP_LOSS))}
              ${previewItem('יעד נוכחי', formatMoney(position.TARGET_PRICE))}
            </div>
          </div>
          <div class="field">
            <label>תאריך הוספה</label>
            <input name="date" type="date" value="${todayIso()}" required>
          </div>
          <div class="field">
            <label>כמות להוספה</label>
            <input name="quantity" type="number" min="0.0001" step="0.0001" required>
          </div>
          <div class="field">
            <label>מחיר ההוספה</label>
            <input name="price" type="number" min="0.0001" step="0.0001" required>
          </div>
          <div class="field">
            <label>Stop Loss חדש</label>
            <input name="stopLoss" type="number" min="0.0001" step="0.0001" placeholder="השאר ריק ללא שינוי">
          </div>
          <div class="field">
            <label>מחיר יעד חדש</label>
            <input name="targetPrice" type="number" min="0.0001" step="0.0001" placeholder="השאר ריק ללא שינוי">
          </div>
          <div class="field full">
            <label>הערה להוספה</label>
            <textarea name="notes" placeholder="לדוגמה: Average Down לאחר תמיכה"></textarea>
          </div>
        </form>
      `, `
        <button class="btn btn-secondary" onclick="closeModal()">ביטול</button>
        <button class="btn btn-primary" onclick="document.getElementById('addPositionForm').requestSubmit()">שמירת ההוספה</button>
      `);
    }

    function showCloseModal(positionId) {
      if (!requireUser()) return;
      const position = appData.openPositions.find(item => item.POSITION_ID === positionId);
      if (!position) return showToast('הפוזיציה לא נמצאה.', 'error');

      openModal(`סגירת פוזיציית ${escapeHtml(position.TICKER)}`, `
        <form id="closePositionForm" class="form-grid" onsubmit="submitClosePosition(event)">
          <input type="hidden" name="positionId" value="${escapeHtml(position.POSITION_ID)}">
          <div class="field full">
            <div class="preview-box">
              ${previewItem('כמות', formatQuantity(position.TOTAL_QTY))}
              ${previewItem('מחיר ממוצע', formatMoney(position.AVG_PRICE))}
              ${previewItem('פוטנציאל שתוכנן', formatMoney(position.POTENTIAL_DOLLAR))}
              ${previewItem('R/R מתוכנן', '1:' + formatNumber(position.RISK_REWARD))}
            </div>
          </div>
          <div class="field">
            <label>תאריך מכירה</label>
            <input name="closeDate" type="date" value="${todayIso()}" required>
          </div>
          <div class="field">
            <label>מחיר המכירה בפועל</label>
            <input id="exitPrice" name="exitPrice" type="number" min="0.0001" step="0.0001" required oninput="updateClosePreview('${escapeJs(position.POSITION_ID)}')">
          </div>
          <div id="closePreview" class="preview-box">
            ${previewItem('P/L משוער בדולרים', '$0.00')}
            ${previewItem('P/L משוער באחוזים', '0.00%')}
            ${previewItem('פוטנציאל מתוכנן', formatMoney(position.POTENTIAL_DOLLAR))}
            ${previewItem('סיכון מתוכנן', formatMoney(position.PLANNED_RISK_DOLLAR))}
          </div>
          <div class="field full">
            <label>הערת סגירה</label>
            <textarea name="notes" placeholder="למה סגרת? מה עבד ומה לא?"></textarea>
          </div>
        </form>
      `, `
        <button class="btn btn-secondary" onclick="closeModal()">ביטול</button>
        <button class="btn btn-danger" onclick="document.getElementById('closePositionForm').requestSubmit()">סגירת הפוזיציה</button>
      `);
    }

    async function submitOpenPosition(event) {
      event.preventDefault();

      if (getMarketApiToken() && document.getElementById('tickerVerified')?.value !== 'true') {
        const lookupResult = await lookupTickerForForm(true);
        if (!lookupResult) {
          showToast('יש לזהות טיקר תקין לפני השמירה.', 'error');
          return;
        }
      }

      const data = formToObject(event.target);
      setLoading(true);
      try {
        await createPosition(data);
        closeModal();
        showToast('הפוזיציה נפתחה בהצלחה.', 'success');
        await loadDashboard();
      } catch (error) {
        handleServerError(error);
      } finally {
        setLoading(false);
      }
    }

    async function submitAddPosition(event) {
      event.preventDefault();
      const data = formToObject(event.target);
      setLoading(true);
      try {
        const result = await addToPosition(data);
        closeModal();
        showToast(`ההוספה נשמרה. הממוצע החדש: ${formatMoney(result.newAverage)}`, 'success');
        await loadDashboard();
      } catch (error) {
        handleServerError(error);
      } finally {
        setLoading(false);
      }
    }

    async function submitClosePosition(event) {
      event.preventDefault();
      const data = formToObject(event.target);
      setLoading(true);
      try {
        const result = await closePosition(data);
        closeModal();
        showToast(`הפוזיציה נסגרה. P/L: ${formatMoney(result.plDollar)} (${formatPercent(result.plPercent)})`, 'success');
        await loadDashboard();
      } catch (error) {
        handleServerError(error);
      } finally {
        setLoading(false);
      }
    }

    function updateOpenPreview() {
      const quantity = valueOf('quantity');
      const price = valueOf('price');
      const stop = valueOf('stopLoss');
      const target = valueOf('targetPrice');
      const cost = quantity * price;
      const risk = Math.max(price - stop, 0) * quantity;
      const potential = Math.max(target - price, 0) * quantity;
      const rr = price > stop ? Math.max(target - price, 0) / (price - stop) : 0;
      const preview = document.getElementById('openPreview');
      if (!preview) return;
      preview.innerHTML = [
        previewItem('עלות הפוזיציה', formatMoney(cost)),
        previewItem('סיכון מתוכנן', formatMoney(risk)),
        previewItem('פוטנציאל מתוכנן', formatMoney(potential)),
        previewItem('יחס R/R', rr ? '1:' + formatNumber(rr) : '—')
      ].join('');
    }

    function updateClosePreview(positionId) {
      const position = appData.openPositions.find(item => item.POSITION_ID === positionId);
      const exitPrice = valueOf('exitPrice');
      if (!position || !exitPrice) return;
      const average = Number(position.AVG_PRICE || 0);
      const quantity = Number(position.TOTAL_QTY || 0);
      const plDollar = (exitPrice - average) * quantity;
      const plPercent = average ? (exitPrice / average - 1) * 100 : 0;
      const preview = document.getElementById('closePreview');
      preview.innerHTML = [
        previewItem('P/L משוער בדולרים', `<span class="${plClass(plDollar)}">${formatMoney(plDollar)}</span>`),
        previewItem('P/L משוער באחוזים', `<span class="${plClass(plDollar)}">${formatPercent(plPercent)}</span>`),
        previewItem('פוטנציאל מתוכנן', formatMoney(position.POTENTIAL_DOLLAR)),
        previewItem('סיכון מתוכנן', formatMoney(position.PLANNED_RISK_DOLLAR))
      ].join('');
    }

    function openModal(title, body, footer) {
      document.getElementById('modalTitle').innerHTML = title;
      document.getElementById('modalBody').innerHTML = body;
      document.getElementById('modalFooter').innerHTML = footer;
      document.getElementById('modalBackdrop').classList.add('show');
      document.body.style.overflow = 'hidden';
    }

    function closeModal() {
      document.getElementById('modalBackdrop').classList.remove('show');
      document.body.style.overflow = '';
    }

    function handleBackdropClick(event) {
      if (event.target.id === 'modalBackdrop') closeModal();
    }

    function formToObject(form) {
      return Object.fromEntries(new FormData(form).entries());
    }

    function tickerLink(ticker) {
      const safeTicker = escapeHtml(ticker || '');
      const url = `https://www.google.com/search?q=${encodeURIComponent((ticker || '') + ' stock')}`;
      return `<a class="ticker-link" href="${url}" target="_blank" rel="noopener noreferrer">${safeTicker}</a>`;
    }

    function previewItem(label, value) {
      return `<div class="preview-item"><small>${label}</small><strong>${value}</strong></div>`;
    }

    function setLoading(show) {
      document.getElementById('loadingOverlay').classList.toggle('show', Boolean(show));
    }

    function handleServerError(error) {
      setLoading(false);
      const message = friendlyFirebaseError(error);
      showToast(message, 'error');
    }

    function showToast(message, type) {
      const toast = document.getElementById('toast');
      toast.textContent = message;
      toast.className = `toast ${type || ''} show`;
      clearTimeout(showToast.timer);
      showToast.timer = setTimeout(() => toast.classList.remove('show'), 4200);
    }

    function formatMoney(value) {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })
        .format(Number(value || 0));
    }

    function formatPercent(value) {
      return `${Number(value || 0).toFixed(2)}%`;
    }

    function formatNumber(value) {
      return Number(value || 0).toFixed(2);
    }

    function formatQuantity(value) {
      return Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: 4 });
    }

    function formatDate(value) {
      if (!value) return '—';
      const datePart = String(value).slice(0, 10);
      const [year, month, day] = datePart.split('-');
      return year && month && day ? `${day}/${month}/${year}` : escapeHtml(value);
    }

    function plClass(value) {
      const number = Number(value || 0);
      if (number > 0) return 'positive';
      if (number < 0) return 'negative';
      return 'neutral';
    }

    function valueOf(id) {
      const element = document.getElementById(id);
      return element ? Number(element.value || 0) : 0;
    }

    function todayIso() {
      const now = new Date();
      const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
      return local.toISOString().slice(0, 10);
    }

    function escapeHtml(value) {
      return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    function escapeJs(value) {
      return String(value ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r');
    }

function renderCorrelationCard(prefix, result) {
  const valueElement = document.getElementById(`${prefix}Correlation`);
  const metaElement = document.getElementById(`${prefix}CorrelationMeta`);
  if (!valueElement || !metaElement) return;

  if (result.value === null) {
    valueElement.textContent = 'אין מספיק נתונים';
    valueElement.className = '';
    metaElement.textContent = `${result.sampleSize} ימים זמינים. נדרשים לפחות 3 ימים עם עסקאות סגורות.`;
    return;
  }

  const description = describeCorrelation(result.value);
  valueElement.textContent = `${description.strength}, ${description.direction}`;
  valueElement.className = description.tone;
  metaElement.textContent = `r = ${result.value.toFixed(2)} על בסיס ${result.sampleSize} ימים${result.sampleSize < 8 ? '. המדגם עדיין קטן' : ''}`;
}

function renderJournalCorrelationSummary(rows, correlations) {
  const summary = document.getElementById('journalCorrelationSummary');
  const linkedLabel = document.getElementById('journalLinkedDaysLabel');
  if (!summary) return;

  const linkedRows = rows.filter(row => row.closedTrades > 0);
  if (linkedLabel) linkedLabel.textContent = `${linkedRows.length} ימים מקושרים לעסקאות סגורות`;

  if (!appData.journalEntries.length) {
    summary.innerHTML = '<p>לאחר מילוי השאלון היומי יתחיל להיבנות כאן בסיס לניתוח ההתנהלות לפני המסחר.</p>';
    return;
  }

  if (linkedRows.length < 3) {
    summary.innerHTML = `
      <p>יש כבר ${appData.journalEntries.length} רשומות יומן, אך עדיין אין מספיק ימים שבהם גם מולא שאלון וגם נסגרה עסקה שנפתחה באותו יום.</p>
      <p class="analysis-note">הניתוח מתחיל להציג מתאם לאחר 3 ימים, והופך שימושי יותר לאחר 8 עד 12 ימים לפחות.</p>
    `;
    return;
  }

  const available = correlations.filter(item => item.result.value !== null);
  const strongest = available.sort((a, b) => Math.abs(b.result.value) - Math.abs(a.result.value))[0];

  if (!strongest) {
    summary.innerHTML = '<p>נאספו נתונים, אך אין עדיין שונות מספקת בדירוגים כדי לחשב קשר.</p>';
    return;
  }

  const dimension = getJournalDimension(strongest.dimension);
  const description = describeCorrelation(strongest.result.value);
  const sampleWarning = strongest.result.sampleSize < 8
    ? 'המדגם עדיין קטן ולכן זו אינדיקציה ראשונית בלבד.'
    : 'כדאי להמשיך לתעד כדי לבדוק אם הדפוס נשמר לאורך זמן.';

  summary.innerHTML = `
    <p>הקשר הבולט ביותר כרגע נמצא במדד <strong>${escapeHtml(dimension.label)}</strong>: ${escapeHtml(description.strength)} ${escapeHtml(description.direction)} מול ה-P/L היומי.</p>
    <p>${escapeHtml(dimension.directionHint)}. ${escapeHtml(sampleWarning)}</p>
    <p class="analysis-note">החישוב מציג מתאם סטטיסטי ואינו מוכיח סיבתיות. הוא נועד לעזור לזהות דפוסים שראוי לבדוק.</p>
  `;
}

function renderJournalRatingBreakdown(rows, dimension = selectedJournalDimension) {
  const container = document.getElementById('journalRatingBreakdown');
  const select = document.getElementById('journalDimensionSelect');
  if (!container) return;
  if (select) select.value = dimension;

  if (!appData.journalEntries.length) {
    container.innerHTML = '<div class="empty-state compact-empty-state">אין עדיין נתוני יומן לניתוח.</div>';
    return;
  }

  const breakdown = buildRatingBreakdown(rows, dimension);
  const maxAverage = Math.max(1, ...breakdown.map(item => Math.abs(item.averagePl)));

  container.innerHTML = breakdown.map(item => {
    const barWidth = Math.min(100, Math.abs(item.averagePl) / maxAverage * 100);
    const resultClass = item.averagePl > 0 ? 'positive' : item.averagePl < 0 ? 'negative' : 'neutral';
    const hasClosedTrades = item.closedTrades > 0;

    return `
      <article class="rating-performance-card">
        <div class="rating-performance-head">
          <span class="rating-number">${item.rating}</span>
          <div><strong>${item.days} ימים</strong><small>${item.daysWithTrades} ימים עם עסקאות</small></div>
        </div>
        <div class="rating-pl-value ${resultClass}">
          <small>P/L ממוצע לעסקה סגורה</small>
          <strong>${hasClosedTrades ? formatMoney(item.averagePl) : 'אין עסקאות סגורות'}</strong>
        </div>
        <div class="rating-pl-track" aria-hidden="true">
          <div class="rating-pl-half negative-side"><span class="rating-pl-fill negative-fill" style="width:${item.averagePl < 0 ? barWidth : 0}%"></span></div>
          <div class="rating-pl-half positive-side"><span class="rating-pl-fill positive-fill" style="width:${item.averagePl > 0 ? barWidth : 0}%"></span></div>
        </div>
        <dl class="rating-performance-stats">
          <div><dt>נפתחו</dt><dd>${item.openedTrades}</dd></div>
          <div><dt>נסגרו</dt><dd>${item.closedTrades}</dd></div>
          <div><dt>Win Rate</dt><dd>${item.closedTrades ? formatPercent(item.winRate) : 'אין נתון'}</dd></div>
          <div><dt>P/L כולל</dt><dd class="${plClass(item.totalPl)}">${item.closedTrades ? formatMoney(item.totalPl) : 'אין נתון'}</dd></div>
        </dl>
      </article>
    `;
  }).join('');
}

function changeJournalDimension(dimension) {
  selectedJournalDimension = ['mood', 'fatigue', 'dayQuality'].includes(dimension) ? dimension : 'mood';
  const rows = buildJournalDailyRows(appData.journalEntries || [], allPositions());
  renderJournalRatingBreakdown(rows, selectedJournalDimension);
}

function renderStatistics() {
  const closed = appData.closedPositions || [];
  const wins = closed.filter(item => Number(item.PL_DOLLAR || 0) > 0);
  const losses = closed.filter(item => Number(item.PL_DOLLAR || 0) < 0);
  const grossProfit = wins.reduce((sum, item) => sum + Number(item.PL_DOLLAR || 0), 0);
  const grossLoss = Math.abs(losses.reduce((sum, item) => sum + Number(item.PL_DOLLAR || 0), 0));
  const avgWinner = wins.length ? grossProfit / wins.length : 0;
  const avgLoser = losses.length ? grossLoss / losses.length : 0;
  const profitFactor = grossLoss ? grossProfit / grossLoss : (grossProfit ? grossProfit : 0);
  const expectancy = closed.length ? (grossProfit - grossLoss) / closed.length : 0;
  const values = { avgWinner, avgLoser, profitFactor, expectancy };

  Object.entries(values).forEach(([id, value]) => {
    const element = document.getElementById(id);
    if (element) element.textContent = id === 'profitFactor' ? formatNumber(value) : formatMoney(value);
  });

  const chart = document.getElementById('equityChart');
  if (chart) {
    let running = 0;
    const curve = closed.slice().reverse().map(item => running += Number(item.PL_DOLLAR || 0));
    if (!curve.length) {
      chart.innerHTML = '<div class="empty-state">לאחר סגירת עסקאות תוצג כאן עקומת ההון.</div>';
    } else {
      const min = Math.min(0, ...curve);
      const max = Math.max(0, ...curve);
      const range = Math.max(1, max - min);
      chart.innerHTML = curve.map((value, index) => `
        <div class="equity-bar" title="עסקה ${index + 1}: ${formatMoney(value)}" style="height:${Math.max(8, ((value - min) / range) * 220)}px"></div>
      `).join('');
    }
  }

  const winElement = document.getElementById('distributionWins');
  const lossElement = document.getElementById('distributionLosses');
  if (winElement) winElement.textContent = `${wins.length} עסקאות, ${formatMoney(grossProfit)}`;
  if (lossElement) lossElement.textContent = `${losses.length} עסקאות, ${formatMoney(-grossLoss)}`;

  const entries = appData.journalEntries || [];
  const rows = buildJournalDailyRows(entries, allPositions());
  const journalMetrics = {
    journalDaysCount: entries.length,
    journalMoodAverage: averageRating(entries, 'MOOD').toFixed(2),
    journalFatigueAverage: averageRating(entries, 'FATIGUE').toFixed(2),
    journalDayAverage: averageRating(entries, 'DAY_QUALITY').toFixed(2)
  };

  Object.entries(journalMetrics).forEach(([id, value]) => {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
  });

  const correlations = [
    { dimension: 'mood', result: pearsonCorrelation(rows, 'mood') },
    { dimension: 'fatigue', result: pearsonCorrelation(rows, 'fatigue') },
    { dimension: 'dayQuality', result: pearsonCorrelation(rows, 'dayQuality') }
  ];

  renderCorrelationCard('mood', correlations[0].result);
  renderCorrelationCard('fatigue', correlations[1].result);
  renderCorrelationCard('dayQuality', correlations[2].result);
  renderJournalCorrelationSummary(rows, correlations);
  renderJournalRatingBreakdown(rows, selectedJournalDimension);
}

function initializeWorkspace() {
  initTheme();
  syncThemeControl();
  initMarketExplorer({
    getTheme: getCurrentTheme,
    fetchSnapshot: getMarketExplorerSnapshot,
    resolveExchange: resolveMarketExchange
  });
  showWorkspaceView = initNavigation(view => {
    if (view === 'portfolio') renderPortfolioOverview();
    if (view === 'statistics') renderStatistics();
    if (view === 'journal') renderJournalPage(selectedJournalDate || todayIso());
    if (view === 'market') activateMarketExplorer();
  });
  renderTodayJournal();
}

document.addEventListener('DOMContentLoaded', initializeWorkspace);

Object.assign(window, {
  toggleTheme,
  renderStatistics,
  toggleAuth,
  loadDashboard,
  showMarketSettingsModal,
  saveMarketSettings,
  refreshMarketPrices,
  refreshPortfolioOverview,
  setPortfolioMode,
  togglePortfolioSeries,
  lookupTickerForForm,
  scheduleTickerLookup,
  showOpenPositionModal,
  showAddModal,
  showCloseModal,
  showDeletePositionModal,
  toggleDeletePositionButton,
  confirmDeletePosition,
  submitOpenPosition,
  submitAddPosition,
  submitClosePosition,
  submitTodayJournal,
  openTodayJournalModal,
  submitJournalEntry,
  openJournalView,
  openJournalDate,
  loadSelectedJournalDate,
  changeJournalDimension,
  updateOpenPreview,
  updateClosePreview,
  closeModal,
  handleBackdropClick
});

bootFirebase();
