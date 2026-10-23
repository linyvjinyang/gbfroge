/**
 * 扫路「停下不是免费的」：每回合都得走，所以
 *   - 周围打完了也会继续往有收益的地方走，不会只给 1 步；
 *   - 缩圈后人在圈外，会往圈里走；
 *   - 圈里打完了没什么可拿时，往圈中间靠；
 *   - 圈边的收益会顺手拿，但不会在瘴气里一直逛、也不会停在瘴气里。
 * 用合成网格图（9 × 9，间距 100，四连通）。
 */
import assert from "node:assert/strict";
import { explorePlanScore, findLowestScorePath, scoreExplorePath } from "./shared/path/exploreScore.js";
import { toRouteMap } from "./shared/path/weightedRoute.js";

const SIZE = 9;
const idOf = (col, row) => row * SIZE + col + 1;
const colOf = (id) => (id - 1) % SIZE;
const rowOf = (id) => Math.floor((id - 1) / SIZE);
const BATTLE = 2;

/**
 * @param {(col: number, row: number) => number} typeAt
 * @param {{ x: number, y: number, r: number } | null} circle 缩圈：圆心和半径（世界坐标）
 */
function gridState(typeAt, circle = null, track = null) {
  const node_list = [];
  for (let row = 0; row < SIZE; row++) {
    for (let col = 0; col < SIZE; col++) {
      const adjacent = [];
      if (col > 0) adjacent.push(idOf(col - 1, row));
      if (col < SIZE - 1) adjacent.push(idOf(col + 1, row));
      if (row > 0) adjacent.push(idOf(col, row - 1));
      if (row < SIZE - 1) adjacent.push(idOf(col, row + 1));
      const x = 100 + col * 100;
      const y = 100 + row * 100;
      node_list.push({
        node_id: idOf(col, row),
        position_x: x,
        position_y: y,
        node_type: typeAt(col, row),
        adjacent_node_ids: adjacent,
        is_shrinking: circle ? Math.hypot(x - circle.x, y - circle.y) > circle.r : false,
      });
    }
  }
  const state = { node_list };
  if (track) state.miasma_track = track;
  if (circle) {
    state.miasma_info = {
      after: { is_miasmic: true, center_position_x: circle.x, center_position_y: circle.y, safe_radius: circle.r, pattern_id: 1 },
    };
  }
  return state;
}

const plan = (state, start, n = 12) => {
  const map = toRouteMap(state);
  const result = findLowestScorePath(map, start, n, { day: 1, miasmaCenter: map.miasmaCenter });
  assert.ok(result, "应该有路线");
  return { map, result, byId: new Map(state.node_list.map((node) => [node.node_id, node])) };
};

// —— 1) 周围都打完了，收益在 3 格外：要走过去，不能只给 1 步 ——
{
  const start = idOf(4, 4);
  const state = gridState((col, row) => (Math.abs(col - 4) + Math.abs(row - 4) === 3 ? BATTLE : 0));
  const { result } = plan(state, start);
  assert.ok(result.path.length - 1 >= 3, `应走到 3 格外的收益，实际 ${result.path.length - 1} 步`);
  assert.ok(result.rewardCount >= 2, "一路把够得着的收益都拿上");
  assert.ok(result.planScore >= result.score, "计划分 = 路线分 + 之后的估计成本");
}

// —— 2) 缩圈后人在圈外很远：往圈里走，最后停在圈里 ——
{
  const circle = { x: 500, y: 500, r: 150 }; // 圈里只有正中间的十字 5 个格子
  const start = idOf(0, 0);
  const state = gridState(() => 0, circle);
  const { result, byId } = plan(state, start, 14);
  const end = byId.get(result.path.at(-1));
  assert.equal(end.is_shrinking, false, `应走进圈里，终点 ${colOf(end.node_id)},${rowOf(end.node_id)}`);
  assert.ok(result.path.length - 1 >= 7, "从角上走进圈里至少 7 步");
}

