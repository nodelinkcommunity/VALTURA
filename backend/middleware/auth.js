// ══════════════════════════════════════
// Valtura — Authentication Middleware
// ══════════════════════════════════════

const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../config/db');

const SUPER_WALLET = config.superWallet.toLowerCase();

/**
 * JWT authentication middleware.
 * Extracts token from Authorization header, verifies it,
 * loads user from DB, attaches to req.user.
 */
async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid authorization header' });
    }

    const token = header.slice(7);
    let decoded;
    try {
      decoded = jwt.verify(token, config.jwt.secret);
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'Token expired' });
      }
      return res.status(401).json({ error: 'Invalid token' });
    }

    const wallet = decoded.wallet?.toLowerCase();
    if (!wallet) {
      return res.status(401).json({ error: 'Invalid token payload' });
    }

    // Load user from DB
    const { rows } = await db.query(
      'SELECT id, wallet, username, referrer_id, created_at FROM users WHERE LOWER(wallet) = $1',
      [wallet]
    );

    if (rows.length === 0) {
      // Wallet is verified but not registered — attach wallet only
      req.user = { wallet, registered: false };
      return next();
    }

    const user = rows[0];
    req.user = {
      id: user.id,
      wallet: user.wallet.toLowerCase(),
      username: user.username,
      referrerId: user.referrer_id,
      registered: true,
      isSuperWallet: user.wallet.toLowerCase() === SUPER_WALLET,
      createdAt: user.created_at,
    };

    next();
  } catch (err) {
    console.error('[Auth] Middleware error:', err.message);
    return res.status(500).json({ error: 'Authentication failed' });
  }
}

/**
 * Require the user to be fully registered.
 * Must be used after authenticate().
 */
function requireRegistered(req, res, next) {
  if (!req.user || !req.user.registered) {
    return res.status(403).json({ error: 'Account not registered' });
  }
  next();
}

/**
 * Require admin role.
 * Admins = Super Wallet. Future: check admin table.
 * Must be used after authenticate().
 */
function requireAdmin(req, res, next) {
  if (!req.user || !req.user.registered) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  if (!req.user.isSuperWallet) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

/**
 * Require Super Wallet.
 * Must be used after authenticate().
 */
function requireSuperWallet(req, res, next) {
  if (!req.user || req.user.wallet?.toLowerCase() !== SUPER_WALLET) {
    return res.status(403).json({ error: 'Super Wallet access required' });
  }
  next();
}

module.exports = {
  authenticate,
  requireRegistered,
  requireAdmin,
  requireSuperWallet,
};
