// kelly.js — bankroll management math

/**
 * Full Kelly fraction
 * f* = (b*p - q) / b
 * b = decimal odds - 1 (i.e. payout per $1 risked)
 * p = true probability of winning
 * q = 1 - p
 */
function kellyFraction(trueP, marketPrice) {
  if (marketPrice <= 0 || marketPrice >= 1) return 0;
  const b = (1 / marketPrice) - 1;
  const q = 1 - trueP;
  const f = (b * trueP - q) / b;
  return Math.max(0, f);
}

/**
 * For a pure arb (both legs locked in):
 * - You spend: yesPrice + noPrice (on different exchanges)
 * - You always collect: $1
 * - Profit per unit = 1 - (yesPrice + noPrice)
 * - This is effectively risk-free so we size by net spread / fee-adjusted profit
 */
function arbKellyBet(yesPrice, noPrice, bankroll, kellyFraction) {
  const totalCost = yesPrice + noPrice;
  const profit = 1 - totalCost; // guaranteed profit per $1 unit
  if (profit <= 0) return { bet: 0, ev: 0, profit: 0 };

  // Treat as near-certain bet: trueP=0.97 accounts for execution risk
  const kf = kellyFraction(0.97, totalCost);
  const bet = kf * kellyFraction * bankroll;
  const ev = profit * bet;

  return {
    bet: Math.max(0, bet),
    ev: Math.max(0, ev),
    profit,
    totalCost,
    returnPct: (profit / totalCost) * 100
  };
}

/**
 * Expected value per $1 bet (non-arb, directional)
 */
function expectedValue(trueP, marketPrice) {
  const b = (1 / marketPrice) - 1;
  return (trueP * b) - (1 - trueP);
}

module.exports = { kellyFraction, arbKellyBet, expectedValue };
