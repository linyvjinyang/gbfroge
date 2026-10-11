/**
 * 伤害上限（分段线性衰减）。
 * 表格与算例来自 gbf.wiki「Damage Cap」：各段阈值 × (1 + 上限提升总和)，
 * 上限提升在不同来源之间加算；与ダメージUP 在软上限之后乘算。
 */

/**
 * 每项为 [阈值, 超过该阈值后的通过率]；第一个阈值之前 100% 通过。
 * @typedef {[number, number][]} CapTiers
 */

/** @type {Record<string, { label: string, tiers: CapTiers }>} */
export const CAP_TABLES = {
  attack: {
    label: "通常攻击",
    tiers: [[300000, 0.8], [400000, 0.6], [500000, 0.05], [600000, 0.01]],
  },
  special: {
    label: "奥义",
    tiers: [[1500000, 0.6], [1700000, 0.3], [1800000, 0.05], [2500000, 0.01]],
  },
  chain2: {
    label: "连锁(2)",
    tiers: [[1000000, 0.6], [1200000, 0.3], [1300000, 0.05], [1500000, 0.01]],
  },
  chain3: {
    label: "连锁(3)",
    tiers: [[1250000, 0.6], [1450000, 0.3], [1500000, 0.05], [2000000, 0.01]],
  },
  chain4: {
    label: "连锁(4)",
    tiers: [[1500000, 0.6], [1700000, 0.3], [1800000, 0.05], [2500000, 0.01]],
  },
};

/**
 * 原始伤害过软上限后的数值。
 * @param {number} raw
 * @param {CapTiers} tiers
 * @param {number} [capUp] 上限提升总和（0.2 = +20%）
 * @param {number} [penetration] 上限贯通（0.05 = 各段通过率 ×1.05，封顶 100%）
 */
export function applySoftCap(raw, tiers, capUp = 0, penetration = 0) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  const scale = 1 + capUp;
  let out = Math.min(value, tiers[0][0] * scale);
  for (let i = 0; i < tiers.length; i++) {
    const low = tiers[i][0] * scale;
    const high = i + 1 < tiers.length ? tiers[i + 1][0] * scale : Infinity;
    const rate = Math.min(1, tiers[i][1] * (1 + penetration));
    out += Math.max(0, Math.min(value, high) - low) * rate;
  }
  return out;
}

/**
 * 软上限：原始伤害刚好到最后一个阈值时的数值，超过后只剩 1% 通过。
 * @param {CapTiers} tiers
 * @param {number} [capUp]
 * @param {number} [penetration]
 */
export function softCapValue(tiers, capUp = 0, penetration = 0) {
  const last = tiers[tiers.length - 1][0] * (1 + capUp);
  return applySoftCap(last, tiers, capUp, penetration);
}

/**
 * 画面上看到的上限 = 软上限 × (1 + 与ダメージUP)。
 * @param {CapTiers} tiers
 * @param {{ capUp?: number, amplify?: number, penetration?: number }} [mods]
 */
export function displayedCap(tiers, mods = {}) {
  return softCapValue(tiers, mods.capUp || 0, mods.penetration || 0) * (1 + (mods.amplify || 0));
}
