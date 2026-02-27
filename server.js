require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const HELIUS_KEY = process.env.HELIUS_API_KEY;
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
const HELIUS_API = `https://api.helius.xyz/v0`;
const TWITTER_BEARER = process.env.TWITTER_BEARER;

const submitTimes = {};

async function initDB() {
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
    CREATE TABLE IF NOT EXISTS comments (
      id SERIAL PRIMARY KEY,
      investigation_id INTEGER REFERENCES investigations(id),
      author_name VARCHAR(64) DEFAULT 'Anonymous',
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      upvotes INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS flagged_wallets (
      id SERIAL PRIMARY KEY,
      address VARCHAR(64) UNIQUE NOT NULL,
      first_seen TIMESTAMP DEFAULT NOW(),
      flag_count INTEGER DEFAULT 1,
      total_tokens INTEGER DEFAULT 0,
      investigations JSONB DEFAULT '[]'
    );
  `);
  console.log('[DB] Tables ready');
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

    // Auto-flag serial deployers
    if (fungibles.length > 3) {
      try {
        await pool.query(`
          INSERT INTO flagged_wallets (address, total_tokens, investigations)
          VALUES ($1, $2, $3)
          ON CONFLICT (address) DO UPDATE SET
            flag_count = flagged_wallets.flag_count + 1,
            total_tokens = $2,
            investigations = (
              SELECT jsonb_agg(DISTINCT val) FROM (
                SELECT jsonb_array_elements(flagged_wallets.investigations) AS val
                UNION SELECT to_jsonb($4::int) AS val
              ) sub
            )
        `, [creator, fungibles.length, JSON.stringify([invId]), invId]);
      } catch(e) { console.error('[CIPHER] Flag wallet error:', e.message); }
    }

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
    `Investigation complete. 6 agents participated.`;

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
  const ip = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket.remoteAddress;
  
  if (!ca || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ca)) {
    return res.status(400).json({ error: 'Invalid CA format' });
  }
  
  const now = Date.now();
  if (submitTimes[ip] && now - submitTimes[ip] < 60000) {
    return res.status(429).json({ error: 'Rate limited. Wait 1 minute between submissions.' });
  }
  submitTimes[ip] = now;

  const existing = await pool.query('SELECT id, status FROM investigations WHERE ca=$1 AND status IN ($2,$3) ORDER BY id DESC LIMIT 1', [ca, 'investigating', 'complete']);
  if (existing.rows.length > 0) {
    return res.json({ id: existing.rows[0].id, status: existing.rows[0].status, existing: true });
  }

  const result = await pool.query(
    'INSERT INTO investigations (ca, status, submitter_ip) VALUES ($1, $2, $3) RETURNING id',
    [ca, 'investigating', ip]
  );
  const invId = result.rows[0].id;
  
  runInvestigation(invId, ca);
  
  res.json({ id: invId, status: 'investigating' });
});

app.get('/api/investigations', async (req, res) => {
  const { risk, sort } = req.query;
  let where = '';
  if (risk && ['CRITICAL','HIGH','MEDIUM','LOW'].includes(risk)) {
    where = ` WHERE i.risk_rating = '${risk}'`;
  }
  let order = 'i.submitted_at DESC';
  if (sort === 'votes') order = '(i.upvotes - i.downvotes) DESC';
  else if (sort === 'comments') order = 'comment_count DESC';
  
  const result = await pool.query(`
    SELECT i.*, COUNT(DISTINCT s.id) as step_count, COUNT(DISTINCT c.id) as comment_count
    FROM investigations i 
    LEFT JOIN investigation_steps s ON s.investigation_id = i.id 
    LEFT JOIN comments c ON c.investigation_id = i.id
    ${where}
    GROUP BY i.id 
    ORDER BY ${order}
    LIMIT 100
  `);
  res.json(result.rows);
});

app.get('/api/investigation/:id', async (req, res) => {
  const inv = await pool.query('SELECT * FROM investigations WHERE id=$1', [req.params.id]);
  if (inv.rows.length === 0) return res.status(404).json({ error: 'Not found' });
  const steps = await pool.query('SELECT * FROM investigation_steps WHERE investigation_id=$1 ORDER BY created_at', [req.params.id]);
  res.json({ ...inv.rows[0], steps: steps.rows });
});

app.get('/api/feed', async (req, res) => {
  const result = await pool.query(`
    SELECT s.*, i.ca, i.token_name, i.token_symbol 
    FROM investigation_steps s 
    JOIN investigations i ON i.id = s.investigation_id 
    ORDER BY s.created_at DESC 
    LIMIT 50
  `);
  res.json(result.rows);
});

app.post('/api/vote/:id', async (req, res) => {
  const { type } = req.body;
  const ip = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket.remoteAddress;
  const invId = req.params.id;
  
  if (!['up', 'down'].includes(type)) return res.status(400).json({ error: 'Invalid vote type' });
  
  try {
    await pool.query('INSERT INTO votes (investigation_id, voter_ip, vote_type) VALUES ($1,$2,$3) ON CONFLICT (investigation_id, voter_ip) DO UPDATE SET vote_type=$3',
      [invId, ip, type]);
    await pool.query(`UPDATE investigations SET upvotes=(SELECT COUNT(*) FROM votes WHERE investigation_id=$1 AND vote_type='up'), downvotes=(SELECT COUNT(*) FROM votes WHERE investigation_id=$1 AND vote_type='down') WHERE id=$1`, [invId]);
    const inv = await pool.query('SELECT upvotes, downvotes FROM investigations WHERE id=$1', [invId]);
    res.json(inv.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── COMMENTS ───

app.get('/api/comments/:invId', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM comments WHERE investigation_id=$1 ORDER BY created_at DESC',
      [req.params.invId]
    );
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/comment/:invId', async (req, res) => {
  const { content, author_name } = req.body;
  if (!content || content.trim().length === 0) return res.status(400).json({ error: 'Content required' });
  if (content.length > 1000) return res.status(400).json({ error: 'Comment too long (max 1000 chars)' });
  
  try {
    const inv = await pool.query('SELECT id FROM investigations WHERE id=$1', [req.params.invId]);
    if (inv.rows.length === 0) return res.status(404).json({ error: 'Investigation not found' });
    
    const result = await pool.query(
      'INSERT INTO comments (investigation_id, author_name, content) VALUES ($1,$2,$3) RETURNING *',
      [req.params.invId, (author_name || '').trim() || 'Anonymous', content.trim()]
    );
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── STATS ───

app.get('/api/stats', async (req, res) => {
  try {
    const [invs, scams, votes, comments] = await Promise.all([
      pool.query("SELECT COUNT(*) as count FROM investigations"),
      pool.query("SELECT COUNT(*) as count FROM investigations WHERE risk_rating IN ('CRITICAL','HIGH')"),
      pool.query("SELECT COUNT(*) as count FROM votes"),
      pool.query("SELECT COUNT(*) as count FROM comments"),
    ]);
    res.json({
      totalInvestigations: parseInt(invs.rows[0].count),
      scamsCaught: parseInt(scams.rows[0].count),
      totalVotes: parseInt(votes.rows[0].count),
      totalComments: parseInt(comments.rows[0].count),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── REGISTRY ───

app.get('/api/registry', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM flagged_wallets ORDER BY flag_count DESC, total_tokens DESC LIMIT 100');
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/registry/:address', async (req, res) => {
  try {
    const wallet = await pool.query('SELECT * FROM flagged_wallets WHERE address=$1', [req.params.address]);
    if (wallet.rows.length === 0) return res.status(404).json({ error: 'Wallet not found' });
    
    // Get associated investigations
    const invIds = wallet.rows[0].investigations || [];
    let investigations = [];
    if (invIds.length > 0) {
      const result = await pool.query(
        'SELECT * FROM investigations WHERE id = ANY($1) ORDER BY submitted_at DESC',
        [invIds]
      );
      investigations = result.rows;
    }
    
    // Also find investigations where this wallet is the deployer
    const byDeployer = await pool.query(`
      SELECT DISTINCT i.* FROM investigations i
      JOIN investigation_steps s ON s.investigation_id = i.id
      WHERE s.agent_name = 'TRACER' AND s.data->>'creator' = $1
      ORDER BY i.submitted_at DESC
    `, [req.params.address]);
    
    // Merge
    const allInvs = [...investigations];
    for (const inv of byDeployer.rows) {
      if (!allInvs.find(i => i.id === inv.id)) allInvs.push(inv);
    }
    
    res.json({ ...wallet.rows[0], associated_investigations: allInvs });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/registry/report', async (req, res) => {
  const { address } = req.body;
  if (!address || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }
  try {
    await pool.query(`
      INSERT INTO flagged_wallets (address, total_tokens, investigations)
      VALUES ($1, 0, '[]')
      ON CONFLICT (address) DO UPDATE SET flag_count = flagged_wallets.flag_count + 1
    `, [address]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── LEADERBOARD ───

app.get('/api/leaderboard', async (req, res) => {
  try {
    const [submitters, voters] = await Promise.all([
      pool.query(`
        SELECT 
          'Investigator #' || ROW_NUMBER() OVER (ORDER BY COUNT(*) DESC) as name,
          COUNT(*) as submissions,
          COUNT(CASE WHEN risk_rating IN ('CRITICAL','HIGH') THEN 1 END) as scams_found
        FROM investigations
        WHERE submitter_ip IS NOT NULL
        GROUP BY submitter_ip
        ORDER BY COUNT(*) DESC
        LIMIT 20
      `),
      pool.query(`
        SELECT 
          'Voter #' || ROW_NUMBER() OVER (ORDER BY COUNT(*) DESC) as name,
          COUNT(*) as total_votes
        FROM votes
        WHERE voter_ip IS NOT NULL
        GROUP BY voter_ip
        ORDER BY COUNT(*) DESC
        LIMIT 20
      `)
    ]);
    res.json({ submitters: submitters.rows, voters: voters.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── SERVE PAGES ───

app.get('/investigate', (req, res) => res.sendFile(path.join(__dirname, 'investigate.html')));
app.get('/cases', (req, res) => res.sendFile(path.join(__dirname, 'cases.html')));
app.get('/registry', (req, res) => res.sendFile(path.join(__dirname, 'registry.html')));
app.get('/leaderboard', (req, res) => res.sendFile(path.join(__dirname, 'leaderboard.html')));

// ─── START ───

const PORT = process.env.PORT || 3002;
initDB().then(() => {
  app.listen(PORT, () => console.log(`[PUMP JUSTICE] Agent network online — port ${PORT}`));
}).catch(e => {
  console.error('[FATAL]', e.message);
  process.exit(1);
});
