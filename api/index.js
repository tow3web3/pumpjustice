require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const HELIUS_KEY = process.env.HELIUS_API_KEY;
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
const HELIUS_API = `https://api.helius.xyz/v0`;
const TWITTER_BEARER = process.env.TWITTER_BEARER;

// In-memory rate limit (best-effort in serverless — resets per cold start)
const submitTimes = {};

async function ensureDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS investigations (
      id SERIAL PRIMARY KEY,
      ca VARCHAR(64) NOT NULL,
      token_name VARCHAR(128),
      token_symbol VARCHAR(32),
      status VARCHAR(20) DEFAULT 'pending',
      risk_rating VARCHAR(20),
      submitted_at TIMESTAMP DEFAULT NOW(),
      completed_at TIMESTAMP,
      submitter_ip VARCHAR(45),
      upvotes INTEGER DEFAULT 0,
      downvotes INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS investigation_steps (
      id SERIAL PRIMARY KEY,
      investigation_id INTEGER REFERENCES investigations(id),
      agent_name VARCHAR(20) NOT NULL,
      step_type VARCHAR(50),
      content TEXT NOT NULL,
      data JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS votes (
      id SERIAL PRIMARY KEY,
      investigation_id INTEGER REFERENCES investigations(id),
      voter_ip VARCHAR(45),
      vote_type VARCHAR(4),
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(investigation_id, voter_ip)
    );
  `);
}

// ─── INVESTIGATION PIPELINE ───

async function addStep(invId, agent, stepType, content, data = null) {
  await pool.query(
    'INSERT INTO investigation_steps (investigation_id, agent_name, step_type, content, data) VALUES ($1,$2,$3,$4,$5)',
    [invId, agent, stepType, content, data ? JSON.stringify(data) : null]
  );
}

async function stepNexus(invId, ca) {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${ca}`);
    const json = await res.json();
    const pair = json.pairs?.find(p => p.chainId === 'solana' && (p.baseToken?.address === ca || p.quoteToken?.address === ca));
    if (pair) {
      const info = {
        name: pair.baseToken?.name, symbol: pair.baseToken?.symbol,
        price: pair.priceUsd, priceChange24h: pair.priceChange?.h24,
        volume24h: pair.volume?.h24, fdv: pair.fdv,
        liquidity: pair.liquidity?.usd, pairCreated: pair.pairCreatedAt,
        dexUrl: pair.url
      };
      await pool.query('UPDATE investigations SET token_name=$1, token_symbol=$2 WHERE id=$3',
        [info.name, info.symbol, invId]);
      const age = pair.pairCreatedAt ? Math.round((Date.now() - pair.pairCreatedAt) / 3600000) + 'h' : 'unknown';
      await addStep(invId, 'NEXUS', 'token_info',
        `Token: ${info.name} ($${info.symbol}) | Price: $${info.price} | 24h: ${info.priceChange24h}% | Vol: $${Number(info.volume24h||0).toLocaleString()} | FDV: $${Number(info.fdv||0).toLocaleString()} | Liquidity: $${Number(info.liquidity||0).toLocaleString()} | Age: ${age}`,
        info);
      return info;
    } else {
      await addStep(invId, 'NEXUS', 'token_info', `No DexScreener data found for ${ca}. Token may not have bonded yet or CA is invalid.`, null);
      return null;
    }
  } catch (e) {
    await addStep(invId, 'NEXUS', 'token_info', `DexScreener lookup failed: ${e.message}`, null);
    return null;
  }
}

