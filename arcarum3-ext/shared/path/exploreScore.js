/**
 * 无目标点的「收益扫路」（长度 ≤ N）
 *
 * 计分（进入格，不含起点；累计越低越好）：
 *
 * 【第一天】
 * - 普战 / 事件：-10
 * - 宝箱 / 商店：-10
 * - 回复：+10（与空地相同）
 * - 空地 / 君临者 / 传送门 / 特殊：+10
 * - 强敌 +10、超强敌 +10（均可撤退，与空地同权）
 * - Boss 不参与扫路，只能作为显式目标寻路的终点
 *
 * 【第二天】（inferDay >= 2）
 * - 强敌改为 -10（奖励）
 * - 其余与第一天相同
 *
 * 算法：DFS 枚举长度 2..N 的简单路径 + 乐观下界剪枝
 * （不会「单步变差就停」——空地后面的收益仍会搜到）
 *
 * 【没走满 N 步的路线：剩下的步数不是免费的】
 * 游戏里每回合都得走，停不下来。所以路线比较的是「计划分」：
 *   计划分 = 路线上的分 + 剩下的步数 × 走空地的分
 *            + 停在瘴气里时：走回圈里大约还要踩的瘴气格（按越待越亏的口径）+ 停在瘴气里本身的一格分
 *   停在瘴气里的这一项不管有没有走满都算，所以路线不会刚好在预算的最后一步停进瘴气。
 * 这样周围都打完了也会继续往有收益的地方走。界面上显示的「累计分」仍是路线本身的分。
 *
 * 【瘴气（圈外）越待越亏】
 * 进瘴气格的分随「已经连续在瘴气里待了几格」递增：第 1 格 +14，之后每多待一格再 +6。
 * 所以圈边上的收益会顺手去拿（拿一两个就回来），但不会在瘴气里一直逛；人在圈外时会往圈里走。
 */

import { NODE_TYPE } from "../nodeTypes.js";
import {
  MIASMA_DEFAULT_RADIUS,
  MIASMA_OUTSIDE_ENTER_SCORE,
  isNodeInMiasma,
} from "../miasma.js";

/** 可调权重表 */
export const EXPLORE_WEIGHTS = {
  /** 鼓励 */
  BATTLE: -10,
  EVENT: -10,
  CHEST: -10,
  SHOP: -10,
  /** 回复默认与空地相同 */
  HEAL: 10,
  EMPTY: 10,
  RULER: 10,
  PORTAL: 10,
  SPECIAL: 10,
  /** 首日可撤退敌人与空地同权 */
  STRONG_DAY1: 10,
  TERRIFYING: 10,
  /** 第二天强敌改为奖励 */
  STRONG_DAY2: -10,
  /** 未单独列出的类型 */
  default: 0,
};

/** 主页面自定义评分控件；顺序即显示顺序。 */
export const EXPLORE_SCORE_FIELDS = [
  { key: "BATTLE", label: "普通战斗" },
  { key: "EVENT", label: "事件" },
  { key: "CHEST", label: "宝箱" },
  { key: "SHOP", label: "商店" },
  { key: "HEAL", label: "回复" },
  { key: "EMPTY", label: "空地" },
  { key: "RULER", label: "君临者" },
  { key: "PORTAL", label: "传送门" },
  { key: "SPECIAL", label: "特殊事件" },
  { key: "STRONG_DAY1", label: "强敌（首日）" },
  { key: "STRONG_DAY2", label: "强敌（次日）" },
  // Boss 不提供评分项：它只能作为显式路线的最终目标。
  { key: "TERRIFYING", label: "超强敌" },
];

function getExploreWeights(opts = {}) {
  const custom = opts.weights && typeof opts.weights === "object" ? opts.weights : {};
  const merged = { ...EXPLORE_WEIGHTS };
  for (const { key } of EXPLORE_SCORE_FIELDS) {
    const value = Number(custom[key]);
    if (Number.isFinite(value)) merged[key] = value;
  }
  return merged;
}

