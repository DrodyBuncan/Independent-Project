// matcher.js — fuzzy market matching between Polymarket and Kalshi

const STOPWORDS = new Set([
  'will','the','for','this','that','with','from','have','been','would',
  'could','should','which','when','does','did','are','was','were','has',
  'had','its','our','their','your','into','over','after','before','about',
  'than','more','less','first','last','next','who','what','how','why',
  'where','and','but','not','yes','any','all','its','can','may','might',
  'end','year','month','week','day','time','make','get','give','take',
  'per','new','old','big','high','low','top','win','lose','hit','reach'
]);

function tokenise(str) {
  return str.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w));
}

function jaccardScore(a, b) {
  const ta = new Set(tokenise(a));
  const tb = new Set(tokenise(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  const inter = [...ta].filter(t => tb.has(t)).length;
  const union = new Set([...ta, ...tb]).size;
  return inter / union;
}

/**
 * Match Polymarket markets to Kalshi markets
 * Returns array of best-matched pairs above threshold
 */
function matchMarkets(polyMarkets, kalshiMarkets, threshold = 0.30) {
  const pairs = [];

  for (const pm of polyMarkets) {
    const pTitle = pm.question || pm.title || '';
    if (!pTitle) continue;

    let bestScore = 0;
    let bestKalshi = null;
    let bestKTitle = '';

    for (const km of kalshiMarkets) {
      const kTitle = km.title || km.question || '';
      if (!kTitle) continue;
      const score = jaccardScore(pTitle, kTitle);
      if (score > bestScore) {
        bestScore = score;
        bestKalshi = km;
        bestKTitle = kTitle;
      }
    }

    if (bestScore >= threshold && bestKalshi) {
      pairs.push({
        polyMarket: pm,
        kalshiMarket: bestKalshi,
        polyTitle: pTitle,
        kalshiTitle: bestKTitle,
        matchScore: bestScore
      });
    }
  }

  // Sort by match confidence
  pairs.sort((a, b) => b.matchScore - a.matchScore);
  return pairs;
}

module.exports = { matchMarkets, jaccardScore, tokenise };
