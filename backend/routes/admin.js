const router = require('express').Router();

// GET /api/admin/lookup/:query — Lookup user by wallet or username
router.get('/lookup/:query', async (req, res) => {
  // TODO: search by wallet address or @username
  res.json({ user: null });
});

// GET /api/admin/user/:id/earnings — User earnings breakdown
router.get('/user/:id/earnings', async (req, res) => {
  res.json({ breakdown: {} });
});

// POST /api/admin/rewards — Update reward settings
router.post('/rewards', async (req, res) => {
  const { earningsCap, binaryBonus, referralCommission, binaryCommission } = req.body;
  // TODO: update platform_config table
  res.json({ success: true });
});

// POST /api/admin/grant-leader — Grant VIP-360 Leader Access
router.post('/grant-leader', async (req, res) => {
  const { wallet } = req.body;
  // TODO: grant leader package
  res.json({ success: true });
});

// GET /api/admin/stats — Platform overview stats
router.get('/stats', async (req, res) => {
  res.json({
    totalValueLocked: 0,
    activeInvestors: 0,
    totalPackages: 0,
    pendingRedemptions: 0
  });
});

module.exports = router;
