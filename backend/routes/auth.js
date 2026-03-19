const router = require('express').Router();

// POST /api/auth/register — Register with wallet + username
router.post('/register', async (req, res) => {
  const { wallet, username, referrer } = req.body;
  // TODO: validate username (3-20 chars, alphanumeric + underscore)
  // TODO: check username uniqueness
  // TODO: verify wallet signature
  // TODO: insert into DB
  res.json({ success: true, message: 'Registration successful' });
});

// GET /api/auth/check-username/:username — Check availability
router.get('/check-username/:username', async (req, res) => {
  const { username } = req.params;
  // TODO: query DB for username
  res.json({ available: true });
});

// POST /api/auth/verify-wallet — Verify wallet ownership
router.post('/verify-wallet', async (req, res) => {
  const { wallet, signature, message } = req.body;
  // TODO: verify signature with ethers.js
  res.json({ verified: true, token: 'jwt-token-here' });
});

module.exports = router;