async function stepTracer(invId, ca) {
  try {
    const assetRes = await fetch(HELIUS_RPC, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAsset', params: { id: ca } })
    });
    const asset = await assetRes.json();
    const authorities = asset.result?.authorities || [];
    const creator = authorities[0]?.address || null;

    if (!creator) {
      await addStep(invId, 'TRACER', 'wallet_analysis', `Could not identify deployer wallet for ${ca.slice(0,8)}...${ca.slice(-4)}`, null);
      return null;
    }

    const txRes = await fetch(`${HELIUS_API}/addresses/${creator}/transactions?api-key=${HELIUS_KEY}&limit=50`);
    const txs = await txRes.json();

    const balRes = await fetch(HELIUS_RPC, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [creator] })
    });
    const bal = await balRes.json();
    const solBalance = (bal.result?.value || 0) / 1e9;

    const txCount = Array.isArray(txs) ? txs.length : 0;
    const tokenCreations = Array.isArray(txs) ? txs.filter(t => t.type === 'TOKEN_MINT' || t.description?.includes('mint')).length : 0;
    const walletAge = Array.isArray(txs) && txs.length > 0 ?
      Math.round((Date.now() / 1000 - txs[txs.length - 1].timestamp) / 86400) + ' days' : 'unknown';

    const data = { creator, txCount, tokenCreations, solBalance, walletAge };
    await addStep(invId, 'TRACER', 'wallet_analysis',
      `Deployer: ${creator.slice(0,8)}...${creator.slice(-4)} | Balance: ${solBalance.toFixed(2)} SOL | Transactions: ${txCount}+ | Token mints detected: ${tokenCreations} | Wallet age: ${walletAge}`,
      data);
    return data;
  } catch (e) {
    await addStep(invId, 'TRACER', 'wallet_analysis', `Wallet analysis failed: ${e.message}`, null);
    return null;
  }
}

async function stepCipher(invId, ca, tracerData) {
  try {
    if (!tracerData?.creator) {
      await addStep(invId, 'CIPHER', 'pattern_check', 'No deployer data available for pattern analysis.', null);
      return null;
    }
    const creator = tracerData.creator;

    const res = await fetch(HELIUS_RPC, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAssetsByAuthority', params: { authorityAddress: creator, page: 1, limit: 20 } })
    });
    const json = await res.json();
    const assets = json.result?.items || [];
    const fungibles = assets.filter(a => a.interface === 'FungibleToken' || a.interface === 'FungibleAsset');

    const patterns = [];
    if (fungibles.length > 3) patterns.push(`⚠️ SERIAL DEPLOYER: ${fungibles.length} tokens created by this wallet`);
    if (tracerData.txCount < 10) patterns.push('⚠️ LOW ACTIVITY: Wallet has very few transactions — likely burner');
    if (tracerData.solBalance < 0.1) patterns.push('⚠️ DRAINED: Wallet nearly empty — funds likely moved out');
    if (tracerData.walletAge && parseInt(tracerData.walletAge) < 7) patterns.push('⚠️ NEW WALLET: Created within last week');
    if (patterns.length === 0) patterns.push('No obvious red flag patterns detected. Further manual review recommended.');

    const data = { tokensByDeployer: fungibles.length, patterns };
    await addStep(invId, 'CIPHER', 'pattern_check',
      `Deployer ${creator.slice(0,8)}...${creator.slice(-4)} — ${fungibles.length} fungible tokens found.\n${patterns.join('\n')}`,
      data);
    return data;
  } catch (e) {
    await addStep(invId, 'CIPHER', 'pattern_check', `Pattern analysis failed: ${e.message}`, null);
    return null;
  }
}

async function stepGhost(invId, ca) {
  try {
    const res = await fetch(`https://api.twitter.com/2/tweets/search/recent?query=${ca}&max_results=10&tweet.fields=author_id,created_at&expansions=author_id&user.fields=username`, {
      headers: { 'Authorization': `Bearer ${TWITTER_BEARER}` }
    });
    const json = await res.json();

    if (json.data && json.data.length > 0) {
      const users = {};
      (json.includes?.users || []).forEach(u => { users[u.id] = u.username; });
      const mentions = json.data.map(t => ({
        user: users[t.author_id] || t.author_id,
        text: t.text.slice(0, 120),
        date: t.created_at
      }));
      await addStep(invId, 'GHOST', 'social_search',
        `Found ${json.data.length} tweets mentioning this CA:\n${mentions.map(m => `• @${m.user}: "${m.text}..."`).join('\n')}`,
        { tweets: mentions });
      return mentions;
    } else {
      await addStep(invId, 'GHOST', 'social_search',
        `No tweets found mentioning CA ${ca.slice(0,8)}...${ca.slice(-4)}. Token has zero social footprint — anonymous deployer.`,
        { tweets: [] });
      return [];
    }
  } catch (e) {
    await addStep(invId, 'GHOST', 'social_search', `X/Twitter search unavailable: ${e.message}. Social analysis skipped.`, null);
    return null;
  }
}

