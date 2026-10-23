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
function gridState(typeAt, circle = null) {
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

// —— 4) 圈边外面一格有收益、进出都只踩这一格瘴气：顺手拿，然后回到圈里，不停在瘴气里 ——
{
  const circle = { x: 500, y: 500, r: 260 };
  const start = idOf(4, 4);
  // (2,2) 在圈外，左右两边的 (3,2)、(2,3) 都在圈里：从一边进、另一边出
  const state = gridState((col, row) => (col === 2 && row === 2 ? BATTLE : 0), circle);
  const { result, byId } = plan(state, start);
  assert.equal(byId.get(idOf(2, 2)).is_shrinking, true);
  assert.ok(result.path.includes(idOf(2, 2)), "圈边外一格的收益会去拿");
  assert.equal(byId.get(result.path.at(-1)).is_shrinking, false, "拿完回到圈里，不停在瘴气里");
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

console.log("route keep-moving tests passed");