/**
 * @typedef {object} ExploreScoreOptions
 * @property {number} [day]  1 或 2+
 * @property {Partial<typeof EXPLORE_WEIGHTS>} [weights] 自定义各类评分
 * @property {import('../miasma.js').MiasmaCenter | null} [miasmaCenter]
 *   毒圈开启时传入：软性偏好留在白圈内（惩罚 is_shrinking），不强制去圆心
 * @property {Map<number, number> | null} [nodeScores]
 *   个别节点的分数覆盖（节点号 → 分数），优先于按类型给的分。
 *   用来让商店的价值随手里的钱和剩余库存变化。
 * @property {ReturnType<typeof makeSweepBias>} [downBias]
 *   makeSweepBias() / makeDownBias() 的结果：沿偏好的方向走给奖励分
 */

/**
 * @param {number} displayType
 * @param {ExploreScoreOptions} [opts]
 */
export function scoreForType(displayType, opts = {}) {
  const day = Number(opts.day) >= 2 ? 2 : 1;
  const t = Number(displayType);
  const W = getExploreWeights(opts);

  switch (t) {
    case NODE_TYPE.BATTLE:
      return W.BATTLE;
    case NODE_TYPE.EVENT:
      return W.EVENT;
    case NODE_TYPE.CHEST:
      return W.CHEST;
    case NODE_TYPE.SHOP:
      return W.SHOP;
    case NODE_TYPE.HEAL:
      return W.HEAL;
    case NODE_TYPE.EMPTY:
      return W.EMPTY;
    case NODE_TYPE.RULER:
      return W.RULER;
    case NODE_TYPE.PORTAL:
      return W.PORTAL;
    case NODE_TYPE.SPECIAL:
      return W.SPECIAL;
    case NODE_TYPE.STRONG:
      return day >= 2 ? W.STRONG_DAY2 : W.STRONG_DAY1;
    case NODE_TYPE.BOSS:
      // Boss 是显式路线的最终目标，不参与收益扫路评分。
      return null;
    case NODE_TYPE.TERRIFYING:
      return W.TERRIFYING;
    default:
      return W.default;
  }
}

/**
 * 进入某个节点的分数：有逐格覆盖用覆盖值，否则按类型。
 * @param {{ id: number, displayType: number }} node
 * @param {ExploreScoreOptions} opts
 */
export function scoreForNode(node, opts = {}) {
  const override = opts.nodeScores?.get?.(Number(node?.id));
  return override != null ? override : scoreForType(node?.displayType, opts);
}

/**
 * 剩余步乐观下界用的最低单格分（最负）
 * @param {ExploreScoreOptions} [opts]
 */
export function minPossibleStepScore(opts = {}) {
  const samples = [
    NODE_TYPE.BATTLE,
    NODE_TYPE.EVENT,
    NODE_TYPE.CHEST,
    NODE_TYPE.SHOP,
    NODE_TYPE.HEAL,
    NODE_TYPE.EMPTY,
    NODE_TYPE.STRONG,
    NODE_TYPE.TERRIFYING,
    NODE_TYPE.RULER,
    NODE_TYPE.PORTAL,
    NODE_TYPE.SPECIAL,
  ];
  let m = 0;
  for (const t of samples) {
    const s = scoreForType(t, opts);
    if (Number.isFinite(s) && s < m) m = s;
  }
  // 逐格覆盖里可能有比任何类型都更负的分（钱多时的商店）
  for (const s of opts.nodeScores?.values?.() || []) {
    if (Number.isFinite(s) && s < m) m = s;
  }
  return m;
}

/** 在瘴气里每多连续待一格，进下一格瘴气再多扣的分 */
export const MIASMA_STAY_ESCALATION = 6;

/**
 * 进入 toNode 的瘴气分。
 * @param {number} streak 进入之前已经连续在瘴气里的格数（含当前所在格）
 */
export function miasmaStepScore(toNode, streak) {
  if (!isNodeInMiasma(toNode)) return 0;
  return MIASMA_OUTSIDE_ENTER_SCORE + MIASMA_STAY_ESCALATION * Math.max(0, streak);
}

