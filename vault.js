// Vercel serverless function: GET /api/vault?address=<vault>
// Reads the vault wallet from Solana through Helius. Needs env HELIUS_API_KEY.
// Optional env VAULT_ADDRESS locks the endpoint to that one wallet.
const SPCX = process.env.SPCX_MINT || 'SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN22 = 'TokenzQdBNbLqP5VEhdkAxS8XF4CdbRqQ5nPWjtmhBjL';
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const cache = new Map();

async function rpc(batch) {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error('HELIUS_API_KEY not set');
  const r = await fetch('https://mainnet.helius-rpc.com/?api-key=' + encodeURIComponent(key), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(batch.map((b, i) => ({ jsonrpc: '2.0', id: i, method: b[0], params: b[1] }))),
  });
  if (!r.ok) throw new Error('rpc http ' + r.status);
  const j = await r.json();
  const out = [];
  for (const x of Array.isArray(j) ? j : [j]) out[x.id] = x;
  return out;
}

function tokenRows(res, program) {
  const v = res && res.result && res.result.value;
  if (!Array.isArray(v)) return [];
  return v.map(a => {
    const info = a.account && a.account.data && a.account.data.parsed && a.account.data.parsed.info;
    if (!info) return null;
    const ta = info.tokenAmount || {};
    return { mint: info.mint, account: a.pubkey, amount: ta.amount, decimals: ta.decimals, ui: +ta.uiAmountString || 0, program };
  }).filter(Boolean);
}

function spcxDelta(tx, owner) {
  const m = tx && tx.meta;
  if (!m) return null;
  const sum = arr => (arr || []).filter(b => b.owner === owner && b.mint === SPCX).reduce((s, b) => s + (+b.uiTokenAmount.amount || 0), 0);
  const d = sum(m.postTokenBalances) - sum(m.preTokenBalances);
  const keys = (tx.transaction && tx.transaction.message && tx.transaction.message.accountKeys) || [];
  const idx = keys.findIndex(k => (k.pubkey || k) === owner);
  const sol = idx >= 0 ? ((m.postBalances[idx] || 0) - (m.preBalances[idx] || 0)) / 1e9 : null;
  return { spcx: d / 1e6, sol };
}

async function load(address) {
  const first = await rpc([
    ['getBalance', [address, { commitment: 'confirmed' }]],
    ['getTokenAccountsByOwner', [address, { programId: TOKEN }, { encoding: 'jsonParsed', commitment: 'confirmed' }]],
    ['getTokenAccountsByOwner', [address, { programId: TOKEN22 }, { encoding: 'jsonParsed', commitment: 'confirmed' }]],
    ['getSignaturesForAddress', [address, { limit: 20, commitment: 'confirmed' }]],
  ]);
  for (const r of first) if (r && r.error) throw new Error(r.error.message || 'rpc error');
  const sol = ((first[0].result && first[0].result.value) || 0) / 1e9;
  const tokens = [...tokenRows(first[1], 'token'), ...tokenRows(first[2], 'token-2022')];
  const spcx = tokens.filter(t => t.mint === SPCX).reduce((s, t) => s + t.ui, 0);
  const sigs = (first[3].result || []).map(s => ({ sig: s.signature, time: s.blockTime || null, err: !!s.err }));

  // Parse the most recent successful transactions to find SPCX buys (balance increases).
  const ok = sigs.filter(s => !s.err).slice(0, 12);
  let buys = [];
  if (ok.length) {
    const txs = await rpc(ok.map(s => ['getTransaction', [s.sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]]));
    buys = ok.map((s, i) => {
      const d = spcxDelta(txs[i] && txs[i].result, address);
      return d && d.spcx > 0 ? { sig: s.sig, time: s.time, spcx: d.spcx, sol: d.sol } : null;
    }).filter(Boolean);
  }
  return { address, sol, spcx, tokens, buys, txs: sigs, updated: Date.now() };
}

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  const lock = process.env.VAULT_ADDRESS;
  const q = (req.query && req.query.address) || new URL(req.url, 'http://x').searchParams.get('address') || '';
  const address = lock || q;
  if (!B58.test(address) || (lock && q && q !== lock)) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: 'bad address' }));
  }
  try {
    const hit = cache.get(address);
    let data;
    if (hit && Date.now() - hit.t < 30000) data = hit.d;
    else {
      data = await load(address);
      cache.set(address, { t: Date.now(), d: data });
    }
    res.setHeader('cache-control', 'public, s-maxage=30, stale-while-revalidate=60');
    res.statusCode = 200;
    res.end(JSON.stringify(data));
  } catch (e) {
    const hit = cache.get(address);
    if (hit) { res.statusCode = 200; return res.end(JSON.stringify({ ...hit.d, stale: true })); }
    res.statusCode = 502;
    res.end(JSON.stringify({ error: 'vault read failed' }));
  }
};
