// scan.js — program watcher with 2-step fetch to get full logs
// Node 18+ has global fetch
import fs from "fs";

const HELIUS_KEY = process.env.HELIUS_KEY;
const API = process.env.APPS_SCRIPT_API;

// <<< put your confirmed program id(s) here >>>
const PROGRAM_IDS = [
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
];

// Broad first-pass matcher; we’ll tighten once we see real lines
const BONDING_REGEX = /(bond|bonded|bonding|curve|enable|enabled|complete|initialized)/i;

const STATE_FILE = "last-pump.json";
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return { seen: {} }; }
}
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
  return txs; // light objects with signature, maybe events/transfers but often no logs
}

async function fetchFullTxs(signatures) {
  if (!signatures.length) return [];
  // Helius full details with logs
  const url = `https://api.helius.xyz/v0/transactions?api-key=${HELIUS_KEY}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(signatures),
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
  // Try tokenTransfers/events first
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
    // Step 1: get recent signatures for the program id
    const light = await fetchAddressTxs(pid, 25);
    const sigs = light.map(t => t.signature).filter(Boolean);
    if (!sigs.length) continue;

    // Step 2: fetch full transactions (includes meta.logMessages)
    const full = await fetchFullTxs(sigs);

    for (const tx of full) {
      const sig = tx?.signature || "(no sig)";
      const logs = tx?.meta?.logMessages || [];
      const preview = logs.slice(0, 3).join(" / ");
      console.log(`\n[scan] tx ${sig}`);
      console.log(`[scan]   preview logs: ${preview || "(no logs)"}`);

      const joined = logs.join(" | ");
      if (!BONDING_REGEX.test(joined)) continue;

      // Try to infer mint
      const mint = mintFromTx(tx);
      console.log(`[scan]   bonding-ish hit. inferred mint: ${mint || "(none)"}`);

      if (!mint) {
        // If no mint, dump a couple more lines for us to refine extractor
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