/** 走到 node 之后，连续在瘴气里的格数 */
function nextMiasmaStreak(streak, node) {
  return isNodeInMiasma(node) ? streak + 1 : 0;
}

/** 方向偏置：每沿着偏好的方向走满一个「典型纵向落差」给的奖励分（略高于空地惩罚，穿空地也不亏） */
export const DOWN_BIAS_WEIGHT = 12;
/** 向上阶段里「往地图中间靠」的权重占纵向权重的比例 */
export const CENTER_BIAS_RATIO = 0.5;
/** 走回已经走过的节点时的额外惩罚，占纵向权重的比例：同样是空地，优先走没走过的 */
export const REVISIT_PENALTY_RATIO = 0.25;
/** 距最低 / 最高节点不足这么多个典型落差，视为已到边缘 */
export const DOWN_EDGE_BAND_STEPS = 0.5;

/** 地图的纵向范围、中线和典型的一步落差 */
function mapGeometry(map) {
  const byId = new Map(map.nodes.map((node) => [node.id, node]));
  // 典型的「一步纵向」落差：只看以纵向为主的边，这样正上 / 正下方的一步总能拿满奖励，
  // 不会因为地图横向边更长而被稀释到抵不过空地惩罚。
  const drops = [];
  const lengths = [];
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const node of map.nodes) {
    if (!Number.isFinite(node.y)) continue;
    minY = Math.min(minY, node.y);
    maxY = Math.max(maxY, node.y);
    if (Number.isFinite(node.x)) {
      minX = Math.min(minX, node.x);
      maxX = Math.max(maxX, node.x);
    }
    for (const adj of node.adjacentIds || []) {
      const other = byId.get(adj);
      if (!other || other.id <= node.id) continue;
      if (!Number.isFinite(other.x) || !Number.isFinite(other.y)) continue;
      const dx = Math.abs(other.x - node.x);
      const dy = Math.abs(other.y - node.y);
      if (dx + dy > 0) lengths.push(Math.hypot(dx, dy));
      if (dy > 0 && dy >= dx) drops.push(dy);
    }
  }
  const samples = drops.length ? drops : lengths;
  if (!samples.length) return null;
  samples.sort((a, b) => a - b);
  lengths.sort((a, b) => a - b);
  return {
    byId,
    unit: samples[Math.floor(samples.length / 2)],
    stepLength: lengths.length ? lengths[Math.floor(lengths.length / 2)] : null,
    minY,
    maxY,
    centerX: Number.isFinite(minX) ? (minX + maxX) / 2 : null,
  };
}

/**
 * 向下优先的上下文：当前位置到达下边缘后返回 null（偏置关闭）。
 * position_y 为游戏 UI 像素坐标，越大越靠下。
 *
 * @param {{ nodes: { id: number, adjacentIds: number[], x?: number, y?: number }[] }} map
 * @param {number} startId
 * @param {number} [weight]
 * @returns {{ weight: number, unit: number, direction: 1, maxY: number } | null}
 */
export function makeDownBias(map, startId, weight = DOWN_BIAS_WEIGHT) {
  const bias = makeSweepBias(map, startId, { weight, upAfterEdge: false });
  return bias?.phase === "down" ? bias : null;
}

/**
 * 缩圈位置还不知道时的扫图方向：
 *   1. down：先往下走到地图下边缘；
 *   2. up：到过下边缘之后掉头，往上并往地图中间靠——走的都是没走过的地方，
 *      而且人在中间，缩圈出现在哪边都不用绕远；
 *   3. 到了上边缘、或者缩圈已经出现：返回 null，不再偏向任何方向。
 *
 * 「到过下边缘」不靠记忆：当前位置在下边缘带内，或者已访问的节点里有落在下边缘带内的。
 *
 * @param {object} map toRouteMap() 的结果
 * @param {number} startId
 * @param {{ weight?: number, downFirst?: boolean, upAfterEdge?: boolean,
 *           visitedIds?: Iterable<number>, miasmaActive?: boolean }} [options]
 *   downFirst=false：跳过第 1 阶段，从一开始就往上、往中间走
 * @returns {{ phase: 'down' | 'up', weight: number, unit: number, direction: 1 | -1,
 *             centerX: number | null, centerWeight: number, maxY: number, minY: number,
 *             visited: Set<number>, revisitPenalty: number } | null}
 */
