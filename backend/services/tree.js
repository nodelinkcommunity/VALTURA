// ══════════════════════════════════════
// Veltura — Binary Tree Service (In-Memory)
// ══════════════════════════════════════

const db = require('../config/db');

/**
 * Place a new member in the binary tree.
 */
function placeMember(userId, referrerId, side) {
  side = side || 'left';
  db.ensureTreeNode(userId);

  if (!referrerId) return; // Root user

  const parentId = findPlacementSlot(referrerId, side);
  if (!parentId) {
    throw new Error('Could not find placement slot in binary tree');
  }

  const actualSide = getAvailableSide(parentId, side);
  const node = db.getTreeNode(userId);
  node.parent_id = parentId;
  node.side = actualSide;

  const parentNode = db.getTreeNode(parentId);
  if (actualSide === 'left') {
    parentNode.left_child_id = userId;
  } else {
    parentNode.right_child_id = userId;
  }
}

function findPlacementSlot(userId, preferredSide) {
  const node = db.getTreeNode(userId);
  if (!node) return userId;

  if (preferredSide === 'left' && !node.left_child_id) return userId;
  if (preferredSide === 'right' && !node.right_child_id) return userId;

  const startId = preferredSide === 'left' ? node.left_child_id : node.right_child_id;
  if (!startId) return userId;

  // BFS
  const queue = [startId];
  while (queue.length > 0) {
    const currentId = queue.shift();
    const current = db.getTreeNode(currentId);
    if (!current) return currentId;
    if (!current.left_child_id || !current.right_child_id) return currentId;
    queue.push(current.left_child_id);
    queue.push(current.right_child_id);
  }
  return null;
}

function getAvailableSide(parentId, preferredSide) {
  const node = db.getTreeNode(parentId);
  if (!node) return preferredSide;
  if (preferredSide === 'left' && !node.left_child_id) return 'left';
  if (preferredSide === 'right' && !node.right_child_id) return 'right';
  if (!node.left_child_id) return 'left';
  if (!node.right_child_id) return 'right';
  return preferredSide;
}

/**
 * Get left and right leg volumes for a user.
 */
function getLeftRightVolumes(userId) {
  const node = db.getTreeNode(userId);
  if (!node) {
    return {
      leftVolume: 0, rightVolume: 0,
      leftVipVolume: 0, rightVipVolume: 0,
      leftVipCount: 0, rightVipCount: 0,
      leftRoi: 0, rightRoi: 0,
      carryForward: 0, vipSalesRemaining: 0,
    };
  }
  return {
    leftVolume: node.left_volume,
    rightVolume: node.right_volume,
    leftVipVolume: node.left_vip_volume,
    rightVipVolume: node.right_vip_volume,
    leftVipCount: node.left_vip_count,
    rightVipCount: node.right_vip_count,
    leftRoi: node.left_roi,
    rightRoi: node.right_roi,
    carryForward: node.carry_forward,
    vipSalesRemaining: node.vip_sales_remaining,
  };
}

/**
 * Get the weak leg side and volume.
 */
function getWeakLeg(userId) {
  const volumes = getLeftRightVolumes(userId);
  const weakSide = volumes.leftVolume <= volumes.rightVolume ? 'left' : 'right';
  const weakVolume = weakSide === 'left' ? volumes.leftVolume : volumes.rightVolume;
  const strongVolume = weakSide === 'left' ? volumes.rightVolume : volumes.leftVolume;
  return { weakSide, weakVolume, strongVolume, ...volumes };
}

/**
 * Get direct referrals (F1) for a user.
 */
function getDirectReferrals(userId) {
  const referrals = db.findUsers((u) => u.referrer_id === userId);
  return referrals.map((r) => {
    const invested = db.store.positions
      .filter((p) => p.user_id === r.id && p.status === 'active')
      .reduce((s, p) => s + p.amount, 0);
    return {
      id: r.id,
      wallet: r.wallet,
      username: r.username,
      totalInvested: invested,
      createdAt: r.created_at,
    };
  });
}

/**
 * Count team members on each side (recursive downline).
 */
function getTeamCounts(userId) {
  let leftCount = 0;
  let rightCount = 0;

  const node = db.getTreeNode(userId);
  if (!node) return { leftCount: 0, rightCount: 0, total: 0 };

  function countDescendants(nodeId) {
    const n = db.getTreeNode(nodeId);
    if (!n) return 0;
    let count = 1; // this node
    if (n.left_child_id) count += countDescendants(n.left_child_id);
    if (n.right_child_id) count += countDescendants(n.right_child_id);
    return count;
  }

  if (node.left_child_id) leftCount = countDescendants(node.left_child_id);
  if (node.right_child_id) rightCount = countDescendants(node.right_child_id);

  return { leftCount, rightCount, total: leftCount + rightCount };
}

/**
 * Update volumes up the tree after a new deposit.
 */
function updateVolumes(userId, amount, isVip) {
  let node = db.getTreeNode(userId);
  if (!node) return;

  while (node && node.parent_id) {
    const parentNode = db.getTreeNode(node.parent_id);
    if (!parentNode) break;

    if (node.side === 'left') {
      parentNode.left_volume += amount;
      if (isVip) {
        parentNode.left_vip_volume += amount;
        parentNode.left_vip_count += 1;
      }
    } else {
      parentNode.right_volume += amount;
      if (isVip) {
        parentNode.right_vip_volume += amount;
        parentNode.right_vip_count += 1;
      }
    }

    node = parentNode;
  }
}

/**
 * Update ROI volumes up the tree.
 */
function updateROIVolumes(userId, roiAmount) {
  let node = db.getTreeNode(userId);
  if (!node) return;

  while (node && node.parent_id) {
    const parentNode = db.getTreeNode(node.parent_id);
    if (!parentNode) break;

    if (node.side === 'left') {
      parentNode.left_roi += roiAmount;
    } else {
      parentNode.right_roi += roiAmount;
    }

    node = parentNode;
  }
}

module.exports = {
  placeMember,
  getLeftRightVolumes,
  getWeakLeg,
  getDirectReferrals,
  getTeamCounts,
  updateVolumes,
  updateROIVolumes,
};
