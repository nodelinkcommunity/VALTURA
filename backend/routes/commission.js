const router = require('express').Router();

// GET /api/commission/overview — Commission overview for logged-in user
router.get('/overview', async (req, res) => {
  // TODO: aggregate commission data
  res.json({
    eligible: false, // must hold Exclusive (VIP-360)
    earningsCap: { limit: 0, earned: 0, remaining: 0, progress: 0 },
    breakdown: {
      binaryBonus: 0,       // 5% on Signature + Exclusive volume
      referralCommission: 0, // 10% on F1 daily profit
      binaryCommission: 0,   // 15% on weak leg daily profit
      momentumRewards: 0
    }
  });
});

// GET /api/commission/momentum — Momentum rewards status
router.get('/momentum', async (req, res) => {
  res.json({
    currentLevel: 0,
    levels: [
      { level: 1, wlp: 10000, reward: 250 },
      { level: 2, wlp: 25000, reward: 500 },
      { level: 3, wlp: 50000, reward: 1000 },
      { level: 4, wlp: 100000, reward: 2500 },
      { level: 5, wlp: 250000, reward: 5000 },
      { level: 6, wlp: 500000, reward: 10000 },
      { level: 7, wlp: 1000000, reward: 25000 },
      { level: 8, wlp: 2500000, reward: 50000 },
      { level: 9, wlp: 5000000, reward: 100000 },
      { level: 10, wlp: 10000000, reward: 250000 }
    ]
  });
});

module.exports = router;
