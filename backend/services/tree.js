// ══════════════════════════════════════
// Valtura — Binary Tree Service
// ══════════════════════════════════════

const db = require('../config/db');

/**
 * Place a new member in the binary tree.
 * If side is provided by referrer, place on that side.
 * If the chosen side is occupied, find the next available slot (spillover).
 *
 * @param {number} userId - The new user's ID
 * @param {number} referrerId - The referrer's user ID
 * @param {string} side - 'left' or 'right'
 * @param {import('pg').PoolClient} [client] - Optional transaction client
 */
async function placeMember(userId, referrerId, side = 'left', client) {
  const q = client || db;

  // Initialize binary_tree record for the new user
  await q.query(
    'INSERT INTO binary_tree (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
    [userId]
  );

  if (!referrerId) {
    // Root user — no parent
    return;
  }

  // Find the placement position (spillover logic)
  const parentId = await findPlacementSlot(referrerId, side, q);

  if (!parentId) {
    throw new Error('Could not find placement slot in binary tree');
  }

  // Update the new member's parent and side
  const actualSide = await getAvailableSide(parentId, side, q);

  await q.query(
    'UPDATE binary_tree SET parent_id = $1, side = $2 WHERE user_id = $3',
    [parentId, actualSide, userId]
  );

  // Update parent's child pointer
  if (actualSide === 'left') {
    await q.query(
      'UPDATE binary_tree SET left_child_id = $1 WHERE user_id = $2',
      [userId, parentId]
    );
  } else {
    await q.query(
      'UPDATE binary_tree SET right_child_id = $1 WHERE user_id = $2',
      [userId, parentId]
    );
  }
}

/**
 * Find the next available slot in the binary tree under a given user,
 * preferring the specified side. Uses BFS.
 */
async function findPlacementSlot(userId, preferredSide, q) {
  // Check if the preferred side under the referrer is directly available
  const { rows } = await q.query(
    'SELECT left_child_id, right_child_id FROM binary_tree WHERE user_id = $1',
    [userId]
  );

  if (rows.length === 0) return userId;

  const node = rows[0];

  if (preferredSide === 'left' && !node.left_child_id) return userId;
  if (preferredSide === 'right' && !node.right_child_id) return userId;
  // If preferred side is taken but other is free, still take preferred side's subtree
  // BFS down the preferred side
  const startId = preferredSide === 'left' ? node.left_child_id : node.right_child_id;
  if (!startId) {
    // Preferred side empty, use it
    return userId;
  }

  // BFS to find first open slot in the subtree
  const queue = [startId];
  while (queue.length > 0) {
    const currentId = queue.shift();
    const { rows: currentRows } = await q.query(
      'SELECT left_child_id, right_child_id FROM binary_tree WHERE user_id = $1',
      [currentId]
    );
    if (currentRows.length === 0) return currentId;
    const current = currentRows[0];
    if (!current.left_child_id || !current.right_child_id) {
      return currentId;
    }
    queue.push(current.left_child_id);
    queue.push(current.right_child_id);
  }

  return null;
}

/**
 * Get the available side for a parent node.
 * Prefers the requested side if available.
 */
async function getAvailableSide(parentId, preferredSide, q) {
  const { rows } = await q.query(
    'SELECT left_child_id, right_child_id FROM binary_tree WHERE user_id = $1',
    [parentId]
  );
  if (rows.length === 0) return preferredSide;
  const node = rows[0];
  if (preferredSide === 'left' && !node.left_child_id) return 'left';
  if (preferredSide === 'right' && !node.right_child_id) return 'right';
  if (!node.left_child_id) return 'left';
  if (!node.right_child_id) return 'right';
  return preferredSide; // should not reach here
}

/**
 * Get left and right leg volumes for a user.
 */
