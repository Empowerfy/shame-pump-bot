// scan.js — only add coins AFTER bonding (Raydium pool exists / Raydium touched)
import fs from "fs";

const HELIUS_KEY = process.env.HELIUS_KEY;
const API        = process.env.APPS_SCRIPT_API;

// Pump.fun bonding curve program (your confirmed one)
const PUMP_PROGRAM_IDS = [
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
];

// Known Raydium program ids (AMM v4 + CLMM). Add more if you find others in real txs.
const RAYDIUM_PROGRAM_IDS = [
  // AMM v4 (common)
  "RVKd61ztZW9q8z…",     // <-- replace with the exact base58 you see in a bonded tx
  // CLMM (concentrated liquidity)
  "CAMMCzo…",            // <-- replace with the exact base58 you see in a bonded tx
].filter(Boolean);

// If you don’t know the exact Raydium IDs yet, keep the array empty and rely on the fallback
// HTTP verification below (raydiumHasPool), which checks Raydium’s public pool lists.

const STATE_FILE = "last-pump.json";
function loadState(){ try { return JSON.parse(fs.readFileSync(STATE_FILE,"utf8")); } catch { return { seen:{} }; } }
function saveState(s){ fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

if (!HELIUS_KEY || !API) {
  console.error("[scan] Missing env vars HELIUS_KEY/APPS_SCRIPT_API");
  process.exit(1);
}
console.log("[scan] HELIUS_KEY set?", !!HELIUS_KEY);
console.log("[scan] APPS_SCRIPT_API: ***");

async function fetchAddressTxs(addr, limit=25){
  const url = `https://api.helius.xyz/v0/addresses/${addr}/transactions?api-key=${HELIUS_KEY}&limit=${limit}`;
  console.log("[scan] GET", url.replace(/\?.*/, "?api-key=***"));
  const r = await fetch(url);
  if (!r.ok){ console.error("[scan] address txs error", r.status, await r.text()); return []; }
  const j = await r.json();
  console.log(`[scan] ${addr} -> ${j.length} light txs`);
  return j;
}
async function fetchFullTxs(sigs){
  if (!sigs.length) return [];
  const url = `https://api.helius.xyz/v0/transactions?api-key=${HELIUS_KEY}`;
  const body = JSON.stringify({ transactions: sigs });
  console.log(`[scan] fetching full txs for ${sigs.length} sigs`);
  const r = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json" }, body });
  if (!r.ok){ console.error("[scan] full txs error", r.status, await r.text()); return []; }
  const j = await r.json();
  console.log(`[scan] fetched ${j.length} full txs (with logs/inst)`);
  return j;
}

// ---- extract helpers ----
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const looksLikeMint = (s)=> !!s && typeof s==="string" && BASE58.test(s) && s.length>=32 && s.length<=44 && !s.toLowerCase().endsWith("pump");

function uniq(a){ return Array.from(new Set(a.filter(Boolean))); }

function extractMints(tx){
  const out = [];
  try { (tx?.tokenTransfers||[]).forEach(t=>t?.mint && out.push(t.mint)); } catch {}
  try { (tx?.meta?.postTokenBalances||[]).forEach(b=>b?.mint && out.push(b.mint)); } catch {}
  try { (tx?.meta?.preTokenBalances||[]).forEach(b=>b?.mint && out.push(b.mint)); } catch {}
  try { tx?.events?.token?.mint && out.push(tx.events.token.mint); } catch {}
  try { tx?.events?.nft?.mint   && out.push(tx.events.nft.mint); } catch {}
  return uniq(out).filter(looksLikeMint);
}

function allProgramsInTx(tx){
  const p = new Set();
  try {
    (tx?.transaction?.message?.instructions||[]).forEach(i=>i?.programId && p.add(i.programId));
    (tx?.meta?.innerInstructions||[]).forEach(ii => (ii?.instructions||[]).forEach(i=>i?.programId && p.add(i.programId)));
    (tx?.transaction?.message?.accountKeys||[]).forEach(k=>{
      const v = typeof k==="string" ? k : (k?.pubkey || k?.toString?.());
      if (v) p.add(v);
    });
  } catch {}
  return Array.from(p);
}

function raydiumTouched(tx){
  const progs = allProgramsInTx(tx);
  if (RAYDIUM_PROGRAM_IDS.length && progs.some(p=>RAYDIUM_PROGRAM_IDS.includes(p))) return true;
  // Helius sometimes annotates dex events
  try {
    const ev = tx?.events?.swap || tx?.events?.dex || null;
    if (ev && (String(ev.source||"").toLowerCase().includes("raydium") || String(ev.dex||"").toLowerCase().includes("raydium"))) return true;
  } catch {}
  return false;
}

// ---- fallback: query Raydium pool lists (public endpoints) ----
async function raydiumHasPool(mint){
  // try a few known endpoints; return true on first positive hit
  const endpoints = [
    "https://api.raydium.io/v2/sdk/liquidity/mainnet.json", // amm (official/unofficial)
    "https://api.raydium.io/v2/amm/pools",                  // legacy
    "https://api.raydium.io/v2/sdk/liquidity/ammV3/ids"     // clmm ids (may not carry mints)
  ];
  for (const url of endpoints){
    try {
      const r = await fetch(url, { headers: { "accept":"application/json" }});
      if (!r.ok) continue;
      const data = await r.json();
      // heuristics across shapes
      const pools = Array.isArray(data) ? data
                   : (Array.isArray(data?.official) || Array.isArray(data?.unOfficial))
                   ? [...(data.official||[]), ...(data.unOfficial||[])]
                   : (Array.isArray(data?.data) ? data.data : []);
      const hit = pools.some(p=>{
        const a = (p?.baseMint || p?.mintA || p?.mint1 || p?.mint)?.toString?.();
        const b = (p?.quoteMint|| p?.mintB || p?.mint2          )?.toString?.();
        return a===mint || b===mint;
      });
      if (hit) return true;
    } catch {}
  }
  return false;
}

async function addCoin(mint){
  const body = { addCoin: { mint, name: `Pump ${mint.slice(0,4)}`, symbol: "" } };
  try {
    const r = await fetch(API, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) });
    const t = await r.text();
    if (!r.ok){ console.error("[scan] addCoin failed", r.status, t); return false; }
    console.log("[scan] addCoin ok", mint, t);
    return true;
  } catch(e){ console.error("[scan] addCoin exception", e); return false; }
}

