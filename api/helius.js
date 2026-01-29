// api/helius.js (CommonJS for Vercel Node runtime)

const fs = require("fs");
const path = require("path");

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const HELIUS_AUTH_HEADER = process.env.HELIUS_AUTH_HEADER; // optional

function shortAddr(a) {
  if (!a || a.length < 10) return a || "";
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

// ---- Wallet cache (avoids re-reading file on every request) ----
let WALLET_CACHE = null;
let WALLET_CACHE_MTIME = 0;

function loadWalletsCached() {
  const p = path.join(process.cwd(), "data", "tracked-wallets.json");

  if (!fs.existsSync(p)) {
    throw new Error(`Missing wallets file: ${p}`);
  }

  const stat = fs.statSync(p);
  const mtime = stat.mtimeMs;

  // Only reload when file changes
  if (WALLET_CACHE && WALLET_CACHE_MTIME === mtime) return WALLET_CACHE;

  const raw = fs.readFileSync(p, "utf8");
  const arr = JSON.parse(raw);

  if (!Array.isArray(arr)) {
    throw new Error("tracked-wallets.json must be a JSON array of wallet objects.");
  }

  const map = new Map();
  for (const w of arr) {
    if (!w || !w.trackedWalletAddress) continue;
    map.set(w.trackedWalletAddress, w);
  }

  WALLET_CACHE = { list: arr, map, set: new Set(map.keys()) };
  WALLET_CACHE_MTIME = mtime;
  return WALLET_CACHE;
}

async function postToDiscord(content) {
  if (!DISCORD_WEBHOOK_URL) return;

  // Node 18+ on Vercel has fetch globally.
  const resp = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    console.error("Discord webhook failed:", resp.status, text);
  }
}

// Try multiple common locations where the “wallet address” might appear.
// Helius payloads can vary depending on webhook type and config.
function extractLikelyWallet(e) {
  // Most common in enhanced webhooks:
  const candidates = [
    e?.feePayer,
    e?.account,
    e?.wallet,
    e?.owner,
    e?.source,
    e?.transaction?.message?.accountKeys?.[0], // sometimes fee payer is first account key
    e?.accountData?.[0]?.account,
    e?.nativeTransfers?.[0]?.fromUserAccount,
    e?.nativeTransfers?.[0]?.toUserAccount,
  ].filter(Boolean);

  return candidates[0] || "";
}

function extractSignature(e) {
  return e?.signature || e?.transactionSignature || e?.transaction?.signatures?.[0] || "n/a";
}

module.exports = async (req, res) => {
  try {
    // Health check
    if (req.method === "GET") return res.status(200).send("ok");
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    // Optional auth check (only if you set HELIUS_AUTH_HEADER)
    if (HELIUS_AUTH_HEADER) {
      const got = req.headers?.authorization;
      if (got !== HELIUS_AUTH_HEADER) return res.status(401).send("Unauthorized");
    }

    const { map, set } = loadWalletsCached();

    // Vercel may give req.body as already-parsed object, or as a string
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    // Helius can send a single object or an array of objects
    const events = Array.isArray(body) ? body : [body];

    for (const e of events) {
      const type = e?.type || "UNKNOWN";

      // If you ONLY want SWAP events, keep this.
      // If you want to test quickly, temporarily comment it out.
      if (type !== "SWAP") continue;

      const sig = extractSignature(e);
      const likelyWallet = extractLikelyWallet(e);

      // Only alert if this tx is from a tracked wallet
      if (!set.has(likelyWallet)) continue;

      const w = map.get(likelyWallet);
      const solscan = sig !== "n/a" ? `https://solscan.io/tx/${sig}` : "";

      const msg =
        `${w?.emoji || "🟣"} **Tracked SWAP detected**\n` +
        `• **Wallet:** ${w?.name || "Unnamed"} (\`${shortAddr(likelyWallet)}\`)\n` +
        `• **Tx:** ${solscan}`;

      await postToDiscord(msg);
    }

    return res.status(200).send("ok");
  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(500).send("error");
  }
};
