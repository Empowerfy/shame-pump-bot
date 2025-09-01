// scan.js — detect Pump.fun txs even when logs are missing
import fs from "fs";

const HELIUS_KEY = process.env.HELIUS_KEY;
const API        = process.env.APPS_SCRIPT_API;

// ✅ confirmed Pump.fun bonding curve program id you found
const PROGRAM_IDS = [
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
];

const STATE_FILE = "last-pump.json";
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return { seen: {} }; } }
function saveState(s){ fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

if (!HELIUS_KEY || !API) {
  console.error("[scan] Missing env vars. HELIUS_KEY/APPS_SCRIPT_API");
  process.exit(1);
}
console.log("[scan] HELIUS_KEY set? ", !!HELIUS_KEY);
console.log("[scan] APPS_SCRIPT_API: ***");

// ---- HTTP helpers ----
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

// ---- extract helpers ----
function allProgramsInTx(tx) {
  const p = new Set();
  try {
    const ix = tx?.transaction?.message?.instructions || [];
    ix.forEach(i => i?.programId && p.add(i.programId));
    const inner = tx?.meta?.innerInstructions || [];
    inner.forEach(ii => (ii?.instructions || []).forEach(i => i?.programId && p.add(i.programId)));
  } catch {}
  return Array.from(p);
}

function firstMint(tx) {
  return (
    tx?.tokenTransfers?.[0]?.mint ||
    tx?.events?.token?.mint ||
    tx?.events?.nft?.mint ||
    null
  );
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

// ---- main ----
async function main() {
  const state = loadState();

  for (const pid of PROGRAM_IDS) {
    const light = await fetchAddressTxs(pid, 25);
    const sigs  = light.map(t => t.signature).filter(Boolean);
    if (!sigs.length) continue;

    const full = await fetchFullTxs(sigs);

    for (const tx of full) {
      const sig  = tx?.signature || "(no sig)";
      const logs = tx?.meta?.logMessages || [];
      const progs = allProgramsInTx(tx);
      const mint = firstMint(tx);

      console.log(`\n[scan] tx ${sig}`);
      console.log(`[scan]   programs: ${progs.join(", ") || "(none)"}`);
      if (logs.length) {
        const prev = logs.slice(0,3).join(" / ");
        console.log(`[scan]   preview logs: ${prev}`);
      } else {
        console.log("[scan]   preview logs: (no logs)");
      }
      console.log(`[scan]   mint: ${mint || "(none)"}`);

      // Hit if (a) our program id is in instructions/innerInstructions AND (b) we have a mint
      const touchesProgram = progs.some(p => PROGRAM_IDS.includes(p));
      if (!touchesProgram || !mint) continue;

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
