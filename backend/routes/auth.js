// ══════════════════════════════════════
// Valtura — Auth Routes
// ══════════════════════════════════════

const router = require('express').Router();
const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../config/db');
const blockchain = require('../services/blockchain');
const treeService = require('../services/tree');
const { authenticate } = require('../middleware/auth');

// ── POST /api/auth/register ──
// Register a new user with wallet + username + referrer
router.post('/register', async (req, res) => {
  try {
    const { wallet, username, signature, message, referrer, side } = req.body;

    // Validate wallet address
    if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
      return res.status(400).json({ error: 'Invalid wallet address' });
    }

    // Validate username: 3-20 chars, alphanumeric + underscore
    if (!username || !/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
      return res.status(400).json({
        error: 'Username must be 3-20 characters, alphanumeric and underscore only',
      });
    }

    // Validate signature
    if (!signature || !message) {
      return res.status(400).json({ error: 'Signature and message are required' });
    }

    // Verify EIP-191 signature
    let recoveredAddress;
    try {
      recoveredAddress = blockchain.verifySignature(message, signature);
    } catch (err) {
      return res.status(400).json({ error: 'Invalid signature' });
    }

    if (recoveredAddress.toLowerCase() !== wallet.toLowerCase()) {
      return res.status(400).json({ error: 'Signature does not match wallet' });
    }

    // Check if wallet already registered
    const { rows: existingWallet } = await db.query(
      'SELECT id FROM users WHERE LOWER(wallet) = $1',
      [wallet.toLowerCase()]
    );
    if (existingWallet.length > 0) {
      return res.status(409).json({ error: 'Wallet already registered' });
    }

    // Check username uniqueness
    const { rows: existingUsername } = await db.query(
      'SELECT id FROM users WHERE LOWER(username) = $1',
      [username.toLowerCase()]
    );
    if (existingUsername.length > 0) {
      return res.status(409).json({ error: 'Username already taken' });
    }

    // Find referrer
    let referrerId = null;
    if (referrer) {
      const referrerQuery = referrer.startsWith('0x')
        ? 'SELECT id FROM users WHERE LOWER(wallet) = $1'
        : 'SELECT id FROM users WHERE LOWER(username) = $1';
      const referrerValue = referrer.toLowerCase().replace(/^@/, '');
      const { rows: refRows } = await db.query(referrerQuery, [referrerValue]);
      if (refRows.length === 0) {
        return res.status(400).json({ error: 'Referrer not found' });
      }
      referrerId = refRows[0].id;
    }

    // Insert user and place in binary tree (transaction)
    const placement = side === 'right' ? 'right' : 'left';

    const result = await db.transaction(async (client) => {
      // Insert user
      const { rows } = await client.query(
        `INSERT INTO users (wallet, username, referrer_id, placement)
         VALUES ($1, $2, $3, $4)
         RETURNING id, wallet, username, created_at`,
        [wallet, username.toLowerCase(), referrerId, placement]
      );
      const user = rows[0];

      // Place in binary tree
      await treeService.placeMember(user.id, referrerId, placement, client);

      return user;
    });

    // Issue JWT
    const token = jwt.sign(
      { wallet: result.wallet, userId: result.id },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn }
    );

    res.status(201).json({
      success: true,
      message: 'Registration successful',
      token,
      user: {
        id: result.id,
        wallet: result.wallet,
        username: result.username,
        createdAt: result.created_at,
      },
    });
  } catch (err) {
    console.error('[Auth] Register error:', err.message);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// ── GET /api/auth/check-username/:username ──
// Check if a username is available
router.get('/check-username/:username', async (req, res) => {
  try {
    const { username } = req.params;

    if (!username || !/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
      return res.json({ available: false, reason: 'Invalid format' });
    }

    const { rows } = await db.query(
      'SELECT id FROM users WHERE LOWER(username) = $1',
      [username.toLowerCase()]
    );

    res.json({
      available: rows.length === 0,
      username: username.toLowerCase(),
    });
  } catch (err) {
    console.error('[Auth] Check username error:', err.message);
    res.status(500).json({ error: 'Check failed' });
  }
});

// ── POST /api/auth/verify-wallet ──
// Verify wallet ownership via EIP-191 signature, issue JWT
router.post('/verify-wallet', async (req, res) => {
  try {
    const { wallet, signature, message } = req.body;

    if (!wallet || !signature || !message) {
      return res.status(400).json({ error: 'Wallet, signature, and message are required' });
    }

    // Verify signature
    let recoveredAddress;
    try {
      recoveredAddress = blockchain.verifySignature(message, signature);
    } catch (err) {
      return res.status(400).json({ error: 'Invalid signature' });
    }

    if (recoveredAddress.toLowerCase() !== wallet.toLowerCase()) {
      return res.status(400).json({ error: 'Signature does not match wallet', verified: false });
    }

    // Check if user is registered
    const { rows } = await db.query(
      'SELECT id, wallet, username, created_at FROM users WHERE LOWER(wallet) = $1',
      [wallet.toLowerCase()]
    );

    const token = jwt.sign(
      { wallet: wallet.toLowerCase(), userId: rows[0]?.id || null },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn }
    );

    res.json({
      verified: true,
      token,
      registered: rows.length > 0,
      user: rows.length > 0
        ? { id: rows[0].id, wallet: rows[0].wallet, username: rows[0].username, createdAt: rows[0].created_at }
        : null,
    });
  } catch (err) {
    console.error('[Auth] Verify wallet error:', err.message);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// ── POST /api/auth/connect ──
// Connect wallet — returns JWT + user profile if registered
router.post('/connect', async (req, res) => {
  try {
    const { wallet, signature, message } = req.body;

    if (!wallet || !signature || !message) {
      return res.status(400).json({ error: 'Wallet, signature, and message are required' });
    }

    // Verify signature
    let recoveredAddress;
    try {
      recoveredAddress = blockchain.verifySignature(message, signature);
    } catch (err) {
      return res.status(400).json({ error: 'Invalid signature' });
    }

    if (recoveredAddress.toLowerCase() !== wallet.toLowerCase()) {
      return res.status(400).json({ error: 'Signature does not match wallet' });
    }

    // Check if user exists
    const { rows } = await db.query(
      `SELECT u.id, u.wallet, u.username, u.referrer_id, u.created_at,
              COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'active'), 0) as total_invested,
              COUNT(p.id) FILTER (WHERE p.status = 'active') as active_positions
       FROM users u
       LEFT JOIN positions p ON p.user_id = u.id
       WHERE LOWER(u.wallet) = $1
       GROUP BY u.id`,
      [wallet.toLowerCase()]
    );

    const token = jwt.sign(
      { wallet: wallet.toLowerCase(), userId: rows[0]?.id || null },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn }
    );

    if (rows.length === 0) {
      return res.json({
        connected: true,
        registered: false,
        token,
        user: null,
      });
    }

    const user = rows[0];
    res.json({
      connected: true,
      registered: true,
      token,
      user: {
        id: user.id,
        wallet: user.wallet,
        username: user.username,
        totalInvested: parseFloat(user.total_invested) || 0,
        activePositions: parseInt(user.active_positions, 10) || 0,
        createdAt: user.created_at,
      },
    });
  } catch (err) {
    console.error('[Auth] Connect error:', err.message);
    res.status(500).json({ error: 'Connection failed' });
  }
});

module.exports = router;
