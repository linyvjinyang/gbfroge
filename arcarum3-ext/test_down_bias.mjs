/**
 * 验证「先向下走到地图下边缘，同时保证收益」的扫路偏置。
 * 用合成网格图（列 5 × 行 7，间距 100，四连通），不依赖本地抓包快照。
 */
import assert from "node:assert/strict";
import {
  CENTER_BIAS_RATIO,
  DOWN_BIAS_WEIGHT,
  REVISIT_PENALTY_RATIO,
  downStepScore,
  findLowestScorePath,
  findLowestScorePathSticky,
  makeDownBias,
  makeSweepBias,
  scoreExplorePath,
} from "./shared/path/exploreScore.js";
import { toRouteMap } from "./shared/path/weightedRoute.js";

const COLS = 5;
const ROWS = 7;
const idOf = (col, row) => row * COLS + col + 1;

/** @param {Record<number, number>} types node_id → node_type（默认空地 0） */
function gridState(types = {}) {
  const node_list = [];
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const adjacent = [];
      if (col > 0) adjacent.push(idOf(col - 1, row));
      if (col < COLS - 1) adjacent.push(idOf(col + 1, row));
      if (row > 0) adjacent.push(idOf(col, row - 1));
      if (row < ROWS - 1) adjacent.push(idOf(col, row + 1));
      const node_id = idOf(col, row);
      node_list.push({
        node_id,
        position_x: 100 + col * 100,
        position_y: 100 + row * 100,
        node_type: types[node_id] ?? 0,
        adjacent_node_ids: adjacent,
      });
    }
  }
  return { node_list };
}

const rowOf = (id) => Math.floor((id - 1) / COLS);
const BATTLE = 2;
const CHEST = 6;

// —— 1) 偏置上下文 ——
{
  const map = toRouteMap(gridState());
  const start = idOf(2, 0);
  const down = makeDownBias(map, start);
  assert.ok(down, "起点在顶部时应启用向下偏置");
  assert.equal(down.unit, 100, "单位取纵向边的落差中位数");
  assert.equal(down.weight, DOWN_BIAS_WEIGHT);

  const byId = new Map(map.nodes.map((node) => [node.id, node]));
  const from = byId.get(start);
  assert.equal(downStepScore(from, byId.get(idOf(2, 1)), down), -DOWN_BIAS_WEIGHT);
  assert.equal(downStepScore(byId.get(idOf(2, 1)), from, down), DOWN_BIAS_WEIGHT);
  assert.equal(downStepScore(from, byId.get(idOf(3, 0)), down), 0, "横向移动不加不减");
  assert.equal(downStepScore(from, byId.get(idOf(2, 1)), null), 0);

  assert.equal(makeDownBias(map, idOf(2, ROWS - 1)), null, "已在最下一行时偏置关闭");
  assert.equal(makeDownBias(map, start, 0), null, "权重 0 等于关闭");
}

// —— 2) 收益都在顶部：不开偏置留在上面，开偏置会往下走 ——
{
  const types = {
    [idOf(0, 0)]: BATTLE,
    [idOf(1, 0)]: BATTLE,
    [idOf(3, 0)]: BATTLE,
    [idOf(4, 0)]: BATTLE,
  };
  const map = toRouteMap(gridState(types));
  const start = idOf(2, 0);

  const plain = findLowestScorePath(map, start, 8, { day: 1 });
  assert.ok(plain);
  assert.equal(
    Math.max(...plain.path.map(rowOf)),
    0,
    "无偏置时只吃同一行的收益，不会无故下行",
  );

  const down = makeDownBias(map, start);
  const biased = findLowestScorePath(map, start, 8, { day: 1, downBias: down });
  assert.ok(biased);
  const endRow = rowOf(biased.path.at(-1));
  assert.ok(endRow >= 4, `开偏置后终点应明显靠下，实际第 ${endRow} 行`);
  assert.ok(biased.rewardCount >= 2, "向下的同时仍应先吃掉顺路的收益格");

  const rescored = scoreExplorePath(map, biased.path, { day: 1, downBias: down });
  assert.ok(rescored.valid);
  assert.ok(
    Math.abs(rescored.score - biased.score) < 1e-9,
    "路径复评分必须与搜索时口径一致",
  );
}

// —— 3) 下行途中有收益：宁可绕一格去吃，也不走全空地的直线 ——
{
  const types = {
    [idOf(3, 1)]: CHEST,
    [idOf(3, 2)]: BATTLE,
    [idOf(3, 3)]: BATTLE,
    [idOf(3, 4)]: CHEST,
  };
  const map = toRouteMap(gridState(types));
  const start = idOf(2, 0);
  const down = makeDownBias(map, start);
  const result = findLowestScorePath(map, start, ROWS + 1, { day: 1, downBias: down });
  assert.ok(result);
  assert.equal(rowOf(result.path.at(-1)), ROWS - 1, "预算足够时应走到下边缘");
  assert.equal(result.rewardCount, 4, "旁边一列的 4 个收益格应全部吃到");
}