async function getLeftRightVolumes(userId) {
  const { rows } = await db.query(
    `SELECT left_volume, right_volume, left_vip_volume, right_vip_volume,
            left_vip_count, right_vip_count, left_roi, right_roi,
            vip_sales_remaining, carry_forward
     FROM binary_tree WHERE user_id = $1`,
    [userId]
  );
  if (rows.length === 0) {
    return {
      leftVolume: 0, rightVolume: 0,
      leftVipVolume: 0, rightVipVolume: 0,
      leftVipCount: 0, rightVipCount: 0,
      leftRoi: 0, rightRoi: 0,
      vipSalesRemaining: 0, carryForward: 0,
    };
  }
  const r = rows[0];
  return {
    leftVolume: parseFloat(r.left_volume) || 0,
    rightVolume: parseFloat(r.right_volume) || 0,
    leftVipVolume: parseFloat(r.left_vip_volume) || 0,
    rightVipVolume: parseFloat(r.right_vip_volume) || 0,
    leftVipCount: parseInt(r.left_vip_count, 10) || 0,
    rightVipCount: parseInt(r.right_vip_count, 10) || 0,
    leftRoi: parseFloat(r.left_roi) || 0,
    rightRoi: parseFloat(r.right_roi) || 0,
    vipSalesRemaining: parseFloat(r.vip_sales_remaining) || 0,
    carryForward: parseFloat(r.carry_forward) || 0,
  };
}

/**
 * Get the weak leg side and volume.
 */
async function getWeakLeg(userId) {
  const volumes = await getLeftRightVolumes(userId);
  const weakSide = volumes.leftVolume <= volumes.rightVolume ? 'left' : 'right';
  const weakVolume = weakSide === 'left' ? volumes.leftVolume : volumes.rightVolume;
  const strongVolume = weakSide === 'left' ? volumes.rightVolume : volumes.leftVolume;
  return { weakSide, weakVolume, strongVolume, ...volumes };
}

/**
 * Get direct referrals (F1) for a user.
 */
async function getDirectReferrals(userId) {
  const { rows } = await db.query(
    `SELECT u.id, u.wallet, u.username, u.created_at,
            COALESCE(SUM(p.amount), 0) as total_invested
     FROM users u
     LEFT JOIN positions p ON p.user_id = u.id AND p.status = 'active'
     WHERE u.referrer_id = $1
     GROUP BY u.id
     ORDER BY u.created_at DESC`,
    [userId]
  );
  return rows.map((r) => ({
    id: r.id,
    wallet: r.wallet,
    username: r.username,
    totalInvested: parseFloat(r.total_invested) || 0,
    createdAt: r.created_at,
  }));
}

/**
 * Get all team members under a user (recursive downline).
 */
async function getTeamMembers(userId) {
  const { rows } = await db.query(
    `WITH RECURSIVE downline AS (
       SELECT user_id, parent_id, side, 1 as depth
       FROM binary_tree WHERE parent_id = $1
       UNION ALL
       SELECT bt.user_id, bt.parent_id, bt.side, d.depth + 1
       FROM binary_tree bt
       INNER JOIN downline d ON d.user_id = bt.parent_id
     )
     SELECT d.user_id, d.parent_id, d.side, d.depth,
            u.wallet, u.username
     FROM downline d
     JOIN users u ON u.id = d.user_id
     ORDER BY d.depth, d.side`,
    [userId]
  );
  return rows;
}

/**
 * Count team members on each side.
 */
async function getTeamCounts(userId) {
  const { rows } = await db.query(
    `WITH RECURSIVE downline AS (
       SELECT user_id, side as root_side
       FROM binary_tree WHERE parent_id = $1
       UNION ALL
       SELECT bt.user_id, d.root_side
       FROM binary_tree bt
       INNER JOIN downline d ON d.user_id = bt.parent_id
     )
     SELECT
       COUNT(*) FILTER (WHERE root_side = 'left') as left_count,
       COUNT(*) FILTER (WHERE root_side = 'right') as right_count,
       COUNT(*) as total
     FROM downline`,
    [userId]
  );
  if (rows.length === 0) return { leftCount: 0, rightCount: 0, total: 0 };
  return {
    leftCount: parseInt(rows[0].left_count, 10) || 0,
    rightCount: parseInt(rows[0].right_count, 10) || 0,
    total: parseInt(rows[0].total, 10) || 0,
  };
}

/**
 * Get tree nodes for UI rendering (limited depth).
 */
