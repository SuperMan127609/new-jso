// api/helius.js
const fs = require("fs");
const path = require("path");

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const HELIUS_AUTH_HEADER = process.env.HELIUS_AUTH_HEADER || "";

// ----------------- ENV VARS (set in Vercel) -----------------
// Filters / flood control
const MIN_SOL = Number(process.env.MIN_SOL || "0.75");            // alert if abs(net SOL) >= this (best-effort)
const MIN_STABLE = Number(process.env.MIN_STABLE || "100");       // alert if abs(net USDC/USDT) >= this (best-effort)
const COOLDOWN_SECONDS = Number(process.env.COOLDOWN_SECONDS || "90"); // per-wallet cooldown
const MAX_ALERTS_PER_REQUEST = Number(process.env.MAX_ALERTS_PER_REQUEST || "5"); // cap spam per webhook batch

// Allow multiple types (default: SWAP). Example: "SWAP,TRANSFER"
const ALERT_TYPES = (process.env.ALERT_TYPES || "SWAP")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

// USDC + USDT on Solana (defaults); you can override STABLE_MINTS env var
// STABLE_MINTS="USDC_MINT,USDT_MINT"
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

// Debug (optional): set DEBUG=1 to log filter reasoning in Vercel logs
const DEBUG = String(process.env.DEBUG || "") === "1";

// ----------------- HELPERS -----------------
function shortAddr(a) {
  if (!a || a.length < 10) return a || "";
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

function getWalletFilePath() {
  return path.join(process.cwd(), "data", "tracked-wallets.json");
}

// Cache wallet list across warm invocations
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
  // Common locations in Helius Enhanced Transactions webhook payloads
  return (
    e?.feePayer ||
    e?.accountData?.[0]?.account ||
    e?.transaction?.message?.accountKeys?.[0] ||
    ""
  );
}

// Best-effort net SOL movement for the wallet from nativeTransfers (lamports)
function computeNetSol(e, wallet) {
  const nativeTransfers = Array.isArray(e?.nativeTransfers) ? e.nativeTransfers : [];
  let lamports = 0;

  for (const t of nativeTransfers) {
    const from = t?.fromUserAccount || t?.fromAccount || "";
    const to = t?.toUserAccount || t?.toAccount || "";
    const amt = Number(t?.amount || 0); // lamports
    if (!amt) continue;

    if (from === wallet) lamports -= amt;
    if (to === wallet) lamports += amt;
  }

  return lamports / 1_000_000_000;
}

// Best-effort net stable movement (USDC/USDT) from tokenTransfers
function computeNetStable(e, wallet) {
  const tokenTransfers = Array.isArray(e?.tokenTransfers) ? e.tokenTransfers : [];
  let net = 0;

  for (const t of tokenTransfers) {
    const mint = t?.mint || t?.tokenMint || "";
    if (!STABLE_MINTS.has(mint)) continue;

    const from = t?.fromUserAccount || t?.fromTokenAccount || t?.fromAccount || "";
    const to = t?.toUserAccount || t?.toTokenAccount || t?.toAccount || "";
    const amt = Number(t?.tokenAmount ?? t?.amount ?? 0); // usually UI amount
    if (!amt) continue;

    if (from === wallet) net -= amt;
    if (to === wallet) net += amt;
  }

  return net;
}

// Pull largest token in/out legs for readability
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

// Cooldown in-memory (best-effort; resets on cold start)
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
  let cooledDown = 0;
  let filteredOut = 0;
  let sent = 0;

  try {
    // health check
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
        cooledDown++;
        continue;
      }

      const netSol = computeNetSol(e, feePayer);
      const netStable = computeNetStable(e, feePayer);

      // IMPORTANT: OR logic (alert if SOL trigger OR stable trigger hits)
      const triggersSol = MIN_SOL > 0 ? Math.abs(netSol) >= MIN_SOL : false;
      const triggersStable = MIN_STABLE > 0 ? Math.abs(netStable) >= MIN_STABLE : false;

      if (DEBUG) {
        console.log("Filter check", {
          feePayer,
          type,
          netSol,
          netStable,
          MIN_SOL,
          MIN_STABLE,
          triggersSol,
          triggersStable,
        });
      }

      if (!triggersSol && !triggersStable) {
        filteredOut++;
        continue;
      }

      const w = map.get(feePayer);
      const sig = extractSignature(e);
      const solscan = sig !== "n/a" ? `https://solscan.io/tx/${sig}` : undefined;

      const { biggestIn, biggestOut } = summarizeTokenLegs(e, feePayer);

      // Heuristic label (not perfect, but helpful)
      const action =
        netSol < 0 ? "BUY (spent SOL)" : netSol > 0 ? "SELL (received SOL)" : "SWAP";

      const embed = {
        title: `${w?.emoji || "🟣"} ${w?.name || "Tracked Wallet"} • ${action}`,
        url: solscan,
        description: `Wallet: \`${shortAddr(feePayer)}\``,
        fields: [
          {
            name: "Net SOL",
            value: `${netSol >= 0 ? "+" : ""}${netSol.toFixed(4)} SOL`,
            inline: true,
          },
          {
            name: "Net Stable (USDC/USDT)",
            value: `${netStable >= 0 ? "+" : ""}${netStable.toFixed(2)}`,
            inline: true,
          },
          {
            name: "Largest Token In",
            value: biggestIn
              ? `+${Number(biggestIn.amt).toLocaleString()}\n\`${shortAddr(biggestIn.mint)}\``
              : "n/a",
            inline: true,
          },
          {
            name: "Largest Token Out",
            value: biggestOut
              ? `-${Number(biggestOut.amt).toLocaleString()}\n\`${shortAddr(biggestOut.mint)}\``
              : "n/a",
            inline: true,
          },
        ],
        footer: {
          text: `BitDuel Wallet Tracker • cooldown=${COOLDOWN_SECONDS}s • minSOL=${MIN_SOL} • minStable=${MIN_STABLE}`,
        },
        timestamp: new Date().toISOString(),
      };

      await postToDiscord({
        username: "BitDuel Alerts",
        embeds: [embed],
      });

      markAlert(feePayer);
      sent++;

      if (sent >= MAX_ALERTS_PER_REQUEST) break;
    }

    return res
      .status(200)
      .send(
        `ok | received=${received} type=${matchedType} tracked=${matchedTracked} cooled=${cooledDown} filtered=${filteredOut} sent=${sent}`
      );
  } catch (err) {
    console.error("Webhook error:", err);
    return res
      .status(500)
      .send(
        `error | received=${received} type=${matchedType} tracked=${matchedTracked} cooled=${cooledDown} filtered=${filteredOut} sent=${sent}`
      );
  }
};