async function stepViper(invId, nexusData, tracerData, cipherData, ghostData) {
  let score = 0;
  const flags = [];

  if (nexusData) {
    if (nexusData.priceChange24h < -90) { score += 40; flags.push('Token dropped >90% in 24h'); }
    else if (nexusData.priceChange24h < -80) { score += 30; flags.push('Token dropped >80% in 24h'); }
    else if (nexusData.priceChange24h < -50) { score += 15; flags.push('Token dropped >50% in 24h'); }
    if (nexusData.liquidity < 1000) { score += 15; flags.push('Liquidity under $1K'); }
    if (nexusData.pairCreated && (Date.now() - nexusData.pairCreated) < 3600000) { score += 10; flags.push('Token less than 1 hour old'); }
  }

  if (tracerData) {
    if (tracerData.tokenCreations > 3) { score += 20; flags.push(`Deployer created ${tracerData.tokenCreations}+ tokens`); }
    if (tracerData.solBalance < 0.1) { score += 10; flags.push('Deployer wallet drained'); }
    if (tracerData.txCount < 10) { score += 10; flags.push('Deployer is a burner wallet'); }
  }

  if (cipherData?.tokensByDeployer > 5) { score += 15; flags.push('Serial deployer pattern'); }
  if (ghostData && Array.isArray(ghostData) && ghostData.length === 0) { score += 5; flags.push('No social presence'); }

  let rating;
  if (score >= 60) rating = 'CRITICAL';
  else if (score >= 40) rating = 'HIGH';
  else if (score >= 20) rating = 'MEDIUM';
  else rating = 'LOW';

  await pool.query('UPDATE investigations SET risk_rating=$1 WHERE id=$2', [rating, invId]);

  const data = { score, rating, flags };
  await addStep(invId, 'VIPER', 'risk_assessment',
    `Risk Rating: ${rating} (score: ${score}/100)\nFlags:\n${flags.map(f => `• ${f}`).join('\n') || '• No significant risk flags detected'}`,
    data);
  return data;
}

async function stepSentinel(invId, ca, nexusData, tracerData, cipherData, ghostData, viperData) {
  const name = nexusData?.name || 'Unknown Token';
  const symbol = nexusData?.symbol || '???';
  const rating = viperData?.rating || 'UNKNOWN';
  const flags = viperData?.flags || [];
  const deployer = tracerData?.creator ? `${tracerData.creator.slice(0,8)}...${tracerData.creator.slice(-4)}` : 'unknown';

  let verdict;
  if (rating === 'CRITICAL') verdict = `$${symbol} is almost certainly a rugpull or scam. Multiple critical risk indicators detected.`;
  else if (rating === 'HIGH') verdict = `$${symbol} shows strong signs of being a scam. Exercise extreme caution.`;
  else if (rating === 'MEDIUM') verdict = `$${symbol} has some concerning indicators but is not conclusively a scam. Proceed with caution.`;
  else verdict = `$${symbol} does not show obvious scam indicators at this time. Standard due diligence recommended.`;

  const report = `═══ INVESTIGATION REPORT ═══\n` +
    `Token: ${name} ($${symbol})\n` +
    `CA: ${ca}\n` +
    `Deployer: ${deployer}\n` +
    `Risk: ${rating}\n` +
    `─────────────────────────\n` +
    `${verdict}\n` +
    (flags.length > 0 ? `\nKey findings:\n${flags.map(f => `  • ${f}`).join('\n')}` : '') +
    `\n─────────────────────────\n` +
    `Investigation complete. ${6} agents participated.`;

  await addStep(invId, 'SENTINEL', 'final_report', report, { rating, verdict, flags });
  await pool.query('UPDATE investigations SET status=$1, completed_at=NOW() WHERE id=$2', ['complete', invId]);
}

