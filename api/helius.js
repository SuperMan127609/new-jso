// api/helius.js
const fs = require("fs");
const path = require("path");

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const HELIUS_AUTH_HEADER = process.env.HELIUS_AUTH_HEADER; // optional (exact match)
const WALLETS_FILE = process.env.WALLETS_FILE || "tracked-wallets.json";

// Cache wallets between invocations (Vercel may reuse the same runtime)
let WALLET_CACHE = null;
let WALLET_CACHE_AT = 0;
const CACHE_MS = 60_000;

function shortAddr(a) {
  if (!a || a.length < 10) return a || "";
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

function resolveWalletPath() {
  // Expected: /data/tracked-wallets.json at repo root
  return path.join(process.cwd(), "data", WALLETS_FILE);
}

function loadWallets() {
  const now = Date.now();
  if (WALLET_CACHE && now - WALLET_CACHE_AT < CACHE_MS) return WALLET_CACHE;

  const p = resolveWalletPath();
  if (!fs.existsSync(p)) {
    throw new Error(
      `Wallet file not found at ${p}. Make sure you have /data/${WALLETS_FILE} committed in GitHub.`
    );
  }

  const raw = fs.readFileSync(p, "utf8");
  const arr = JSON.parse(raw);

  if (!Array.isArray(arr)) {
    throw new Error(`Wallet file must be a JSON array. Got: ${typeof arr}`);
  }

  const map = new Map();
  for (const w of arr) {
    if (!w || !w.trackedWalletAddress) continue;
    map.set(w.trackedWalletAddress, w);
  }

  WALLET_CACHE = { list: arr, map, set: new Set(map.keys()) };
  WALLET_CACHE_AT = now;
  return WALLET_CACHE;
}

async function readRawBody(req) {
  // If Vercel already parsed JSON:
  if (req.body && typeof req.body === "object") return req.body;

  // If body is a string:
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return req.body;
    }
  }

  // Otherwise read stream
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function postToDiscord(content) {
  if (!DISCORD_WEBHOOK_URL) {
    console.warn("DISCORD_WEBHOOK_URL missing. Skipping Discord post.");
    return;
  }

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

function extractLikelyWalletFromEvent(e) {
  // Helius often includes feePayer at top-level
  if (e?.feePayer) return e.feePayer;

  // Some payloads include accountData array
  const account = e?.accountData?.[0]?.account;
  if (account) return account;

  // Sometimes it’s nested
  const nested = e?.transaction?.message?.accountKeys?.[0];
  if (nested) return nested;

  return "";
}

module.exports = async (req, res) => {
  try {
    // Health check
    if (req.method === "GET") return res.status(200).send("ok");
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    // Optional auth check (Helius can send Authorization header)
    if (HELIUS_AUTH_HEADER) {
      const got = req.headers.authorization || "";
      if (got !== HELIUS_AUTH_HEADER) return res.status(401).send("Unauthorized");
    }

    const { map, set } = loadWallets();

    const body = await readRawBody(req);
    const events = Array.isArray(body) ? body : body ? [body] : [];

    if (!events.length) {
      console.warn("No events in webhook body.");
      return res.status(200).send("ok");
    }

    for (const e of events) {
      const type = e?.type || "UNKNOWN";
      if (type !== "SWAP") continue;

      const sig = e?.signature || e?.transactionSignature || "n/a";
      const wallet = extractLikelyWalletFromEvent(e);

      // Only alert if tx is from a tracked wallet
      if (!wallet || !set.has(wallet)) continue;

      const w = map.get(wallet);
      const solscan = sig !== "n/a" ? `https://solscan.io/tx/${sig}` : "";

      const msg =
        `${w?.emoji || "🟣"} **Tracked SWAP detected**\n` +
        `• **Wallet:** ${w?.name || "Unnamed"} (\`${shortAddr(wallet)}\`)\n` +
        `• **Tx:** ${solscan}`;

      await postToDiscord(msg);
    }

    return res.status(200).send("ok");
  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(500).send("error");
  }
};
