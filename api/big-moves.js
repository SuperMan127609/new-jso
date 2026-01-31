// api/big-moves.js
const BIG_MOVES_WEBHOOK_URL = process.env.BIG_MOVES_WEBHOOK_URL || "";

// Frequency controls (raise these to reduce spam)
const MIN_LP_USD = Number(process.env.BM_MIN_LP_USD || "15000");
const MIN_VOL_24H = Number(process.env.BM_MIN_VOL_24H || "150000");
const MIN_CHANGE_1H = Number(process.env.BM_MIN_CHANGE_1H || "150");
const MAX_POSTS_PER_RUN = Number(process.env.BM_MAX_POSTS_PER_RUN || "3");

// Simple cooldown (best-effort on Vercel)
// For perfect cooldowns, we’d use Upstash/Redis later.
const lastPosted = new Map();
function canPost(key, cooldownMinutes = 120) {
  const now = Date.now();
  const last = lastPosted.get(key) || 0;
  if (now - last < cooldownMinutes * 60 * 1000) return false;
  lastPosted.set(key, now);
  return true;
}

async function postToBigMoves(content) {
  if (!BIG_MOVES_WEBHOOK_URL) {
    console.error("Missing BIG_MOVES_WEBHOOK_URL");
    return;
  }
  const resp = await fetch(BIG_MOVES_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    console.error("Big moves webhook failed:", resp.status, text);
  }
}

function fmt(n) {
  const num = Number(n || 0);
  if (num >= 1e6) return (num / 1e6).toFixed(2) + "M";
  if (num >= 1e3) return (num / 1e3).toFixed(2) + "K";
  return num.toFixed(0);
}

async function fetchDexPairsSolana(mint) {
  const url = `https://api.dexscreener.com/token-pairs/v1/solana/${mint}`;
  const r = await fetch(url);
  if (!r.ok) return null;
  return await r.json();
}

module.exports = async (req, res) => {
  try {
    // OPTIONAL: protect this endpoint so random people can't trigger it
    const secret = process.env.BM_CRON_SECRET || "";
    if (secret) {
      const got = req.headers["x-cron-secret"] || "";
      if (got !== secret) return res.status(401).send("Unauthorized");
    }

    // Put mints you want to watch in env var BM_MINTS="mint1,mint2,..."
    const mints = (process.env.BM_MINTS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (!mints.length) return res.status(200).send("No BM_MINTS configured.");

    let posted = 0;

    for (const mint of mints.slice(0, 150)) {
      const pairs = await fetchDexPairsSolana(mint);
      if (!pairs?.length) continue;

      // pick the most liquid pair
      const best = pairs
        .filter((p) => p?.liquidity?.usd)
        .sort((a, b) => (b.liquidity.usd || 0) - (a.liquidity.usd || 0))[0];

      if (!best) continue;

      const lp = best.liquidity?.usd || 0;
      const vol24h = best.volume?.h24 || 0;
      const ch1h = best.priceChange?.h1 || 0;

      // threshold gate = less spam
      if (lp < MIN_LP_USD) continue;
      if (vol24h < MIN_VOL_24H) continue;
      if (ch1h < MIN_CHANGE_1H) continue;

      // cooldown gate = less spam
      if (!canPost(mint, 120)) continue;

      const name = best.baseToken?.name || "Unknown";
      const symbol = best.baseToken?.symbol || "";
      const link = best.url;

      const msg =
        `🚨 **BIG MOVE** — **${name} (${symbol})**\n` +
        `• LP: $${fmt(lp)} | Vol(24h): $${fmt(vol24h)} | 1H: **+${ch1h.toFixed(2)}%**\n` +
        `• ${link}`;

      await postToBigMoves(msg);

      posted++;
      if (posted >= MAX_POSTS_PER_RUN) break;
    }

    return res.status(200).send(`ok | posted=${posted}`);
  } catch (err) {
    console.error("big-moves error:", err);
    return res.status(500).send("error");
  }
};
