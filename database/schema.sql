-- Valtura Database Schema
-- PostgreSQL 15+

-- ══════════════════════════════════════
-- USERS
-- ══════════════════════════════════════
CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  wallet        VARCHAR(42) UNIQUE NOT NULL,
  username      VARCHAR(20) UNIQUE NOT NULL,
  referrer_id   INT REFERENCES users(id),
  placement     VARCHAR(5) CHECK (placement IN ('left','right')),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_users_wallet ON users(wallet);

-- ══════════════════════════════════════
-- POSITIONS (Investment Packages)
-- ══════════════════════════════════════
CREATE TABLE positions (
  id            SERIAL PRIMARY KEY,
  user_id       INT NOT NULL REFERENCES users(id),
  package_id    VARCHAR(20) NOT NULL CHECK (package_id IN (
                  'essential','classic30','ultimate90','signature180',
                  'exclusive360','exclusive360_leader'
                )),
  amount        NUMERIC(18,2) NOT NULL CHECK (amount >= 10),
  tier          INT NOT NULL DEFAULT 1 CHECK (tier BETWEEN 1 AND 3),
  daily_rate    NUMERIC(5,4) NOT NULL,
  lock_days     INT NOT NULL DEFAULT 0,
  status        VARCHAR(10) DEFAULT 'active' CHECK (status IN ('active','completed','redeemed','cancelled')),
  started_at    TIMESTAMPTZ DEFAULT NOW(),
  expires_at    TIMESTAMPTZ,
  tx_hash       VARCHAR(66)
);
CREATE INDEX idx_positions_user ON positions(user_id);

-- ══════════════════════════════════════
-- BINARY TREE
-- ══════════════════════════════════════
CREATE TABLE binary_tree (
  user_id           INT PRIMARY KEY REFERENCES users(id),
  parent_id         INT REFERENCES users(id),
  side              VARCHAR(5) CHECK (side IN ('left','right')),
  left_child_id     INT REFERENCES users(id),
  right_child_id    INT REFERENCES users(id),
  left_volume       NUMERIC(18,2) DEFAULT 0,
  right_volume      NUMERIC(18,2) DEFAULT 0,
  left_vip_volume   NUMERIC(18,2) DEFAULT 0,
  right_vip_volume  NUMERIC(18,2) DEFAULT 0,
  left_vip_count    INT DEFAULT 0,
  right_vip_count   INT DEFAULT 0,
  left_roi          NUMERIC(18,2) DEFAULT 0,
  right_roi         NUMERIC(18,2) DEFAULT 0,
  vip_sales_remaining NUMERIC(18,2) DEFAULT 0,
  carry_forward     NUMERIC(18,2) DEFAULT 0
);

-- ══════════════════════════════════════
-- EARNINGS (per income type per position)
-- ══════════════════════════════════════
CREATE TABLE earnings (
  id            SERIAL PRIMARY KEY,
  user_id       INT NOT NULL REFERENCES users(id),
  position_id   INT NOT NULL REFERENCES positions(id),
  income_type   VARCHAR(25) NOT NULL CHECK (income_type IN (
                  'daily_profit','binary_bonus','referral_commission',
                  'binary_commission','momentum_rewards'
                )),
  total_earned  NUMERIC(18,2) DEFAULT 0,
  total_claimed NUMERIC(18,2) DEFAULT 0,
  unclaimed     NUMERIC(18,2) GENERATED ALWAYS AS (total_earned - total_claimed) STORED,
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, position_id, income_type)
);
CREATE INDEX idx_earnings_user ON earnings(user_id);

-- ══════════════════════════════════════
-- CLAIM TRANSACTIONS
-- ══════════════════════════════════════
CREATE TABLE claim_transactions (
  id            SERIAL PRIMARY KEY,
  user_id       INT NOT NULL REFERENCES users(id),
  gross_amount  NUMERIC(18,2) NOT NULL,
  fee_percent   NUMERIC(5,2) DEFAULT 2.50,
  fee_amount    NUMERIC(18,2) NOT NULL,
  net_amount    NUMERIC(18,2) NOT NULL,
  breakdown     JSONB, -- { daily_profit: x, binary_bonus: x, ... }
  tx_hash       VARCHAR(66),
  status        VARCHAR(15) DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed')),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ══════════════════════════════════════
-- COMMISSIONS LOG
-- ══════════════════════════════════════
CREATE TABLE commissions (
  id            SERIAL PRIMARY KEY,
  user_id       INT NOT NULL REFERENCES users(id),
  source_user   INT REFERENCES users(id),
  type          VARCHAR(25) NOT NULL CHECK (type IN (
                  'daily_profit','binary_bonus','referral_commission',
                  'binary_commission','momentum_rewards'
                )),
  amount        NUMERIC(18,2) NOT NULL,
  description   TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_commissions_user ON commissions(user_id);
CREATE INDEX idx_commissions_type ON commissions(type);

-- ══════════════════════════════════════
-- REDEEM ORDERS
-- ══════════════════════════════════════
CREATE TABLE redeem_orders (
  id            SERIAL PRIMARY KEY,
  user_id       INT NOT NULL REFERENCES users(id),
  position_id   INT NOT NULL REFERENCES positions(id),
  amount        NUMERIC(18,2) NOT NULL,
  status        VARCHAR(15) DEFAULT 'pending' CHECK (status IN ('pending','approved','completed','rejected')),
  tx_hash       VARCHAR(66),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  processed_at  TIMESTAMPTZ
);

-- ══════════════════════════════════════
-- PLATFORM CONFIG
-- ══════════════════════════════════════
CREATE TABLE platform_config (
  key           VARCHAR(50) PRIMARY KEY,
  value         TEXT NOT NULL,
  description   TEXT
);

INSERT INTO platform_config VALUES
  ('earnings_cap_multi', '300', 'Earnings Cap multiplier (%) for Exclusive VIP-360'),
  ('comm_binary_bonus', '5', 'Binary Bonus: % on Signature + Exclusive investment volume'),
  ('comm_referral', '10', 'Referral Commission: % on daily profit of direct sponsors'),
  ('comm_binary', '15', 'Binary Commission: % on daily profit of weaker leg'),
  ('fee_claim', '2.5', 'Fee % deducted at claim time'),
  ('fee_redeem', '5', 'Fee % for fund redemption');
