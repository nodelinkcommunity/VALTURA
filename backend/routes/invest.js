const router = require('express').Router();

// POST /api/invest/deposit — Create new investment
router.post('/deposit', async (req, res) => {
  const { packageType, amount } = req.body;
  // packageType: essential, classic30, ultimate90, signature180, exclusive360
  // amount: minimum $10, multiples of $10
  // TODO: verify on-chain USDT transfer
  // TODO: insert position into DB
  // TODO: update binary tree volumes
  res.json({ success: true, positionId: 1 });
});

// POST /api/invest/redeem — Redeem funds after lock period
router.post('/redeem', async (req, res) => {
  const { positionId } = req.body;
  // TODO: check lock period expired
  // TODO: execute on-chain USDT return (max 12h processing)
  res.json({ success: true, status: 'processing' });
});

// GET /api/invest/packages — Get available packages
router.get('/packages', async (req, res) => {
  res.json([
    { id: 'essential', name: 'Essential', lock: 0, tiers: [0.20, 0.25, 0.35], min: 10, affiliate: false },
    { id: 'classic30', name: 'Classic', lock: 30, tiers: [0.25, 0.35, 0.45], min: 10, affiliate: false },
    { id: 'ultimate90', name: 'Ultimate', lock: 90, tiers: [0.40, 0.50, 0.60], min: 10, affiliate: false },
    { id: 'signature180', name: 'Signature', lock: 180, tiers: [0.60, 0.70, 0.80], min: 10, affiliate: false },
    { id: 'exclusive360', name: 'Exclusive (VIP-360)', lock: 360, tiers: [0.80, 1.00, 1.20], min: 10, affiliate: true, earningsCap: 300 }
  ]);
});

module.exports = router;
