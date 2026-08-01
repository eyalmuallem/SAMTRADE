const DIMENSIONS = {
  mood: { label: 'מצב רוח', directionHint: 'דירוג גבוה מציין מצב רוח טוב יותר' },
  fatigue: { label: 'עייפות', directionHint: 'דירוג גבוה מציין עייפות גבוהה יותר' },
  dayQuality: { label: 'איכות היום', directionHint: 'דירוג גבוה מציין יום טוב יותר' }
};

function normalizedDate(value) {
  return String(value || '').slice(0, 10);
}

function numeric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export function getJournalDimension(dimension) {
  return DIMENSIONS[dimension] || DIMENSIONS.mood;
}

export function buildJournalDailyRows(entries = [], positions = []) {
  return entries
    .map(entry => {
      const date = normalizedDate(entry.DATE || entry.date || entry.JOURNAL_DATE);
      const openedPositions = positions.filter(position => normalizedDate(position.OPEN_DATE) === date);
      const closedPositions = openedPositions.filter(position => position.STATUS === 'CLOSED');
      const wins = closedPositions.filter(position => numeric(position.PL_DOLLAR) > 0);
      const totalPl = closedPositions.reduce((sum, position) => sum + numeric(position.PL_DOLLAR), 0);

      return {
        date,
        mood: numeric(entry.MOOD),
        fatigue: numeric(entry.FATIGUE),
        dayQuality: numeric(entry.DAY_QUALITY),
        notes: String(entry.NOTES || ''),
        openedTrades: openedPositions.length,
        closedTrades: closedPositions.length,
        wins: wins.length,
        losses: closedPositions.filter(position => numeric(position.PL_DOLLAR) < 0).length,
        totalPl,
        averagePl: closedPositions.length ? totalPl / closedPositions.length : 0,
        winRate: closedPositions.length ? wins.length / closedPositions.length * 100 : 0
      };
    })
    .filter(row => row.date)
    .sort((a, b) => b.date.localeCompare(a.date));
}

export function pearsonCorrelation(rows = [], dimension = 'mood') {
  const linkedRows = rows.filter(row => row.closedTrades > 0 && Number.isFinite(row[dimension]));
  const sampleSize = linkedRows.length;

  if (sampleSize < 3) {
    return { value: null, sampleSize };
  }

  const xMean = linkedRows.reduce((sum, row) => sum + numeric(row[dimension]), 0) / sampleSize;
  const yMean = linkedRows.reduce((sum, row) => sum + numeric(row.totalPl), 0) / sampleSize;

  let numerator = 0;
  let xSquares = 0;
  let ySquares = 0;

  linkedRows.forEach(row => {
    const xDelta = numeric(row[dimension]) - xMean;
    const yDelta = numeric(row.totalPl) - yMean;
    numerator += xDelta * yDelta;
    xSquares += xDelta * xDelta;
    ySquares += yDelta * yDelta;
  });

  const denominator = Math.sqrt(xSquares * ySquares);
  if (!denominator) {
    return { value: 0, sampleSize };
  }

  return {
    value: Math.max(-1, Math.min(1, numerator / denominator)),
    sampleSize
  };
}

export function describeCorrelation(value) {
  if (value === null || !Number.isFinite(value)) {
    return { strength: 'אין מספיק נתונים', direction: '', tone: 'neutral' };
  }

  const absolute = Math.abs(value);
  const strength = absolute >= 0.7
    ? 'קשר חזק'
    : absolute >= 0.4
      ? 'קשר בינוני'
      : absolute >= 0.2
        ? 'קשר חלש'
        : 'כמעט ללא קשר';

  const direction = value > 0.05 ? 'חיובי' : value < -0.05 ? 'שלילי' : 'ניטרלי';
  const tone = value > 0.05 ? 'positive' : value < -0.05 ? 'negative' : 'neutral';

  return { strength, direction, tone };
}

export function buildRatingBreakdown(rows = [], dimension = 'mood') {
  return [1, 2, 3, 4, 5].map(rating => {
    const ratingRows = rows.filter(row => numeric(row[dimension]) === rating);
    const daysWithTrades = ratingRows.filter(row => row.openedTrades > 0);
    const closedTrades = ratingRows.reduce((sum, row) => sum + row.closedTrades, 0);
    const openedTrades = ratingRows.reduce((sum, row) => sum + row.openedTrades, 0);
    const wins = ratingRows.reduce((sum, row) => sum + row.wins, 0);
    const totalPl = ratingRows.reduce((sum, row) => sum + row.totalPl, 0);

    return {
      rating,
      days: ratingRows.length,
      daysWithTrades: daysWithTrades.length,
      openedTrades,
      closedTrades,
      wins,
      totalPl,
      averagePl: closedTrades ? totalPl / closedTrades : 0,
      winRate: closedTrades ? wins / closedTrades * 100 : 0
    };
  });
}

export function averageRating(entries = [], key) {
  const values = entries
    .map(entry => numeric(entry[key]))
    .filter(value => value >= 1 && value <= 5);

  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