async function getTreeNodes(userId, maxDepth = 4) {
  const { rows } = await db.query(
    `WITH RECURSIVE tree AS (
       SELECT bt.user_id, bt.parent_id, bt.side,
              bt.left_child_id, bt.right_child_id,
              bt.left_volume, bt.right_volume,
              bt.left_vip_volume, bt.right_vip_volume,
              bt.left_roi, bt.right_roi,
              0 as depth
       FROM binary_tree bt WHERE bt.user_id = $1
       UNION ALL
       SELECT bt.user_id, bt.parent_id, bt.side,
              bt.left_child_id, bt.right_child_id,
              bt.left_volume, bt.right_volume,
              bt.left_vip_volume, bt.right_vip_volume,
              bt.left_roi, bt.right_roi,
              t.depth + 1
       FROM binary_tree bt
       INNER JOIN tree t ON (bt.user_id = t.left_child_id OR bt.user_id = t.right_child_id)
       WHERE t.depth < $2
     )
     SELECT t.*,
            u.wallet, u.username,
            COALESCE((SELECT SUM(amount) FROM positions WHERE user_id = t.user_id AND status = 'active'), 0) as personal_volume
     FROM tree t
     JOIN users u ON u.id = t.user_id
     ORDER BY t.depth, t.side`,
    [userId, maxDepth]
  );

  return rows.map((r) => ({
    userId: r.user_id,
    parentId: r.parent_id,
    side: r.side,
    wallet: r.wallet,
    username: r.username,
    depth: r.depth,
    personalVolume: parseFloat(r.personal_volume) || 0,
    leftVolume: parseFloat(r.left_volume) || 0,
    rightVolume: parseFloat(r.right_volume) || 0,
    leftVipVolume: parseFloat(r.left_vip_volume) || 0,
    rightVipVolume: parseFloat(r.right_vip_volume) || 0,
    leftRoi: parseFloat(r.left_roi) || 0,
    rightRoi: parseFloat(r.right_roi) || 0,
    hasLeftChild: !!r.left_child_id,
    hasRightChild: !!r.right_child_id,
  }));
}

/**
 * Update volumes up the tree after a new deposit.
 * Walks from the depositor's parent up to root, incrementing left/right volumes.
 *
 * @param {number} userId - The depositing user's ID
 * @param {number} amount - Deposit amount in USD
 * @param {boolean} isVip - Whether this is a Signature or Exclusive package
 * @param {import('pg').PoolClient} [client]
 */
async function updateVolumes(userId, amount, isVip, client) {
  const q = client || db;

  // Walk up the tree from user's direct parent
  let { rows } = await q.query(
    'SELECT parent_id, side FROM binary_tree WHERE user_id = $1',
    [userId]
  );

  while (rows.length > 0 && rows[0].parent_id) {
    const parentId = rows[0].parent_id;
    const side = rows[0].side;

    if (side === 'left') {
      await q.query(
        `UPDATE binary_tree SET
          left_volume = left_volume + $1
          ${isVip ? ', left_vip_volume = left_vip_volume + $1, left_vip_count = left_vip_count + 1' : ''}
        WHERE user_id = $2`,
        [amount, parentId]
      );
    } else {
      await q.query(
        `UPDATE binary_tree SET
          right_volume = right_volume + $1
          ${isVip ? ', right_vip_volume = right_vip_volume + $1, right_vip_count = right_vip_count + 1' : ''}
        WHERE user_id = $2`,
        [amount, parentId]
      );
    }

    // Move up to the next ancestor
    ({ rows } = await q.query(
      'SELECT parent_id, side FROM binary_tree WHERE user_id = $1',
      [parentId]
    ));
  }
}

/**
 * Update ROI volumes up the tree (for binary commission calculation).
 */
async function updateROIVolumes(userId, roiAmount, client) {
  const q = client || db;

  let { rows } = await q.query(
    'SELECT parent_id, side FROM binary_tree WHERE user_id = $1',
    [userId]
  );

  while (rows.length > 0 && rows[0].parent_id) {
    const parentId = rows[0].parent_id;
    const side = rows[0].side;

    if (side === 'left') {
      await q.query(
        'UPDATE binary_tree SET left_roi = left_roi + $1 WHERE user_id = $2',
        [roiAmount, parentId]
      );
    } else {
      await q.query(
        'UPDATE binary_tree SET right_roi = right_roi + $1 WHERE user_id = $2',
        [roiAmount, parentId]
      );
    }

    ({ rows } = await q.query(
      'SELECT parent_id, side FROM binary_tree WHERE user_id = $1',
      [parentId]
    ));
  }
}

module.exports = {
  placeMember,
  getLeftRightVolumes,
  getWeakLeg,
  getDirectReferrals,
  getTeamMembers,
  getTeamCounts,
  getTreeNodes,
  updateVolumes,
  updateROIVolumes,
};