async function runInvestigation(invId, ca) {
  try {
    await pool.query('UPDATE investigations SET status=$1 WHERE id=$2', ['investigating', invId]);

    const nexus = await stepNexus(invId, ca);
    const tracer = await stepTracer(invId, ca);
    const cipher = await stepCipher(invId, ca, tracer);
    const ghost = await stepGhost(invId, ca);
    const viper = await stepViper(invId, nexus, tracer, cipher, ghost);
    await stepSentinel(invId, ca, nexus, tracer, cipher, ghost, viper);

    console.log(`[SENTINEL] Investigation #${invId} complete — ${viper?.rating || 'UNKNOWN'}`);
  } catch (e) {
    console.error(`[ERROR] Investigation #${invId} failed:`, e.message);
    await pool.query('UPDATE investigations SET status=$1 WHERE id=$2', ['failed', invId]);
    await addStep(invId, 'SENTINEL', 'final_report', `Investigation failed: ${e.message}`, null);
  }
}

// ─── API ROUTES ───

app.post('/api/investigate', async (req, res) => {
  const { ca } = req.body;
  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';

  if (!ca || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ca)) {
    return res.status(400).json({ error: 'Invalid CA format' });
  }

  const now = Date.now();
  if (submitTimes[ip] && now - submitTimes[ip] < 60000) {
    return res.status(429).json({ error: 'Rate limited. Wait 1 minute between submissions.' });
  }
  submitTimes[ip] = now;

  try {
    await ensureDB();

    const existing = await pool.query(
      'SELECT id, status FROM investigations WHERE ca=$1 AND status IN ($2,$3) ORDER BY id DESC LIMIT 1',
      [ca, 'investigating', 'complete']
    );
    if (existing.rows.length > 0) {
      return res.json({ id: existing.rows[0].id, status: existing.rows[0].status, existing: true });
    }

    const result = await pool.query(
      'INSERT INTO investigations (ca, status, submitter_ip) VALUES ($1, $2, $3) RETURNING id',
      [ca, 'pending', ip]
    );
    const invId = result.rows[0].id;

    // Fire-and-forget: Vercel keeps the lambda alive until the event loop drains
    runInvestigation(invId, ca);

    res.json({ id: invId, status: 'investigating' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/investigations', async (req, res) => {
  try {
    await ensureDB();
    const result = await pool.query(`
      SELECT i.*, COUNT(s.id) as step_count
      FROM investigations i
      LEFT JOIN investigation_steps s ON s.investigation_id = i.id
      GROUP BY i.id
      ORDER BY i.submitted_at DESC
      LIMIT 50
    `);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/investigation/:id', async (req, res) => {
  try {
    await ensureDB();
    const inv = await pool.query('SELECT * FROM investigations WHERE id=$1', [req.params.id]);
    if (inv.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const steps = await pool.query('SELECT * FROM investigation_steps WHERE investigation_id=$1 ORDER BY created_at', [req.params.id]);
    res.json({ ...inv.rows[0], steps: steps.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/feed', async (req, res) => {
  try {
    await ensureDB();
    const result = await pool.query(`
      SELECT s.*, i.ca, i.token_name, i.token_symbol
      FROM investigation_steps s
      JOIN investigations i ON i.id = s.investigation_id
      ORDER BY s.created_at DESC
      LIMIT 50
    `);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/vote/:id', async (req, res) => {
  const { type } = req.body;
  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  const invId = req.params.id;

  if (!['up', 'down'].includes(type)) return res.status(400).json({ error: 'Invalid vote type' });

  try {
    await ensureDB();
    await pool.query(
      'INSERT INTO votes (investigation_id, voter_ip, vote_type) VALUES ($1,$2,$3) ON CONFLICT (investigation_id, voter_ip) DO UPDATE SET vote_type=$3',
      [invId, ip, type]
    );
    await pool.query(
      `UPDATE investigations SET upvotes=(SELECT COUNT(*) FROM votes WHERE investigation_id=$1 AND vote_type='up'), downvotes=(SELECT COUNT(*) FROM votes WHERE investigation_id=$1 AND vote_type='down') WHERE id=$1`,
      [invId]
    );
    const inv = await pool.query('SELECT upvotes, downvotes FROM investigations WHERE id=$1', [invId]);
    res.json(inv.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = app;
