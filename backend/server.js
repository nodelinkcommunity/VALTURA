// ══════════════════════════════════════
// Valtura — Express API Server
// ══════════════════════════════════════

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const config = require('./config');
const { initCron, runDailyJob } = require('./cron/daily');
const { authenticate, requireAdmin } = require('./middleware/auth');

const app = express();
const PORT = config.server.port;

// ── Middleware ──
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Request logging (development) ──
if (config.server.env === 'development') {
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      if (req.path.startsWith('/api/')) {
        console.log(`[${req.method}] ${req.path} — ${res.statusCode} (${duration}ms)`);
      }
    });
    next();
  });
}

// ── Serve frontend static files ──
app.use('/', express.static(path.join(__dirname, '../frontend')));
app.use('/admin', express.static(path.join(__dirname, '../admin')));
app.use('/assets', express.static(path.join(__dirname, '../assets')));

// ── API Routes ──
app.use('/api/auth', require('./routes/auth'));
app.use('/api/user', require('./routes/user'));
app.use('/api/invest', require('./routes/invest'));
app.use('/api/commission', require('./routes/commission'));
app.use('/api/admin', require('./routes/admin'));

// ── Health check ──
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    chain: 'polygon',
    network: config.polygon.chainId === 137 ? 'mainnet' : 'amoy-testnet',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

// ── Manual cron trigger (admin only, for testing) ──
app.post('/api/admin/trigger-cron', authenticate, requireAdmin, async (req, res) => {
  try {
    console.log('[Server] Manual cron trigger by', req.user.wallet);
    const result = await runDailyJob();
    res.json(result);
  } catch (err) {
    console.error('[Server] Manual cron trigger failed:', err.message);
    res.status(500).json({ error: 'Cron job failed', message: err.message });
  }
});

// ── 404 handler for API routes ──
app.use('/api/*', (req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// ── SPA fallback: serve frontend for non-API routes ──
app.get('*', (req, res) => {
  // Check if the request is for admin panel
  if (req.path.startsWith('/admin')) {
    return res.sendFile(path.join(__dirname, '../admin/index.html'));
  }
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// ── Global error handler ──
app.use((err, req, res, next) => {
  console.error('[Server] Unhandled error:', err.message);
  console.error(err.stack);

  res.status(err.status || 500).json({
    error: config.server.env === 'production'
      ? 'Internal server error'
      : err.message,
  });
});

// ── Start server ──
app.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║     Valtura API Server               ║');
  console.log(`  ║     Port: ${PORT}                        ║`);
  console.log(`  ║     Env:  ${config.server.env.padEnd(24)}║`);
  console.log(`  ║     Chain: ${(config.polygon.chainId === 137 ? 'Polygon Mainnet' : 'Polygon Amoy').padEnd(23)}║`);
  console.log('  ╚══════════════════════════════════════╝');
  console.log('');

  // Initialize cron jobs
  if (config.server.env !== 'test') {
    initCron();
  }
});

module.exports = app;
