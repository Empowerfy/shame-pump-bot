// scan.js — add coins even when logs & program list aren't present
import fs from "fs";

const HELIUS_KEY = process.env.HELIUS_KEY;
const API        = process.env.APPS_SCRIPT_API;

// Confirmed Pump.fun Bonding Curve program (you found this)
const PROGRAM_IDS = [
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
];

const STATE_FILE = "last-pump.json";
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return { seen: {} }; } }
function saveState(s){ fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

if (!HELIUS_KEY || !API) {
  console.error("[scan] Missing env vars. HELIUS_KEY/APPS_SCRIPT_API required.");
  process.exit(1);
}
console.log("[scan] HELIUS_KEY set? ", !!HELIUS_KEY);
console.log("[scan] APPS_SCRIPT_API: ***");

// -------------------- HTTP helpers --------------------
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
  const url  = `https://api.helius.xyz/v0/transactions?api-key=${HELIUS_KEY}`;
  const body = JSON.stringify({ transactions: signatures });
  console.log(`[scan] fetching full txs for ${signatures.length} sigs`);
  const r = await fetch(url, { method: "POST", headers: { "Content-Type":"application/json" }, body });
  if (!r.ok) {
    console.error("[scan] full txs error", r.status, await r.text());
    return [];
  }
  const full = await r.json();
  console.log(`[scan] fetched ${full.length} full txs (with logs/inst)`);
  return full;
}

// -------------------- extract helpers --------------------
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;
function looksLikeMint(s) {
  if (!s || typeof s !== "string") return false;
  if (!BASE58_RE.test(s)) return false;
  if (s.length < 32 || s.length > 44) return false;
  if (s.toLowerCase().endsWith("pump")) return false; // PDAs often end 'pump'
  return true;
}

function unique(arr) { return Array.from(new Set(arr.filter(Boolean))); }

function extractMints(tx) {
  const mints = [];

  // 1) tokenTransfers
  try {
    (tx?.tokenTransfers || []).forEach(t => {
      if (t?.mint) mints.push(t.mint);
    });
  } catch {}

  // 2) meta.postTokenBalances / preTokenBalances
  try {
    (tx?.meta?.postTokenBalances || []).forEach(b => {
      if (b?.mint) mints.push(b.mint);
    });
    (tx?.meta?.preTokenBalances || []).forEach(b => {
      if (b?.mint) mints.push(b.mint);
    });
  } catch {}

  // 3) events
  try {
    if (tx?.events?.token?.mint) mints.push(tx.events.token.mint);
    if (tx?.events?.nft?.mint)   mints.push(tx.events.nft.mint);
  } catch {}

  return unique(mints).filter(looksLikeMint);
}

function allProgramsInTx(tx) {
  const p = new Set();
  try {
    const ix = tx?.transaction?.message?.instructions || [];
    ix.forEach(i => i?.programId && p.add(i.programId));
    const inner = tx?.meta?.innerInstructions || [];
    inner.forEach(ii => (ii?.instructions || []).forEach(i => i?.programId && p.add(i.programId)));
    // also scan account keys
    const keys = tx?.transaction?.message?.accountKeys || [];
    keys.forEach(k => {
      const v = typeof k === "string" ? k : (k?.pubkey || k?.toString?.());
      if (v) p.add(v);
    });
  } catch {}
  return Array.from(p);
}

async function addCoin(mint) {
  const body = { addCoin: { mint, name: `Pump ${mint.slice(0,4)}`, symbol: "" } };
  try {
    const r = await fetch(API, {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    if (!r.ok) { console.error("[scan] addCoin failed", r.status, text); return false; }
    console.log("[scan] addCoin ok", mint, text);
    return true;
  } catch (e) {
    console.error("[scan] addCoin exception", e);
    return false;
  }
}

// -------------------- main --------------------
async function main() {
  const state = loadState();

  for (const pid of PROGRAM_IDS) {
    const light = await fetchAddressTxs(pid, 25);
    const sigs  = light.map(t => t.signature).filter(Boolean);
    if (!sigs.length) continue;

    const full = await fetchFullTxs(sigs);

    for (const tx of full) {
      const sig   = tx?.signature || "(no sig)";
      const logs  = tx?.meta?.logMessages || [];
      const progs = allProgramsInTx(tx);
      const mints = extractMints(tx);

      console.log(`\n[scan] tx ${sig}`);
      console.log(`[scan]   programs: ${progs.length ? progs.join(", ") : "(none)"}`);
      console.log(`[scan]   mints: ${mints.length ? mints.join(",") : "(none)"}`);
      if (logs.length) {
        const prev = logs.slice(0,3).join(" / ");
        console.log(`[scan]   preview logs: ${prev}`);
      } else {
        console.log("[scan]   preview logs: (no logs)");
      }

      // Consider it a hit if:
      //  A) program id is visible in tx programs/accountKeys, OR
      //  B) we fetched txs from the program address (true), AND we have a valid mint.
      const touchesProgram = progs.some(p => PROGRAM_IDS.includes(p)) || true;

      if (!mints.length || !touchesProgram) continue;

      // Add each (usually there’s 1); skip already-seen
      for (const mint of mints) {
        if (state.seen[mint]) {
          console.log("[scan]   already seen", mint);
          continue;
        }
        const ok = await addCoin(mint);
        if (ok) state.seen[mint] = Date.now();
      }
    }
  }

  saveState(state);
  console.log("[scan] done");
}

main().catch(e => { console.error(e); process.exit(1); });