// —— 3) 圈里都打完了、外面也没什么好拿：往圈中间靠，不是只走 1 步 ——
{
  const circle = { x: 500, y: 500, r: 260 };
  const start = idOf(2, 4); // 圈的左边缘
  const state = gridState(() => 0, circle);
  const { result, byId } = plan(state, start);
  const dist = (id) => Math.hypot(byId.get(id).position_x - circle.x, byId.get(id).position_y - circle.y);
  assert.ok(result.path.length - 1 >= 2, "闲着也往圈中间走");
  assert.ok(dist(result.path.at(-1)) < dist(start), "终点比起点更靠近圈心");
  assert.ok(result.path.every((id) => !byId.get(id).is_shrinking), "不出圈");
}

// —— 4) 圈会缩：人在圈中心时，不会为了圈边外的收益往外跑（那里迟早被吞） ——
{
  const circle = { x: 500, y: 500, r: 260 };
  const start = idOf(4, 4);
  const state = gridState((col, row) => (col === 2 && row === 2 ? BATTLE : 0), circle);
  const { result, byId } = plan(state, start);
  assert.equal(byId.get(idOf(2, 2)).is_shrinking, true);
  assert.ok(result.path.every((id) => !byId.get(id).is_shrinking), "不进瘴气拿收益（会吃毒）");
}

// —— 4b) 往圈心去的路上有收益：顺路拿 ——
{
  const circle = { x: 500, y: 500, r: 260 };
  const start = idOf(2, 4); // 圈的左边缘
  const state = gridState((col, row) => (col === 3 && row === 4 ? BATTLE : 0), circle);
  const { result } = plan(state, start);
  assert.ok(result.path.includes(idOf(3, 4)), "往圈心去的路上的收益会拿");
  assert.ok(result.path.includes(idOf(4, 4)), "最后到圈中心");
}

// —— 5) 圈外深处的一串收益：不会在瘴气里一直逛 ——
{
  const circle = { x: 500, y: 500, r: 260 };
  const start = idOf(4, 4);
  const state = gridState((col) => (col === 0 ? BATTLE : 0), circle);
  const { result, byId } = plan(state, start, 16);
  let longest = 0;
  let streak = 0;
  for (const id of result.path) {
    streak = byId.get(id).is_shrinking ? streak + 1 : 0;
    longest = Math.max(longest, streak);
  }
  assert.ok(longest <= 3, `连续在瘴气里最多几格，实际 ${longest}`);
}

// —— 6) 计划分和单独算的一致（粘性换路用它比较） ——
{
  const circle = { x: 500, y: 500, r: 260 };
  const state = gridState((col, row) => ((col + row) % 3 === 0 ? BATTLE : 0), circle);
  const start = idOf(0, 4);
  const { map, result } = plan(state, start, 10);
  const scored = scoreExplorePath(map, result.path, { day: 1, miasmaCenter: map.miasmaCenter });
  assert.equal(scored.score, result.score);
  assert.equal(
    explorePlanScore(map, result.path, scored.score, 10, { day: 1, miasmaCenter: map.miasmaCenter }),
    result.planScore,
  );
}

// —— 7) 学到缩圈速度后：到时会被吞的格子不去（按地图距离预测，不按格子数） ——
{
  const circle = { x: 500, y: 500, r: 360 };
  const start = idOf(4, 4);
  // 圈边上的 (1,4) 在圈里（离圆心 300），走过去要 3 回合
  const reward = idOf(1, 4);
  const typeAt = (col, row) => (col === 1 && row === 4 ? BATTLE : 0);

  const unknown = plan(gridState(typeAt, circle), start);
  assert.ok(unknown.result.path.includes(reward), "还没学到速度：圈边的收益照拿");

  // 最近两回合圈从 400 缩到 340（每回合 30）：3 回合后半径约 250，(1,4) 那时已经被吞
  const fast = plan(gridState(typeAt, circle, [{ turn: 3, radius: 400 }, { turn: 5, radius: 340 }]), start);
  assert.ok(!fast.result.path.includes(reward), "学到缩得快：不去到时会被吞的格子");

  // 缩得很慢（每回合 2）：3 回合后还在圈里，照拿
  const slow = plan(gridState(typeAt, circle, [{ turn: 3, radius: 344 }, { turn: 5, radius: 340 }]), start);
  assert.ok(slow.result.path.includes(reward), "缩得慢：圈边的收益照拿");
}

console.log("route keep-moving tests passed");
