const fs = require("fs");
const path = require("path");

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const HELIUS_AUTH_HEADER = process.env.HELIUS_AUTH_HEADER || ""; // optional

// Flood controls (safe defaults)
const COOLDOWN_SECONDS = Number(process.env.COOLDOWN_SECONDS || "60"); // per-wallet cooldown
const MAX_ALERTS_PER_REQUEST = Number(process.env.MAX_ALERTS_PER_REQUEST || "5");

// Filtering thresholds (set to 0 to disable)
const MIN_SOL = Number(process.env.MIN_SOL || "0");        // 0 = disabled
const MIN_STABLE = Number(process.env.MIN_STABLE || "0");  // 0 = disabled
const STABLE_MINTS = new Set(
  (process.env.STABLE_MINTS ||
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" // USDC
  )
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
);

function shortAddr(a) {
  if (!a || a.length < 10) return a || "";
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

function getWalletFilePath() {
  return path.join(process.cwd(), "data", "tracked-wallets.json");
}

// Cache wallets on warm invocations
let cached = null;
function loadWalletsCached() {
  if (cached) return cached;

  const filePath = getWalletFilePath();
  if (!fs.existsSync(filePath)) {
    throw new Error(`Wallet file not found at ${filePath}. Ensure data/tracked-wallets.json exists in repo.`);
  }

  const raw = fs.readFileSync(filePath, "utf8");
  const list = JSON.parse(raw);

  if (!Array.isArray(list)) throw new Error("tracked-wallets.json must be a JSON array.");

  const map = new Map();
  for (const w of list) {
    if (w?.trackedWalletAddress) map.set(w.trackedWalletAddress, w);
  }

  cached = { list, map, set: new Set(map.keys()) };
  return cached;
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

// Best-effort net SOL for wallet (may be missing in some payloads)
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

// Best-effort net stable (USDC etc.) for wallet
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

function summarizeTokenLegs(e, wallet) {
  const tokenTransfers = Array.isArray(e?.tokenTransfers) ? e.tokenTransfers : [];

  let biggestIn = null;
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

// Cooldown memory (best effort)
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

module.exports = async (req, res) => {
  let received = 0;
  let swaps = 0;
  let tracked = 0;
  let alerted = 0;

  try {
    if (req.method === "GET") return res.status(200).send("ok");
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    // Optional auth
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
      if (type !== "SWAP") continue;
      swaps++;

      const feePayer = extractFeePayer(e);
      if (!feePayer || !set.has(feePayer)) continue;
      tracked++;

      if (isCoolingDown(feePayer)) continue;

      // Thresholds (only apply if you set them > 0)
      const netSol = computeNetSol(e, feePayer);
      const netStable = computeNetStable(e, feePayer);
      const passesSol = MIN_SOL > 0 ? Math.abs(netSol) >= MIN_SOL : true;
      const passesStable = MIN_STABLE > 0 ? Math.abs(netStable) >= MIN_STABLE : true;

      if (!passesSol || !passesStable) continue;

      const w = map.get(feePayer);
      const sig = extractSignature(e);
      const solscan = sig !== "n/a" ? `https://solscan.io/tx/${sig}` : undefined;

      const { biggestIn, biggestOut } = summarizeTokenLegs(e, feePayer);

      const embed = {
        title: `${w?.emoji || "🟣"} Tracked SWAP`,
        url: solscan,
        description: `**${w?.name || "Unnamed"}** (\`${shortAddr(feePayer)}\`)`,
        fields: [
          { name: "Net SOL", value: `${netSol >= 0 ? "+" : ""}${netSol.toFixed(4)} SOL`, inline: true },
          { name: "Net Stable", value: `${netStable >= 0 ? "+" : ""}${netStable.toFixed(2)}`, inline: true },
          { name: "Tx", value: solscan ? solscan : "n/a", inline: false },
          {
            name: "Largest Token In",
            value: biggestIn ? `+${biggestIn.amt}\n\`${shortAddr(biggestIn.mint)}\`` : "n/a",
            inline: true,
          },
          {
            name: "Largest Token Out",
            value: biggestOut ? `-${biggestOut.amt}\n\`${shortAddr(biggestOut.mint)}\`` : "n/a",
            inline: true,
          },
        ],
        footer: { text: "BitDuel Wallet Tracker • Helius" },
        timestamp: new Date().toISOString(),
      };

      await postToDiscord({
        username: "BitDuel Alerts",
        embeds: [embed],
      });

      markAlert(feePayer);
      alerted++;

      if (alerted >= MAX_ALERTS_PER_REQUEST) break;
    }

    return res.status(200).send(
      `ok | received=${received} swaps=${swaps} tracked=${tracked} alerted=${alerted}`
    );
  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(500).send(
      `error | received=${received} swaps=${swaps} tracked=${tracked} alerted=${alerted}`
    );
  }
};