// —— 4) 到下边缘后：偏置关闭，行为与普通扫路完全一致 ——
{
  const types = { [idOf(0, ROWS - 1)]: BATTLE, [idOf(2, 0)]: BATTLE };
  const map = toRouteMap(gridState(types));
  const start = idOf(2, ROWS - 1);
  const down = makeDownBias(map, start);
  assert.equal(down, null);
  const a = findLowestScorePath(map, start, 6, { day: 1, downBias: down });
  const b = findLowestScorePath(map, start, 6, { day: 1 });
  assert.deepEqual(a.path, b.path);
  assert.equal(a.score, b.score);
}

// —— 5) 粘性重规划在偏置下仍可用（旧路线按同一口径计分） ——
{
  const types = { [idOf(3, 1)]: CHEST, [idOf(3, 3)]: BATTLE };
  const map = toRouteMap(gridState(types));
  const start = idOf(2, 0);
  const down = makeDownBias(map, start);
  const first = findLowestScorePath(map, start, 8, { day: 1, downBias: down });
  const again = findLowestScorePathSticky(map, start, 8, {
    day: 1,
    downBias: down,
    previousPath: first.path,
  });
  assert.ok(again.keptPrevious, "同一状态下重算应沿用旧路线");
  assert.deepEqual(again.path, first.path);
}

// —— 6) 横向边比纵向边长的地图：正下方一步仍拿满奖励，能穿过空地走到下边缘 ——
{
  const state = gridState();
  for (const node of state.node_list) node.position_x *= 3; // 横向间距 300，纵向 100
  const map = toRouteMap(state);
  const start = idOf(2, 0);
  const down = makeDownBias(map, start);
  assert.equal(down.unit, 100, "横向边再长也不稀释下行单位");
  const result = findLowestScorePath(map, start, ROWS + 1, { day: 1, downBias: down });
  assert.equal(rowOf(result.path.at(-1)), ROWS - 1, "全是空地也应一路走到下边缘");
}