export function makeSweepBias(map, startId, options = {}) {
  const weight = Number(options.weight ?? DOWN_BIAS_WEIGHT);
  if (!Number.isFinite(weight) || weight <= 0 || options.miasmaActive) return null;
  const geometry = mapGeometry(map);
  if (!geometry) return null;
  const start = geometry.byId.get(startId);
  if (!start || !Number.isFinite(start.y)) return null;

  const band = geometry.unit * DOWN_EDGE_BAND_STEPS;
  const atBottom = (node) => Number.isFinite(node?.y) && node.y >= geometry.maxY - band;
  const atTop = (node) => Number.isFinite(node?.y) && node.y <= geometry.minY + band;
  const downFirst = options.downFirst !== false;
  const upAfterEdge = options.upAfterEdge !== false;

  const visited = new Set([...(options.visitedIds || [])].map(Number));
  let reachedBottom = !downFirst || atBottom(start);
  if (!reachedBottom) {
    for (const id of visited) {
      if (atBottom(geometry.byId.get(id))) {
        reachedBottom = true;
        break;
      }
    }
  }

  const base = {
    weight,
    unit: geometry.unit,
    maxY: geometry.maxY,
    minY: geometry.minY,
    visited,
    revisitPenalty: weight * REVISIT_PENALTY_RATIO,
  };
  if (!reachedBottom) {
    return { ...base, phase: "down", direction: 1, centerX: null, centerWeight: 0 };
  }
  if (!upAfterEdge || atTop(start)) return null;
  return {
    ...base,
    phase: "up",
    direction: -1,
    centerX: geometry.centerX,
    centerWeight: weight * CENTER_BIAS_RATIO,
  };
}

/** 一步里方向偏置最多能给多少奖励分（剪枝用） */
export function maxSweepBonus(bias) {
  return bias ? bias.weight + (bias.centerWeight || 0) : 0;
}

/**
 * 单步的方向偏置分：沿偏好的方向为负（奖励），反方向为正（惩罚），单项封顶 ±权重。
 * 向上阶段再加一项：横向离地图中线更近给奖励，更远给惩罚。
 * 走回已经走过的节点另加一小笔惩罚，尽量不重复走。
 *
 * @param {{ x?: number, y?: number }} from
 * @param {{ id?: number, x?: number, y?: number }} to
 * @param {ReturnType<typeof makeSweepBias>} bias
 */
export function downStepScore(from, to, bias) {
  if (!bias || !from || !to) return 0;
  if (!Number.isFinite(from.y) || !Number.isFinite(to.y)) return 0;
  const clamp = (value) => Math.max(-1, Math.min(1, value));
  const direction = bias.direction ?? 1;
  let score = -bias.weight * clamp((direction * (to.y - from.y)) / bias.unit);
  if (bias.centerWeight && bias.centerX != null && Number.isFinite(from.x) && Number.isFinite(to.x)) {
    const closer = Math.abs(from.x - bias.centerX) - Math.abs(to.x - bias.centerX);
    score -= bias.centerWeight * clamp(closer / bias.unit);
  }
  if (bias.revisitPenalty && bias.visited?.has(Number(to.id))) score += bias.revisitPenalty;
  // 避免返回 -0
  return score === 0 ? 0 : score;
}

/**
 * 路线结束之后的估计成本（见文件开头「计划分」）。
 * @returns {(endNode: { x?: number, y?: number, isShrinking?: boolean } | undefined,
 *            remaining: number, streak: number) => number}
 *   remaining：预算里没走的步数；streak：结束时已经连续在瘴气里的格数
 */
