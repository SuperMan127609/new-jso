const fs = require("fs");
const path = require("path");

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const HELIUS_AUTH_HEADER = process.env.HELIUS_AUTH_HEADER; // optional

function shortAddr(a) {
  if (!a || a.length < 10) return a || "";
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

function loadWallets() {
  const p = path.join(process.cwd(), "data", "tracked-wallets.json");
  const raw = fs.readFileSync(p, "utf8");
  const arr = JSON.parse(raw);
  const map = new Map(arr.map(w => [w.trackedWalletAddress, w]));
  return { list: arr, map, set: new Set(map.keys()) };
}

async function postToDiscord(content) {
  if (!DISCORD_WEBHOOK_URL) return;
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

module.exports = async (req, res) => {
  try {
    if (req.method === "GET") return res.status(200).send("ok");
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    // Optional auth check (if you set one in Helius)
    if (HELIUS_AUTH_HEADER) {
      const got = req.headers.authorization;
      if (got !== HELIUS_AUTH_HEADER) return res.status(401).send("Unauthorized");
    }

    const { map, set } = loadWallets();

    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const events = Array.isArray(body) ? body : [body];

    for (const e of events) {
      const type = e?.type || "UNKNOWN";
      if (type !== "SWAP") continue;

      const sig = e?.signature || e?.transactionSignature || "n/a";
      const feePayer = e?.feePayer || e?.accountData?.[0]?.account || "";

      // Only alert if THIS tx is from a tracked wallet:
      if (!set.has(feePayer)) continue;

      const w = map.get(feePayer);
      const solscan = sig !== "n/a" ? `https://solscan.io/tx/${sig}` : "";

      const msg =
        `${w?.emoji || "🟣"} **Tracked SWAP detected**\n` +
        `• **Wallet:** ${w?.name || "Unnamed"} (\`${shortAddr(feePayer)}\`)\n` +
        `• **Tx:** ${solscan}`;

      await postToDiscord(msg);
    }

    return res.status(200).send("ok");
  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(500).send("error");
  }
};
