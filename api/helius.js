// api/helius.js
const fs = require("fs");
const path = require("path");

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const HELIUS_AUTH_HEADER = process.env.HELIUS_AUTH_HEADER || "";

// ----------------- CONFIG (Vercel Env Vars) -----------------
const ALERT_TYPES = (process.env.ALERT_TYPES || "SWAP")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

// More alerts = lower these
const MIN_SOL = Number(process.env.MIN_SOL || "0.25"); // trigger if abs(net SOL) >=
const MIN_STABLE = Number(process.env.MIN_STABLE || "25"); // trigger if abs(net USDC/USDT) >=
const MIN_TOKEN_LEG = Number(process.env.MIN_TOKEN_LEG || "0"); // trigger if biggest token in/out >= (0 disables)

const COOLDOWN_SECONDS = Number(process.env.COOLDOWN_SECONDS || "30"); // per-wallet cooldown
const MAX_ALERTS_PER_REQUEST = Number(process.env.MAX_ALERTS_PER_REQUEST || "8");

// Only “big” alerts ping a role (set empty to disable)
const PING_ROLE_ID = process.env.PING_ROLE_ID || ""; // e.g. 1234567890
const PING_SCORE = Number(process.env.PING_SCORE || "8"); // score needed to ping

// USDC + USDT defaults (override with STABLE_MINTS="mint1,mint2")
const DEFAULT_STABLE_MINTS = [
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
];
const STABLE_MINTS = new Set(
  (process.env.STABLE_MINTS || DEFAULT_STABLE_MINTS.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

const DEBUG = String(process.env.DEBUG || "") === "1";

// ----------------- HELPERS -----------------
function shortAddr(a) {
  if (!a || a.length < 10) return a || "";
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

function getWalletFilePath() {
  return path.join(process.cwd(), "data", "tracked-wallets.json");
}

// Cache wallets across warm invocations
let cachedWallets = null;
function loadWalletsCached() {
  if (cachedWallets) return cachedWallets;

  const filePath = getWalletFilePath();
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Wallet file not found at ${filePath}. Ensure data/tracked-wallets.json exists in the repo.`
    );
  }

  const raw = fs.readFileSync(filePath, "utf8");
  const list = JSON.parse(raw);
  if (!Array.isArray(list)) throw new Error("tracked-wallets.json must be a JSON array.");

  const map = new Map();
  for (const w of list) {
    if (w?.trackedWalletAddress) map.set(w.trackedWalletAddress, w);
  }

  cachedWallets = { list, map, set: new Set(map.keys()) };
  return cachedWallets;
}

async function postToDiscord(payload) {
  if (!DISCORD_WEBHOOK_URL) {
    console.error("Missing DISCORD_WEBHOOK_URL env var");
    return;
  }

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

// Net SOL movement for the wallet using nativeTransfers (lamports)
function computeNetSol(e, wallet) {
  const nativeTransfers = Array.isArray(e?.nativeTransfers) ? e.nativeTransfers : [];
  let lamports = 0;

  for (const t of nativeTransfers) {
    const from = t?.fromUserAccount || t?.fromAccount || "";
    const to = t?.toUserAccount || t?.toAccount || "";
    const amt = Number(t?.amount || 0);
    if (!amt) continue;

    if (from === wallet) lamports -= amt;
    if (to === wallet) lamports += amt;
  }

  return lamports / 1_000_000_000;
}

// Net stable movement (USDC/USDT) using tokenTransfers
function computeNetStable(e, wallet) {
  const tokenTransfers = Array.isArray(e?.tokenTransfers) ? e.tokenTransfers : [];
  let net = 0;

  for (const t of tokenTransfers) {
    const mint = t?.mint || t?.tokenMint || "";
    if (!STABLE_MINTS.has(mint)) continue;

    const from = t?.fromUserAccount || t?.fromTokenAccount || t?.fromAccount || "";
    const to = t?.toUserAccount || t?.toTokenAccount || t?.toAccount || "";
    const amt = Number(t?.tokenAmount ?? t?.amount ?? 0);
    if (!amt) continue;

    if (from === wallet) net -= amt;
    if (to === wallet) net += amt;
  }

  return net;
}

// Largest token legs (by amount) for readability
function summarizeTokenLegs(e, wallet) {
  const tokenTransfers = Array.isArray(e?.tokenTransfers) ? e.tokenTransfers : [];

  let biggestIn = null; // { mint, amt }
  let biggestOut = null;

  for (const t of tokenTransfers) {
    const mint = t?.mint || t?.tokenMint || "";
    if (!mint) continue;

    const from = t?.fromUserAccount || t?.fromTokenAccount || t?.fromAccount || "";
    const to = t?.toUserAccount || t?.toTokenAccount || t?.toAccount || "";
    const amt = Number(t?.tokenAmount ?? t?.amount ?? 0);
    if (!amt) continue;

    if (to === wallet) {
      if (!biggestIn || amt > biggestIn.amt) biggestIn = { mint, amt };
    }
    if (from === wallet) {
      if (!biggestOut || amt > biggestOut.amt) biggestOut = { mint, amt };
    }
  }

  return { biggestIn, biggestOut };
}

// Simple scoring to surface “interesting” buys/sells without market cap data
function scoreEvent({ netSol, netStable, biggestIn, biggestOut }) {
  let score = 0;

  // SOL magnitude
  const s = Math.abs(netSol);
  if (s >= 0.25) score += 1;
  if (s >= 0.75) score += 2;
  if (s >= 1.5) score += 3;
  if (s >= 3) score += 4;
  if (s >= 7) score += 6;

  // Stable magnitude
  const u = Math.abs(netStable);
  if (u >= 25) score += 1;
  if (u >= 100) score += 2;
  if (u >= 250) score += 3;
  if (u >= 1000) score += 5;

  // Big token legs (often memecoins have huge counts; still useful as a “size” proxy)
  const inAmt = Math.abs(Number(biggestIn?.amt || 0));
  const outAmt = Math.abs(Number(biggestOut?.amt || 0));
  const leg = Math.max(inAmt, outAmt);
  if (leg > 0) score += 1;
  if (leg >= 1_000) score += 1;
  if (leg >= 100_000) score += 2;
  if (leg >= 1_000_000) score += 3;

  return score;
}

// Cooldown in-memory (best effort)
const lastAlertAt = new Map();
function nowSec() {
  return Math.floor(Date.now() / 1000);
}
function isCoolingDown(wallet) {
  if (COOLDOWN_SECONDS <= 0) return false;
  const last = lastAlertAt.get(wallet) || 0;
  return nowSec() - last < COOLDOWN_SECONDS;
}
function markAlert(wallet) {
  lastAlertAt.set(wallet, nowSec());
}

// ----------------- HANDLER -----------------
module.exports = async (req, res) => {
  let received = 0;
  let matchedType = 0;
  let matchedTracked = 0;
  let cooled = 0;
  let filtered = 0;
  let sent = 0;

  try {
    if (req.method === "GET") return res.status(200).send("ok");
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    // optional auth
    if (HELIUS_AUTH_HEADER) {
      const got = req.headers.authorization || "";
      if (got !== HELIUS_AUTH_HEADER) return res.status(401).send("Unauthorized");
    }

    const { map, set } = loadWalletsCached();

    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const events = Array.isArray(body) ? body : [body];
    received = events.length;

    for (const e of events) {
      const type = String(e?.type || "UNKNOWN").toUpperCase();
      if (!ALERT_TYPES.includes(type)) continue;
      matchedType++;

      const feePayer = extractFeePayer(e);
      if (!feePayer || !set.has(feePayer)) continue;
      matchedTracked++;

      if (isCoolingDown(feePayer)) {
        cooled++;
        continue;
      }

      const netSol = computeNetSol(e, feePayer);
      const netStable = computeNetStable(e, feePayer);
      const { biggestIn, biggestOut } = summarizeTokenLegs(e, feePayer);

      // Triggers (OR): let more through, then rely on cooldown + max per batch
      const triggersSol = MIN_SOL > 0 ? Math.abs(netSol) >= MIN_SOL : true; // default true if MIN_SOL=0
      const triggersStable = MIN_STABLE > 0 ? Math.abs(netStable) >= MIN_STABLE : true; // default true if MIN_STABLE=0

      const biggestLeg = Math.max(
        Math.abs(Number(biggestIn?.amt || 0)),
        Math.abs(Number(biggestOut?.amt || 0))
      );
      const triggersTokenLeg = MIN_TOKEN_LEG > 0 ? biggestLeg >= MIN_TOKEN_LEG : true; // default true if 0

      // To avoid “no alerts” situations, we only filter out if ALL are false
      if (!triggersSol && !triggersStable && !triggersTokenLeg) {
        filtered++;
        continue;
      }

      const sig = extractSignature(e);
      const solscan = sig !== "n/a" ? `https://solscan.io/tx/${sig}` : undefined;

      const w = map.get(feePayer);

      // Heuristic BUY/SELL label
      const action =
        netSol < 0 ? "BUY (spent SOL)" : netSol > 0 ? "SELL (received SOL)" : "SWAP";

      const score = scoreEvent({ netSol, netStable, biggestIn, biggestOut });

      // Optional role ping for high-score alerts
      const ping =
        PING_ROLE_ID && score >= PING_SCORE ? `<@&${PING_ROLE_ID}> ` : "";

      const embed = {
        title: `${w?.emoji || "🟣"} ${w?.name || "Tracked Wallet"} • ${action}`,
        url: solscan,
        description: `Wallet: \`${shortAddr(feePayer)}\` • **Signal Score:** ${score}`,
        fields: [
          {
            name: "Spent/Received SOL (net)",
            value: `${netSol >= 0 ? "+" : ""}${netSol.toFixed(4)} SOL`,
            inline: true,
          },
          {
            name: "Spent/Received Stable (net)",
            value: `${netStable >= 0 ? "+" : ""}${netStable.toFixed(2)} (USDC/USDT)`,
            inline: true,
          },
          {
            name: "Top Token In",
            value: biggestIn
              ? `+${Number(biggestIn.amt).toLocaleString()}\n\`${shortAddr(biggestIn.mint)}\``
              : "n/a",
            inline: true,
          },
          {
            name: "Top Token Out",
            value: biggestOut
              ? `-${Number(biggestOut.amt).toLocaleString()}\n\`${shortAddr(biggestOut.mint)}\``
              : "n/a",
            inline: true,
          },
        ],
        footer: {
          text: `BitDuel Wallet Tracker • cooldown=${COOLDOWN_SECONDS}s • minSOL=${MIN_SOL} • minStable=${MIN_STABLE} • minTokenLeg=${MIN_TOKEN_LEG}`,
        },
        timestamp: new Date().toISOString(),
      };

      if (DEBUG) {
        console.log("Alert", {
          feePayer,
          type,
          netSol,
          netStable,
          biggestIn,
          biggestOut,
          score,
        });
      }

      await postToDiscord({
        username: "BitDuel Wallet Tracker",
        content: ping || undefined,
        embeds: [embed],
        allowed_mentions: ping ? { roles: [PING_ROLE_ID] } : { parse: [] },
      });

      markAlert(feePayer);
      sent++;

      if (sent >= MAX_ALERTS_PER_REQUEST) break;
    }

    return res
      .status(200)
      .send(
        `ok | received=${received} type=${matchedType} tracked=${matchedTracked} cooled=${cooled} filtered=${filtered} sent=${sent}`
      );
  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(500).send("error");
  }
};