function makePlanTail(map, weights, center) {
  const idle = Math.max(0, Number(weights.EMPTY) || 0);
  const stepLength = center ? mapGeometry(map)?.stepLength || null : null;
  const radius = Number(center?.radius) > 0 ? Number(center.radius) : MIASMA_DEFAULT_RADIUS;
  return (endNode, remaining, streak = 0) => {
    let cost = Math.max(0, remaining) * idle;
    if (center && isNodeInMiasma(endNode)) {
      // 停在瘴气里：之后大约还要踩几格瘴气才回到圈里，越待越亏；再加上停在瘴气里本身的一格
      let steps = 1;
      if (stepLength && Number.isFinite(endNode?.x) && Number.isFinite(endNode?.y)) {
        const gap = Math.hypot(endNode.x - center.x, endNode.y - center.y) - radius;
        steps = Math.max(1, Math.ceil(gap / stepLength));
      }
      for (let index = 0; index < steps; index++) {
        cost += MIASMA_OUTSIDE_ENTER_SCORE + MIASMA_STAY_ESCALATION * Math.max(0, streak + index);
      }
      cost += MIASMA_OUTSIDE_ENTER_SCORE;
    }
    return cost;
  };
}

/**
 * 一条路线的「计划分」：路线本身的分 + 结束之后的估计成本。
 * @param {object} map
 * @param {number[]} path
 * @param {number} routeScore 路线本身的分（scoreExplorePath / DFS 的累计分）
 * @param {number} numPoints 点数上限 N
 * @param {ExploreScoreOptions} [opts]
 */
export function explorePlanScore(map, path, routeScore, numPoints, opts = {}) {
  const weights = getExploreWeights(opts);
  const center = opts.miasmaCenter || map.miasmaCenter || null;
  const tail = makePlanTail(map, weights, center);
  const byId = new Map(map.nodes.map((node) => [Number(node.id), node]));
  let streak = 0;
  if (center) for (const id of path) streak = nextMiasmaStreak(streak, byId.get(Number(id)));
  const remaining = Math.floor(Number(numPoints)) - path.length;
  return routeScore + tail(byId.get(Number(path[path.length - 1])), remaining, streak);
}

/**
 * @typedef {object} ExploreResult
 * @property {number[]} path
 * @property {number} score  路线本身的累计分（界面显示用）
 * @property {number} planScore  计划分 = 累计分 + 没走满时剩下步数的估计成本（比较路线用）
 * @property {number} rewardCount  得分为负的进入格数
 * @property {number} penaltyCount  得分为正的进入格数
 * @property {number} nodesVisited
 * @property {number} numPoints  实际点数（≤ maxPoints）
 * @property {number} maxPoints  预算上限 N
 * @property {number} day
 * @property {Record<string, number>} weights
 */

/**
 * 在长度 **2..N**（含）的简单路径中找计划分最低者。
 * 不必凑满 N：后面全是空地时到最后一个收益格就结束；但停下不是免费的，
 * 所以只要有比踩空地更划算的格子就会继续走过去。
 *
 * @param {{ nodes: { id: number, displayType: number, adjacentIds: number[] }[] }} map
 * @param {number} startId
 * @param {number} numPoints  点数上限 N（含起点）
 * @param {ExploreScoreOptions & { forcedPrefix?: number[] }} [opts]
 *   forcedPrefix：强制沿用的前缀（含起点），在此前缀上可结束或继续补全至 ≤N
 * @returns {ExploreResult | null}
 */
