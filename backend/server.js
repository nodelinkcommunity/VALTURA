require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Serve frontend
app.use('/', express.static(path.join(__dirname, '../frontend')));
app.use('/admin', express.static(path.join(__dirname, '../admin')));
app.use('/assets', express.static(path.join(__dirname, '../assets')));

// API Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/user', require('./routes/user'));
app.use('/api/invest', require('./routes/invest'));
app.use('/api/commission', require('./routes/commission'));
app.use('/api/admin', require('./routes/admin'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0', chain: 'polygon' });
});

app.listen(PORT, () => {
  console.log(`Valtura API running on port ${PORT}`);
});
