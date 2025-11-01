import fs from 'fs';
import { fetch } from 'undici';

const API = 'https://linera-api.pulsar.money/api/v1/pulsar';
const ORIGIN = 'https://portal.linera.net';

function ts(){ return new Date().toISOString(); }
const sleep = (ms)=> new Promise(r=>setTimeout(r, ms));

function parseArgs() {
  const a = process.argv.slice(2);
  const i = a.indexOf('--every');
  const h = i >= 0 ? Number(a[i+1]) : 24;
  return { intervalHours: Number.isFinite(h) && h > 0 ? h : 24 };
}

/**
 * Fungsi untuk memuat daftar akun dari accounts.json.
 */
function loadAccounts() {
  const accountFilePath = 'accounts.json';
  if (!fs.existsSync(accountFilePath)) {
    throw new Error(`File '${accountFilePath}' tidak ditemukan. Buat file accounts.json.`);
  }
  const txt = fs.readFileSync(accountFilePath, 'utf8');
  let accounts = null;
  try {
    accounts = JSON.parse(txt);
  } catch (e) {
    throw new Error(`Gagal parse accounts.json: ${e.message}`);
  }
  
  if (!Array.isArray(accounts) || accounts.length === 0) {
      throw new Error('accounts.json harus berupa array dan tidak boleh kosong.');
  }

  // Verifikasi setiap akun memiliki token yang diperlukan
  for (const account of accounts) {
    if (!account.DYNAMIC_TOKEN) {
      throw new Error(`Akun "${account.nama || 'Tanpa Nama'}" tidak memiliki DYNAMIC_TOKEN.`);
    }
  }

  return accounts;
}

async function getJson(url, headers) {
  const r = await fetch(url, { headers });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: r.status, json, raw: text };
}
async function postJson(url, headers, body) {
  const r = await fetch(url, { method:'POST', headers:{...headers,'Content-Type':'application/json'}, body: JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: r.status, json };
}

/**
 * Menjalankan tugas sekali untuk satu akun.
 * @param {object} account Objek akun yang berisi token.
 */
async function runOnce(account) {
  const accountName = account.nama || 'Tanpa Nama';
  const headers = {
    Accept: 'application/json',
    Origin: ORIGIN,
    'X-Dynamic-Token': account.DYNAMIC_TOKEN,
  };
  if (account.ACCESS_TOKEN) headers['X-Access-Token'] = account.ACCESS_TOKEN;
  if (account.DEVICE_SIGNATURE) headers['X-Device-Signature'] = account.DEVICE_SIGNATURE; // opsional

  console.log(`\n--- [${ts()}] Mulai untuk Akun: ${accountName} ---`);

  // Warm-up
  const warm = await fetch(`${API}/social-pay/me`, { headers: { ...headers, 'Cache-Control':'no-cache' }});
  console.log(`[${ts()}] ${accountName} | Warm-up status: ${warm.status}`);
  if (warm.status === 401) throw new Error(`401 (cek DYNAMIC_TOKEN/SIGNATURE untuk ${accountName})`);

  // Ambil task
  const tasks = await getJson(`${API}/challenges/linera/1`, { ...headers, 'Cache-Control':'no-cache' });
  if (tasks.status !== 200) throw new Error(`Fetch tasks gagal: ${tasks.status} ${String(tasks.raw).slice(0,160)}`);

  const list = tasks.json?.tasks || [];
  const re = /\bdaily\b|\bcheck[- ]?in\b/i;
  const cand = list
    .filter(t => t.isEnabled !== false && re.test([t.taskName||'', t.title||'', t.type||'', t.slug||''].join(' ')))
    .sort((a,b)=>(a.displayOrder ?? 1e9) - (b.displayOrder ?? 1e9))[0];
  if (!cand) throw new Error(`Task daily/check-in tidak ditemukan untuk ${accountName}`);

  console.log(`[${ts()}] ${accountName} | Daily: ${cand.title || cand.taskName || cand.id} ${cand.id}`);

  // Submit
  const res = await postJson(`${API}/challenges/do-task`, headers, { taskGuid: cand.id, extraArguments: [] });
  const msg = JSON.stringify(res.json || {});
  if (
    res.status === 201 || res.json?.status === true ||
    (res.status === 200 && /already/i.test(msg)) ||
    (res.status === 400 && /already/i.test(msg))
  ) {
    const state = res.json?.state ?? (/already/i.test(msg) ? 'ALREADY_CLAIMED' : 'OK');
    const points = res.json?.points ?? res.json?.pointsAwarded ?? null;
    console.log(`[${ts()}] ${accountName} | Submit OK: ${state}${points ? ` (+${points})` : ''}`);
    return;
  }
  throw new Error(`Submit gagal: ${res.status} ${msg.slice(0,200)}`);
}

(async () => {
  const { intervalHours } = parseArgs();
  console.log(`[${ts()}] Daemon start — interval ${intervalHours} jam.`);
  process.on('SIGINT', ()=>{ console.log(`\n[${ts()}] Stop.`); process.exit(0); });
  process.on('SIGTERM', ()=>{ console.log(`\n[${ts()}] Stop.`); process.exit(0); });

  let attempt = 0;
  while (true) {
    try {
      const accounts = loadAccounts();
      console.log(`[${ts()}] Ditemukan ${accounts.length} akun.`);

      for (const account of accounts) {
        try {
          await runOnce(account);
          // Jeda sebentar antar akun untuk memitigasi rate limiting
          await sleep(5000); 
        } catch (e) {
          const accountName = account.nama || 'Tanpa Nama';
          console.error(`[${ts()}] 🚫 GAGAL untuk Akun ${accountName}: ${e.message || e}`);
          // Lanjutkan ke akun berikutnya
        }
      }
      
      attempt = 0;
      const jitterMs = Math.floor(Math.random()*30000); // jitter <=30s 
      const waitMs = intervalHours*3600000 + jitterMs;
      const waitTimeHours = (waitMs / 3600000).toFixed(2);
      console.log(`\n[${ts()}] ✅ Semua akun selesai. Next run in ~${waitTimeHours} jam.`);
      await sleep(waitMs);

    } catch (e) {
      attempt += 1;
      const backoff = Math.min(120, 10*attempt); // 10s, 20s, ... max 120s
      console.error(`[${ts()}] 🛑 ERROR Kritis (gagal memuat/loop utama): ${e.message || e}. Retry dalam ${backoff}s`);
      await sleep(backoff*1000);
    }
  }
})();