// —— 7) 到过下边缘之后：掉头往上、往中间走 ——
{
  const map = toRouteMap(gridState());
  const byId = new Map(map.nodes.map((node) => [node.id, node]));
  const corner = idOf(0, ROWS - 1); // 左下角

  // 还没到过下边缘：仍然是向下阶段
  const before = makeSweepBias(map, idOf(0, 2));
  assert.equal(before.phase, "down");
  assert.equal(before.direction, 1);
  assert.equal(before.centerWeight, 0);

  // 站在下边缘：进入向上阶段
  const up = makeSweepBias(map, corner);
  assert.equal(up.phase, "up");
  assert.equal(up.direction, -1);
  assert.equal(up.centerX, 300, "地图横向中线");
  assert.equal(up.centerWeight, DOWN_BIAS_WEIGHT * CENTER_BIAS_RATIO);
  assert.equal(makeDownBias(map, corner), null, "只要向下阶段的旧接口：到边缘后仍然是关闭");

  const from = byId.get(corner);
  assert.equal(downStepScore(from, byId.get(idOf(0, ROWS - 2)), up), -DOWN_BIAS_WEIGHT, "向上一步拿满奖励");
  assert.equal(downStepScore(byId.get(idOf(0, ROWS - 2)), from, up), DOWN_BIAS_WEIGHT, "再往下走是惩罚");
  assert.equal(downStepScore(from, byId.get(idOf(1, ROWS - 1)), up), -up.centerWeight, "横向靠近中线有奖励");
  assert.equal(downStepScore(byId.get(idOf(1, ROWS - 1)), from, up), up.centerWeight, "远离中线是惩罚");
  assert.equal(downStepScore(byId.get(idOf(2, 3)), byId.get(idOf(2, 2)), up), -DOWN_BIAS_WEIGHT, "已在中线上：只算向上");

  // 离开下边缘一步之后：靠「走过的节点里有下边缘的」判断，不会掉回向下阶段
  const later = makeSweepBias(map, idOf(0, ROWS - 2), { visitedIds: [corner] });
  assert.equal(later.phase, "up");
  assert.equal(makeSweepBias(map, idOf(0, ROWS - 2), { visitedIds: [idOf(0, 0)] }).phase, "down", "走过的都在上面，不算到过下边缘");

  // 往上走到上边缘：结束
  assert.equal(makeSweepBias(map, idOf(2, 0), { visitedIds: [corner] }), null);
  // 缩圈已经出现：不再偏向任何方向
  assert.equal(makeSweepBias(map, corner, { miasmaActive: true }), null);
  assert.equal(makeSweepBias(map, idOf(0, 2), { miasmaActive: true }), null);
  // 关掉「之后向上」：到边缘就结束
  assert.equal(makeSweepBias(map, corner, { upAfterEdge: false }), null);
  // 关掉「先向下」：从一开始就往上、往中间
  const upOnly = makeSweepBias(map, idOf(0, 3), { downFirst: false });
  assert.equal(upOnly.phase, "up");
  assert.equal(makeSweepBias(map, idOf(0, 3), { weight: 0 }), null);

  // 路线：从左下角出发，全是空地，也会一路向上走到上边缘
  const result = findLowestScorePath(map, corner, ROWS + 3, { day: 1, downBias: up });
  assert.ok(result);
  const end = result.path.at(-1);
  assert.equal(rowOf(end), 0, "走到上边缘");
  assert.ok(result.path.every((id, i) => i === 0 || rowOf(id) <= rowOf(result.path[i - 1])), "一路不往回（向下）走");

  // 「靠中间」是次要偏好：两条同样向上的岔路，选靠近中线的那条；
  // 但不会为了靠中间专门横穿空地，也不会因此放弃偏一点的收益格。
  const node = (id, x, y, adjacentIds, displayType = 0) => ({ id, x, y, adjacentIds, displayType });
  const fork = {
    nodes: [
      node(1, 100, 500, [2, 3]), // 起点，在左下
      node(2, 0, 400, [1, 4]), // 向上、往外
      node(3, 200, 400, [1, 5]), // 向上、往中间
      node(4, 0, 300, [2]),
      node(5, 200, 300, [3]),
      node(6, 600, 300, []), // 只用来把中线定在 x=300
    ],
  };
  const forkBias = makeSweepBias(fork, 1);
  assert.equal(forkBias.phase, "up");
  assert.equal(forkBias.centerX, 300);
  assert.deepEqual(findLowestScorePath(fork, 1, 3, { day: 1, downBias: forkBias }).path, [1, 3, 5]);
  // 往外那条路上有收益格时，收益优先
  fork.nodes[1].displayType = 2;
  fork.nodes[3].displayType = 2;
  assert.deepEqual(findLowestScorePath(fork, 1, 3, { day: 1, downBias: forkBias }).path, [1, 2, 4]);
  const rescored = scoreExplorePath(map, result.path, { day: 1, downBias: up });
  assert.ok(Math.abs(rescored.score - result.score) < 1e-9, "向上阶段的复评分口径一致");
}

// —— 8) 尽量不重复走：往上时宁可挪到旁边没走过的一列，也不原路返回 ——
{
  const map = toRouteMap(gridState());
  const byId = new Map(map.nodes.map((node) => [node.id, node]));
  const start = idOf(1, ROWS - 1); // 下边缘，中线左边一列
  // 来的时候是顺着这一列下来的：正上方这些都走过了
  const visitedIds = [start, idOf(1, ROWS - 2), idOf(1, ROWS - 3), idOf(1, ROWS - 4), idOf(1, ROWS - 5)];
  const bias = makeSweepBias(map, start, { visitedIds });
  assert.equal(bias.phase, "up");
  assert.equal(bias.revisitPenalty, DOWN_BIAS_WEIGHT * REVISIT_PENALTY_RATIO);
  assert.equal(
    downStepScore(byId.get(start), byId.get(idOf(1, ROWS - 2)), bias),
    -DOWN_BIAS_WEIGHT + bias.revisitPenalty,
    "走回头路要多付一点",
  );
  assert.equal(
    downStepScore(byId.get(idOf(2, ROWS - 1)), byId.get(idOf(2, ROWS - 2)), bias),
    -DOWN_BIAS_WEIGHT,
    "没走过的节点不加",
  );

  const result = findLowestScorePath(map, start, 6, { day: 1, downBias: bias });
  const revisited = result.path.slice(1).filter((id) => visitedIds.includes(id));
  assert.deepEqual(revisited, [], `向上时应绕开来时走过的节点，实际路线 ${result.path.join("→")}`);
  assert.equal((result.path[1] - 1) % COLS, 2, "先挪到中间那一列");
  assert.equal(rowOf(result.path.at(-1)), ROWS - 5, "然后一路向上");

  // 没有走过的记录时，直接沿原来那一列向上（不平白绕路）
  const plain = findLowestScorePath(map, start, 3, { day: 1, downBias: makeSweepBias(map, start) });
  assert.deepEqual(plain.path, [start, idOf(1, ROWS - 2), idOf(1, ROWS - 3)]);
}

console.log("down-bias tests passed");
