const router = require('express').Router();

// GET /api/user/profile — Get user profile
router.get('/profile', async (req, res) => {
  // TODO: auth middleware, query DB
  res.json({
    wallet: '0x742d...c42b',
    username: 'valtura_user',
    packages: [],
    totalDeposit: 0,
    earningsCap: 0
  });
});

// GET /api/user/earnings — Get earnings breakdown
router.get('/earnings', async (req, res) => {
  // TODO: query earnings table per income type
  res.json({
    totalEarned: 0,
    earningsCapLimit: 0,
    claimed: 0,
    claimable: 0,
    breakdown: {
      dailyProfit: { total: 0, claimed: 0, unclaimed: 0 },
      binaryBonus: { total: 0, claimed: 0, unclaimed: 0 },
      referralCommission: { total: 0, claimed: 0, unclaimed: 0 },
      binaryCommission: { total: 0, claimed: 0, unclaimed: 0 },
      momentumRewards: { total: 0, claimed: 0, unclaimed: 0 }
    }
  });
});

// POST /api/user/claim — Claim all pending earnings
router.post('/claim', async (req, res) => {
  // TODO: validate active Exclusive (VIP-360) package
  // TODO: calculate total unclaimed
  // TODO: deduct fee, execute on-chain transfer
  // TODO: log in claim_transactions table
  res.json({ success: true, txHash: '0x...' });
});

// GET /api/user/network — Get binary tree & leg stats
router.get('/network', async (req, res) => {
  // TODO: query binary tree, left/right leg stats
  res.json({
    directReferrals: 0,
    totalMembers: 0,
    leftLeg: {},
    rightLeg: {},
    tree: []
  });
});

module.exports = router;