export function findLowestScorePath(map, startId, numPoints, opts = {}) {
  const n = Math.floor(Number(numPoints));
  if (!Number.isFinite(n) || n < 2) return null;

  const day = Number(opts.day) >= 2 ? 2 : 1;
  const weights = getExploreWeights(opts);
  const scoreOpts = { day, weights, nodeScores: opts.nodeScores || null };
  const center = opts.miasmaCenter || map.miasmaCenter || null;
  const down = opts.downBias || null;

  const byId = new Map(map.nodes.map((node) => [node.id, node]));
  if (!byId.has(startId) || byId.get(startId).displayType === NODE_TYPE.BOSS) {
    return null;
  }

  const maxSteps = n - 1; // 最多进入 maxSteps 格
  // 剪枝下界：毒圈最好情况 = 全程留在白圈内（+0），不按「朝圆心」给负 slack；
  // 向下偏置最好情况 = 每步都拿满 -weight；剩下步数的成本最好情况是 0
  const minStep = Math.min(0, minPossibleStepScore(scoreOpts) - maxSweepBonus(down));
  const planTail = makePlanTail(map, weights, center);

  /** @type {ExploreResult | null} */
  let best = null;
  let visitedExpand = 0;
  const maxExpand = Math.min(2_000_000, map.nodes.length ** 2 * 50);

  // —— 起始路径：默认只有起点；有 forcedPrefix 时校验后整段作为固定前缀 ——
  /** @type {number[]} */
  let path = [startId];
  let prefixScore = 0;
  /** streaks[i]：走到 path[i] 时连续在瘴气里的格数 */
  let streaks = [center ? nextMiasmaStreak(0, byId.get(startId)) : 0];
  if (Array.isArray(opts.forcedPrefix) && opts.forcedPrefix.length > 1) {
    const fp = opts.forcedPrefix.slice(0, n);
    let ok = Number(fp[0]) === Number(startId);
    const prefixStreaks = [streaks[0]];
    if (ok) {
      const seen = new Set([fp[0]]);
      for (let i = 1; ok && i < fp.length; i++) {
        const a = byId.get(fp[i - 1]);
        const b = byId.get(fp[i]);
        if (!a || !b || seen.has(fp[i]) || !a.adjacentIds.includes(fp[i])) {
          ok = false;
          break;
        }
        seen.add(fp[i]);
        const stepScore = scoreForNode(b, scoreOpts);
        if (!Number.isFinite(stepScore)) {
          ok = false;
          break;
        }
        prefixScore += stepScore + downStepScore(a, b, down);
        if (center) {
          prefixScore += miasmaStepScore(b, prefixStreaks[i - 1]);
          prefixStreaks.push(nextMiasmaStreak(prefixStreaks[i - 1], b));
        } else {
          prefixStreaks.push(0);
        }
      }
    }
    if (ok) {
      path = fp.slice();
      streaks = prefixStreaks;
    } else prefixScore = 0; // 前缀失效 → 退回自由搜索
  }
  const onPath = new Set(path);

  function tallyPath() {
    let rewardCount = 0;
    let penaltyCount = 0;
    for (let i = 1; i < path.length; i++) {
      const sc = scoreForNode(byId.get(path[i]), scoreOpts);
      if (sc < 0) rewardCount++;
      if (sc > 0) penaltyCount++;
    }
    return { rewardCount, penaltyCount };
  }

  /**
   * 把当前路径（depth≥1）登记为候选：计划分更低优先；
   * 同分时（周围已经没什么可拿的）：缩圈中终点离圈心更近的优先——闲着就往圈中间靠；再同分更短优先。
   */
  function consider(scoreSoFar, depth) {
    if (depth < 1) return;
    const end = byId.get(path[path.length - 1]);
    const planScore = scoreSoFar + planTail(end, maxSteps - depth, streaks[streaks.length - 1]);
    const endDist =
      center && Number.isFinite(end?.x) && Number.isFinite(end?.y)
        ? Math.hypot(end.x - center.x, end.y - center.y)
        : 0;
    let better = !best || planScore < best.planScore - 1e-9;
    if (!better && Math.abs(planScore - best.planScore) <= 1e-9) {
      better =
        endDist < best.endDist - 1e-6 ||
        (Math.abs(endDist - best.endDist) <= 1e-6 && path.length < best.numPoints);
    }
    if (!better) return;
    const { rewardCount, penaltyCount } = tallyPath();
    best = {
      path: path.slice(),
      score: scoreSoFar,
      planScore,
      endDist,
      rewardCount,
      penaltyCount,
      nodesVisited: visitedExpand,
      numPoints: path.length,
      maxPoints: n,
      day,
      weights,
    };
  }

  function dfs(scoreSoFar, depth) {
    if (visitedExpand > maxExpand) return;
    visitedExpand++;

    // ≤N：任意合法前缀都是候选（至少走 1 步）
    consider(scoreSoFar, depth);

    if (depth >= maxSteps) return;

    // 乐观下界：再走满剩余步，仍不可能优于 best → 剪枝
    // （不会因「单步变差」停搜；只要下界仍可能更好就继续扩）
    const remaining = maxSteps - depth;
    if (best && scoreSoFar + remaining * minStep >= best.planScore - 1e-9) return;

    const u = path[path.length - 1];
    const node = byId.get(u);
    if (!node) return;

    const neigh = node.adjacentIds
      .filter((v) => {
        if (!byId.has(v) || onPath.has(v)) return false;
        // 无目标扫路不进入 Boss；Boss 只由显式目标寻路到达。
        return byId.get(v).displayType !== NODE_TYPE.BOSS;
      })
      .map((v) => {
        const toN = byId.get(v);
        let s = scoreForNode(toN, scoreOpts) + downStepScore(node, toN, down);
        // 毒圈：进入瘴气格加分（更差），连续待得越久越亏；圈内游走不加，不强制去圆心
        if (center) {
          s += miasmaStepScore(toN, streaks[streaks.length - 1]);
        }
        // 优先扩展：同分时先走非瘴气格
        const outside = toN.isShrinking || toN.is_shrinking ? 1 : 0;
        return { v, s, outside };
      })
      .sort((a, b) => a.s - b.s || a.outside - b.outside);

    for (const { v, s } of neigh) {
      path.push(v);
      onPath.add(v);
      streaks.push(center ? nextMiasmaStreak(streaks[streaks.length - 1], byId.get(v)) : 0);
      dfs(scoreSoFar + s, depth + 1);
      streaks.pop();
      onPath.delete(v);
      path.pop();
      if (visitedExpand > maxExpand) return;
    }
  }

  dfs(prefixScore, path.length - 1);
  if (best) best.nodesVisited = visitedExpand;
  return best;
}

