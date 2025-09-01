// scan.js - polls Helius for Pump.fun coins and adds them to Google Sheets
import fetch from 'node-fetch';
import fs from 'fs';

const HELIUS_KEY = process.env.HELIUS_KEY;
const API = process.env.APPS_SCRIPT_API; // Apps Script /exec endpoint

if (!HELIUS_KEY || !API) {
  console.error("Missing HELIUS_KEY or APPS_SCRIPT_API env vars");
  process.exit(1);
}

// Real Pump.fun BondingCurve program ID
const PUMP_PROGRAM_IDS = [
  "Pump111111111111111111111111111111111111111"
];

const STATE_FILE = 'last-pump.json';

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return { seen: {} };
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { seen: {} }; }
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

async function fetchRecent() {
  const out = [];
  for (const pid of PUMP_PROGRAM_IDS) {
    const url = `https://api.helius.xyz/v0/addresses/${pid}/transactions?api-key=${HELIUS_KEY}&limit=20`;
    const res = await fetch(url);
    if (!res.ok) { console.error("Helius error:", res.status); continue; }
    const txs = await res.json();
    for (const tx of txs) {
      const logs = tx?.meta?.logMessages?.join(' ') || '';
      // simple heuristic (we can tighten once we inspect real logs)
      if (/bond|complete|enabled/i.test(logs)) {
        const mint = tx?.tokenTransfers?.[0]?.mint || null;
        if (mint) out.push({ mint });
      }
    }
  }
  return out;
}

async function addCoin(c) {
  const body = { addCoin: { mint: c.mint, name: `Pump ${c.mint.slice(0,4)}`, symbol: "" } };
  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) console.error("AddCoin error", res.status);
    else console.log("Added coin", c.mint);
  } catch (e) { console.error("AddCoin failed", e); }
}

async function main() {
  const state = loadState();
  const recent = await fetchRecent();
  for (const c of recent) {
    if (state.seen[c.mint]) continue;
    await addCoin(c);
    state.seen[c.mint] = Date.now();
  }
  saveState(state);
}

main().catch(e => { console.error(e); process.exit(1); });
