// api/helius.js
const fs = require("fs");
const path = require("path");

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const HELIUS_AUTH_HEADER = process.env.HELIUS_AUTH_HEADER || "";

// Flood control / filters (tune in Vercel env vars)
const MIN_SOL = Number(process.env.MIN_SOL || "2"); // alert if abs(net SOL) >= this
const COOLDOWN_SECONDS = Number(process.env.COOLDOWN_SECONDS || "120"); // per-wallet cooldown
const MAX_ALERTS_PER_REQUEST = Number(process.env.MAX_ALERTS_PER_REQUEST || "5"); // cap spam in one webhook batch
const ALERT_TYPES = (process.env.ALERT_TYPES || "SWAP").split(",").map(s => s.trim().toUpperCase());

// If you want stablecoin USD threshold filtering, set this:
// STABLE_MINTS="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
// MIN_STABLE="250"
const STABLE_MINTS = new Set(
  (process.env.STABLE_MINTS || "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
);
const MIN_STABLE = Number(process.env.MIN_STABLE || "0"); // 0 disables stable threshold filter

function shortAddr(a) {
  if (!a || a.length < 10) return a || "";
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

function getWalletFilePath() {
  // Must exist in repo: /data/tracked-wallets.json
  return path.join(process.cwd(), "data", "tracked-wallets.json");
}

// Cache wallets across warm invocations
let cachedWallets = null;
function loadWalletsCached() {
  if (cachedWallets) return cachedWallets;

  const filePath = getWalletFilePath();
  if (!fs.existsSync(filePath)) {
    throw new Error(`Wallet file not found at ${filePath}. Create data/tracked-wallets.json in the repo.`);
  }

  const raw = fs.readFileSync(filePath, "utf8");
  const list = JSON.parse(raw);

  if (!Array.isArray(list)) {
    throw new Error("tracked-wallets.json must be a JSON array.");
  }

  const map = new Map();
  for (const w of list) {
    if (!w || !w.trackedWalletAddress) continue;
    map.set(w.trackedWalletAddress, w);
  }

  cachedWallets = { list, map, set: new Set(map.keys()) };
  return cachedWallets;
}

// In-memory cooldown (best-effort; resets on cold start)
// If you want “true” cooldown across restarts, you’ll use Redis/Vercel KV later.
const lastAlertAt = new Map(); // wallet -> epoch seconds

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function extractSignature(e) {
  return e?.signature || e?.transactionSignature || e?.transaction?.signature || "n/a";
}

function extractFeePayer(e) {
  return (
    e?.feePayer ||
    e?.accountData?.[0]?.account ||
    e?.transaction?.message?.accountKeys?.[0] ||
    ""
  );
}

// Try to compute the wallet’s net SOL movement from nativeTransfers
function computeNetSol(e, wallet) {
  const nativeTransfers = Array.isArray(e?.nativeTransfers) ? e.nativeTransfers : [];
  let netLamports = 0;

  for (const t of nativeTransfers) {
    const from = t?.fromUserAccount || t?.fromAccount || "";
    const to = t?.toUserAccount || t?.toAccount || "";
    const amt = Number(t?.amount || 0); // usually lamports
    if (!amt) continue;

    if (from === wallet) netLamports -= amt;
    if (to === wallet) netLamports += amt;
  }

  // If this webhook already gives SOL (not lamports) you can adjust,
  // but most Helius payloads are lamports here.
  const netSol = netLamports / 1_000_000_000;
  return netSol;
}

// Compute net token movement for the wallet from tokenTransfers
function computeNetTokens(e, wallet) {
  const tokenTransfers = Array.isArray(e?.tokenTransfers) ? e.tokenTransfers : [];
  const netByMint = new Map(); // mint -> number

  for (const t of tokenTransfers) {
    const mint = t?.mint || t?.tokenMint || "";
    if (!mint) continue;

    const from = t?.fromUserAccount || t?.fromTokenAccount || t?.fromAccount || "";
    const to = t?.toUserAccount || t?.toTokenAccount || t?.toAccount || "";

    // Helius often provides tokenAmount as a UI amount (float). If it’s raw, you’ll need decimals.
    const amt = Number(t?.tokenAmount ?? t?.amount ?? 0);
    if (!amt) continue;

    // Negative if wallet sent, positive if wallet received
    let delta = 0;
    if (from === wallet) delta -= amt;
    if (to === wallet) delta += amt;
    if (!delta) continue;

    netByMint.set(mint, (netByMint.get(mint) || 0) + delta);
  }

  return netByMint;
}

// Pick the biggest in/out token legs for display
function summarizeTokenLegs(netByMint) {
  let biggestIn = null;  // { mint, amt }
  let biggestOut = null;

  for (const [mint, amt] of netByMint.entries()) {
    if (amt > 0 && (!biggestIn || amt > biggestIn.amt)) biggestIn = { mint, amt };
    if (amt < 0 && (!biggestOut || amt < biggestOut.amt)) biggestOut = { mint, amt }; // more negative
  }
  return { biggestIn, biggestOut };
}

// Stablecoin filter: treat net stable received/sent as "USD-ish"
function computeNetStable(netByMint) {
  let netStable = 0;
  for (const [mint, amt] of netByMint.entries()) {
    if (STABLE_MINTS.has(mint)) netStable += amt;
  }
  return netStable;
}

async function postToDiscord(payload) {
  if (!DISCORD_WEBHOOK_URL) return;

  const resp = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    console.error("Discord webhook failed:", resp.status, text);
  }
}

function shouldCooldown(wallet) {
  const t = lastAlertAt.get(wallet) || 0;
  return nowSec() - t < COOLDOWN_SECONDS;
}

function markAlert(wallet) {
  lastAlertAt.set(wallet, nowSec());
}

module.exports = async (req, res) => {
  try {
    // Health check
    if (req.method === "GET") return res.status(200).send("ok");
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    // Optional auth check
    if (HELIUS_AUTH_HEADER) {
      const got = req.headers.authorization || "";
      if (got !== HELIUS_AUTH_HEADER) return res.status(401).send("Unauthorized");
    }

    const { map, set } = loadWalletsCached();

    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const events = Array.isArray(body) ? body : [body];

    let sent = 0;

    for (const e of events) {
      const type = String(e?.type || "UNKNOWN").toUpperCase();
      if (!ALERT_TYPES.includes(type)) continue;

      const feePayer = extractFeePayer(e);
      if (!feePayer || !set.has(feePayer)) continue;

      // Cooldown to prevent spam
      if (COOLDOWN_SECONDS > 0 && shouldCooldown(feePayer)) continue;

      const sig = extractSignature(e);
      const solscan = sig !== "n/a" ? `https://solscan.io/tx/${sig}` : undefined;

      const w = map.get(feePayer);
      const netSol = computeNetSol(e, feePayer);
      const netByMint = computeNetTokens(e, feePayer);
      const { biggestIn, biggestOut } = summarizeTokenLegs(netByMint);

      const netStable = computeNetStable(netByMint);

      // Filtering rules (anti-flood):
      const passesSol = Math.abs(netSol) >= MIN_SOL;
      const passesStable = MIN_STABLE > 0 ? Math.abs(netStable) >= MIN_STABLE : false;

      // If you set MIN_STABLE, it becomes an additional “significant” trigger.
      // If MIN_STABLE is 0, only SOL threshold applies.
      if (!passesSol && !passesStable) continue;

      // Basic action label
      // (Heuristic) If wallet spent SOL (negative net SOL), likely buying; if gained SOL, likely selling.
      const action =
        netSol < 0 ? "BUY (spent SOL)" :
        netSol > 0 ? "SELL (received SOL)" :
        "SWAP";

      // Build a clean Discord embed
      const embed = {
        title: `${w?.emoji || "🟣"} Tracked Wallet ${action}`,
        url: solscan,
        description: `**${w?.name || "Unnamed"}** (\`${shortAddr(feePayer)}\`)`,
        fields: [
          {
            name: "Net SOL",
            value: `${netSol >= 0 ? "+" : ""}${netSol.toFixed(4)} SOL`,
            inline: true,
          },
          {
            name: "Largest Token In",
            value: biggestIn ? `+${biggestIn.amt.toFixed(4)}\n\`${shortAddr(biggestIn.mint)}\`` : "n/a",
            inline: true,
          },
          {
            name: "Largest Token Out",
            value: biggestOut ? `${biggestOut.amt.toFixed(4)}\n\`${shortAddr(biggestOut.mint)}\`` : "n/a",
            inline: true,
          },
        ],
        footer: { text: "BitDuel Wallet Tracker • Helius Webhook" },
        timestamp: new Date().toISOString(),
      };

      // Optional stable info
      if (MIN_STABLE > 0 || Math.abs(netStable) > 0) {
        embed.fields.push({
          name: "Net Stable (USD-ish)",
          value: `${netStable >= 0 ? "+" : ""}${netStable.toFixed(2)} (mint(s) in STABLE_MINTS)`,
          inline: false,
        });
      }

      await postToDiscord({
        username: "BitDuel Alerts",
        embeds: [embed],
      });

      markAlert(feePayer);
      sent++;

      if (sent >= MAX_ALERTS_PER_REQUEST) break;
    }

    return res.status(200).send(`ok (${sent} alerts sent)`);
  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(500).send("error");
  }
};