/** 换路阈值：新方案要比「沿用旧路线」至少好这么多分才切换（约一个收益格） */
export const REPLAN_STICKINESS = 8;

/**
 * 给一条已有路径打分（口径与 DFS 一致：进入格 + 可选毒圈软分，不含起点）。
 * @param {{ nodes: { id: number, displayType: number, adjacentIds?: number[], x?: number, y?: number }[] }} map
 * @param {number[]} path
 * @param {ExploreScoreOptions} [opts]
 * @returns {{ score: number, rewardCount: number, penaltyCount: number, valid: boolean }}
 */
export function scoreExplorePath(map, path, opts = {}) {
  const day = Number(opts.day) >= 2 ? 2 : 1;
  const weights = getExploreWeights(opts);
  const scoreOpts = { day, weights, nodeScores: opts.nodeScores || null };
  const center = opts.miasmaCenter || map.miasmaCenter || null;
  const down = opts.downBias || null;
  const byId = new Map(map.nodes.map((node) => [node.id, node]));
  if (
    !Array.isArray(path) ||
    path.length < 2 ||
    !byId.has(path[0]) ||
    byId.get(path[0]).displayType === NODE_TYPE.BOSS
  ) {
    return { score: 0, rewardCount: 0, penaltyCount: 0, valid: false };
  }
  let score = 0;
  let rewardCount = 0;
  let penaltyCount = 0;
  const seen = new Set([path[0]]);
  let streak = center ? nextMiasmaStreak(0, byId.get(path[0])) : 0;
  for (let i = 1; i < path.length; i++) {
    const a = byId.get(path[i - 1]);
    const b = byId.get(path[i]);
    if (!a || !b || seen.has(path[i])) {
      return { score, rewardCount, penaltyCount, valid: false };
    }
    if (Array.isArray(a.adjacentIds) && !a.adjacentIds.includes(path[i])) {
      return { score, rewardCount, penaltyCount, valid: false };
    }
    seen.add(path[i]);
    const sc = scoreForNode(b, scoreOpts);
    if (!Number.isFinite(sc)) {
      return { score, rewardCount, penaltyCount, valid: false };
    }
    score += sc + downStepScore(a, b, down);
    if (sc < 0) rewardCount++;
    if (sc > 0) penaltyCount++;
    if (center) {
      score += miasmaStepScore(b, streak);
      streak = nextMiasmaStreak(streak, b);
    }
  }
  return { score, rewardCount, penaltyCount, valid: true };
}