async function main(){
  const state = loadState();

  for (const pumpPid of PUMP_PROGRAM_IDS){
    const light = await fetchAddressTxs(pumpPid, 25);
    const sigs  = light.map(t=>t.signature).filter(Boolean);
    if (!sigs.length) continue;

    const full = await fetchFullTxs(sigs);

    for (const tx of full){
      const sig   = tx?.signature || "(no sig)";
      const mints = extractMints(tx);
      const progs = allProgramsInTx(tx);

      console.log(`\n[scan] tx ${sig}`);
      console.log(`[scan]   programs: ${progs.length ? progs.join(", ") : "(none)"}`);
      console.log(`[scan]   mints: ${mints.length ? mints.join(",") : "(none)"}`);

      if (!mints.length) continue;

      // Gating rule: require Raydium signal (touch OR verified pool)
      let bonded = raydiumTouched(tx);
      if (!bonded) {
        // Off-chain verify (rate-limited; ok for 25 sigs / 15min)
        for (const m of mints) {
          if (await raydiumHasPool(m)) { bonded = true; break; }
        }
      }
      if (!bonded) { console.log("[scan]   skip: no Raydium evidence yet"); continue; }

      for (const mint of mints){
        if (state.seen[mint]) { console.log("[scan]   already seen", mint); continue; }
        const ok = await addCoin(mint);
        if (ok) state.seen[mint] = Date.now();
      }
    }
  }

  saveState(state);
  console.log("[scan] done");
}

main().catch(e=>{ console.error(e); process.exit(1); });
