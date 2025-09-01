// scan.js — program watcher with 2-step fetch to get full logs
import fs from "fs";

const HELIUS_KEY = process.env.HELIUS_KEY;
const API = process.env.APPS_SCRIPT_API;

const PROGRAM_IDS = [
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
];

const BONDING_REGEX = /(bond|bonded|bonding|curve|enable|enabled|complete|initialized)/i;

const STATE_FILE = "last-pump.json";
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return { seen: {} }; } }
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

if (!HELIUS_KEY || !API) {
  console.error("[scan] Missing env vars. HELIUS_KEY/APPS_SCRIPT_API");
  process.exit(1);
}
console.log("[scan] HELIUS_KEY set? ", !!HELIUS_KEY);
console.log("[scan] APPS_SCRIPT_API: ***");

// ---- Helpers ----
async function fetchAddressTxs(addr, limit = 25) {
  const url = `https://api.helius.xyz/v0/addresses/${addr}/transactions?api-key=${HELIUS_KEY}&limit=${limit}`;
  console.log("[scan] GET", url.replace(/\?.*/, "?api-key=***"));
  const r = await fetch(url);
  if (!r.ok) {
    console.error("[scan] address txs error", r.status, await r.text());
    return [];
  }
  const txs = await r.json();
  console.log(`[scan] ${addr} -> ${txs.length} light txs`);
  return txs;
}

async function fetchFullTxs(signatures) {
  if (!signatures.length) return [];
  const url = `https://api.helius.xyz/v0/transactions?api-key=${HELIUS_KEY}`;

  // ✅ Helius expects { "transactions": ["sig1", "sig2", ...] }
  const body = JSON.stringify({ transactions: signatures });

  console.log(`[scan] fetching full txs for ${signatures.length} sigs`);
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body
  });
  if (!r.ok) {
    console.error("[scan] full txs error", r.status, await r.text());
    return [];
  }
  const full = await r.json();
  console.log(`[scan] fetched ${full.length} full txs (with logs)`);
  return full;
}

function mintFromTx(tx) {
  const m =
    tx?.tokenTransfers?.[0]?.mint ||
    tx?.events?.nft?.mint ||
    tx?.events?.token?.mint ||
    null;
  return m || null;
}

async function addCoin(mint) {
  const body = { addCoin: { mint, name: `Pump ${mint.slice(0,4)}`, symbol: "" } };
  try {
    const r = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const text = await r.text();
    if (!r.ok) {
      console.error("[scan] addCoin failed", r.status, text);
      return false;
    }
    console.log("[scan] addCoin ok", mint, text);
    return true;
  } catch (e) {
    console.error("[scan] addCoin exception", e);
    return false;
  }
}

async function main() {
  const state = loadState();

  for (const pid of PROGRAM_IDS) {
    const light = await fetchAddressTxs(pid, 25);
    const sigs = light.map(t => t.signature).filter(Boolean);
    if (!sigs.length) continue;

    const full = await fetchFullTxs(sigs);

    for (const tx of full) {
      const sig = tx?.signature || "(no sig)";
      const logs = tx?.meta?.logMessages || [];
      const preview = logs.slice(0, 3).join(" / ");
      console.log(`\n[scan] tx ${sig}`);
      console.log(`[scan]   preview logs: ${preview || "(no logs)"}`);

      const joined = logs.join(" | ");
      if (!BONDING_REGEX.test(joined)) continue;

      const mint = mintFromTx(tx);
      console.log(`[scan]   bonding-ish hit. inferred mint: ${mint || "(none)"}`);

      if (!mint) {
        console.log("[scan]   FULL LOGS:", joined);
        continue;
      }
      if (state.seen[mint]) {
        console.log("[scan]   already seen", mint);
        continue;
      }
      const ok = await addCoin(mint);
      if (ok) state.seen[mint] = Date.now();
    }
  }

  saveState(state);
  console.log("[scan] done");
}

main().catch(e => { console.error(e); process.exit(1); });
