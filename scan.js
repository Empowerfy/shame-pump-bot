// scan.js — verbose pump watcher -> Apps Script
// Node 18+ has global fetch
import fs from "fs";

const HELIUS_KEY = process.env.HELIUS_KEY;
const API = process.env.APPS_SCRIPT_API;

if (!HELIUS_KEY || !API) {
  console.error("[scan] Missing env vars. Helius?", !!HELIUS_KEY, "AppsScript?", !!API);
  process.exit(1);
}

console.log("[scan] HELIUS_KEY set? ", !!HELIUS_KEY);
console.log("[scan] APPS_SCRIPT_API: ", API);

// ---- Candidate program IDs to probe (we'll see which returns logs) ----
// NOTE: Pump.fun’s public “program id” people paste online is often wrong.
// We’ll probe a few known/seen ids. We’ll learn the right one from logs.
const CANDIDATE_PROGRAMS = [
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", // common placeholder people quote
  // add more if you know them:
  // "2oE5k........",  // (example)
];

// Very loose “bonding” matcher for first run; we’ll tighten after we see logs
const BONDING_REGEX = /(bond|bonded|bonding|complete|completed|enable|enabled)/i;

const STATE_FILE = "last-pump.json";
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { seen: {} };
  }
}
function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

async function fetchRecentFor(addr) {
  const url = `https://api.helius.xyz/v0/addresses/${addr}/transactions?api-key=${HELIUS_KEY}&limit=25`;
  console.log(`[scan] GET ${url.replace(/\?.*/, "?api-key=***")}`);
  const res = await fetch(url);
  if (!res.ok) {
    console.error("[scan] Helius error", res.status, await res.text());
    return [];
  }
  const txs = await res.json();
  console.log(`[scan] ${addr} -> ${txs.length} txs`);
  return txs;
}

// Extract a candidate mint if Helius parsed tokenTransfers for this tx
function mintFromTx(tx) {
  // prefer first token transfer mint if present
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
      body: JSON.stringify(body),
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

  for (const pid of CANDIDATE_PROGRAMS) {
    const txs = await fetchRecentFor(pid);

    for (const tx of txs) {
      const sig = tx?.signature || "(no sig)";
      const logs = tx?.meta?.logMessages || [];
      const joined = logs.join(" | ");

      // print a compact preview to learn what logs look like
      const preview = logs.slice(0, 3).join(" / ");
      console.log(`\n[scan] tx ${sig}`);
      console.log(`[scan]   preview logs: ${preview || "(no logs)"}`);

      // First pass: look for any “bonding-ish” words
      if (!BONDING_REGEX.test(joined)) continue;

      const mint = mintFromTx(tx);
      console.log(`[scan]   bonding-ish hit. inferred mint: ${mint || "(none)"}`);

      if (!mint) {
        // We matched the logs but couldn’t infer mint. Print more to debug.
        console.log("[scan]   FULL LOGS:", joined);
        continue;
      }

      if (state.seen[mint]) {
        console.log("[scan]   already seen", mint);
        continue;
      }

      const ok = await addCoin(mint);
      if (ok) {
        state.seen[mint] = Date.now();
      }
    }
  }

  saveState(state);
  console.log("[scan] done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