/**
 * 带「计划粘性」的扫路（≤N）：
 * 自由最优与「强制沿用旧剩余段再优化」都在同一预算下比分；
 * 新方案好不过 REPLAN_STICKINESS 就沿用旧路，减轻改道。
 *
 * @param {{ nodes: { id: number, displayType: number, adjacentIds: number[] }[] }} map
 * @param {number} startId
 * @param {number} numPoints  点数上限 N
 * @param {ExploreScoreOptions & { previousPath?: number[] | null }} [opts]
 * @returns {(ExploreResult & { keptPrevious: boolean, freshScore: number }) | null}
 */
export function findLowestScorePathSticky(map, startId, numPoints, opts = {}) {
  const { previousPath, ...rest } = opts;
  const fresh = findLowestScorePath(map, startId, numPoints, rest);
  const prev = Array.isArray(previousPath) ? previousPath : null;
  if (!prev || prev.length < 2 || Number(prev[0]) !== Number(startId)) {
    return fresh ? { ...fresh, keptPrevious: false, freshScore: fresh.score } : null;
  }

  const day = Number(rest.day) >= 2 ? 2 : 1;
  const weights = getExploreWeights(rest);
  const prevSc = scoreExplorePath(map, prev, rest);
  if (!prevSc.valid) {
    return fresh ? { ...fresh, keptPrevious: false, freshScore: fresh.score } : null;
  }

  // 以旧路为前缀，在 ≤N 内可原样结束或继续补全
  let kept = findLowestScorePath(map, startId, numPoints, {
    ...rest,
    forcedPrefix: prev,
  });
  let keptFollowsPrev =
    kept != null && prev.every((id, i) => Number(kept.path[i]) === Number(id));
  if (!keptFollowsPrev) {
    kept = {
      path: prev.slice(),
      score: prevSc.score,
      planScore: explorePlanScore(map, prev, prevSc.score, numPoints, rest),
      rewardCount: prevSc.rewardCount,
      penaltyCount: prevSc.penaltyCount,
      nodesVisited: 0,
      numPoints: prev.length,
      maxPoints: Math.floor(Number(numPoints)) || prev.length,
      day,
      weights,
    };
    keptFollowsPrev = true;
  }

  if (!fresh) {
    return { ...kept, keptPrevious: true, freshScore: kept.score };
  }

  // 同一起点、同一 ≤N 预算下直接比计划分（两者都是合法解）
  if (fresh.planScore < kept.planScore - REPLAN_STICKINESS) {
    return { ...fresh, keptPrevious: false, freshScore: fresh.score };
  }
  return {
    ...kept,
    keptPrevious: keptFollowsPrev,
    freshScore: fresh.score,
  };
}

/**
 * UI 说明文案
 * @param {ExploreScoreOptions} [opts]
 */
export function describeExploreScores(opts = {}) {
  const day = Number(opts.day) >= 2 ? 2 : 1;
  const W = getExploreWeights(opts);
  const strong = day >= 2 ? W.STRONG_DAY2 : W.STRONG_DAY1;
  return [
    `D${day}`,
    `战 ${W.BATTLE}`,
    `事 ${W.EVENT}`,
    `箱 ${W.CHEST}`,
    `店 ${W.SHOP}`,
    `回复 ${W.HEAL}`,
    `空地 ${W.EMPTY}`,
    `强敌 ${strong}${day >= 2 ? "(次日)" : ""}`,
    `超强 ${W.TERRIFYING}`,
  ].join(" · ");
}
