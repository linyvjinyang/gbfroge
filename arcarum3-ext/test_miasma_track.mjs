/** 缩圈：按瘴气标记估半径、每回合记一笔、学缩圈速度 */
import assert from "node:assert/strict";
import { estimateSafeRadius, estimateShrinkSpeed, withMiasmaTrack } from "./shared/miasma.js";
import { applyDungeonActions, mergeDungeonState } from "./shared/map-model.js";

const center = { x: 0, y: 0 };
const node = (id, x, shrinking) => ({
  node_id: id,
  position_x: x,
  position_y: 0,
  node_type: 0,
  adjacent_node_ids: [],
  is_shrinking: shrinking,
});

// —— 估半径：圈内最远和瘴气里最近的中间 ——
assert.equal(estimateSafeRadius([node(1, 100, false), node(2, 300, false), node(3, 500, true)], center), 400);
assert.equal(estimateSafeRadius([node(1, 100, false)], center), 100, "还没有瘴气格：取圈内最远");
assert.equal(estimateSafeRadius([node(1, 500, true)], center), 500, "全是瘴气：取最近的瘴气格");
assert.equal(estimateSafeRadius([node(1, 100, false)], null), null);
// 也认寻路图的 x / y / isShrinking
assert.equal(estimateSafeRadius([{ x: 200, y: 0, isShrinking: false }, { x: 0, y: 400, isShrinking: true }], center), 300);

// —— 学速度 ——
assert.equal(estimateShrinkSpeed(null), null);
assert.equal(estimateShrinkSpeed([{ turn: 3, radius: 400 }]), null, "一笔记录学不出速度");
assert.equal(estimateShrinkSpeed([{ turn: 3, radius: 400 }, { turn: 3, radius: 380 }]), null, "同一回合学不出速度");
assert.equal(estimateShrinkSpeed([{ turn: 3, radius: 400 }, { turn: 5, radius: 400 }]), null, "没在缩：不预测");
assert.deepEqual(estimateShrinkSpeed([{ turn: 3, radius: 400 }, { turn: 5, radius: 340 }]), { speed: 30, samples: 2 });
{
  // 隔几回合缩一次（台阶状）也能拟合出平均速度
  const stepwise = [
    { turn: 1, radius: 600 },
    { turn: 2, radius: 600 },
    { turn: 3, radius: 500 },
    { turn: 4, radius: 500 },
    { turn: 5, radius: 400 },
  ];
  const { speed } = estimateShrinkSpeed(stepwise);
  assert.ok(speed > 40 && speed < 60, `平均每回合约 50，实际 ${speed}`);
}
{
  // 圈突然变大（换了阶段）：之前的记录不算
  const reset = [
    { turn: 1, radius: 300 },
    { turn: 2, radius: 200 },
    { turn: 3, radius: 600 },
    { turn: 5, radius: 560 },
  ];
  assert.deepEqual(estimateShrinkSpeed(reset), { speed: 20, samples: 2 });
}

// —— 每回合记一笔 ——
const miasmaInfo = { after: { is_miasmic: true, center_position_x: 0, center_position_y: 0, pattern_id: 1 } };
const mapAt = (turn, nodes, extra = {}) => ({
  map_id: 1,
  total_turn: turn,
  miasma_info: miasmaInfo,
  current_node_id: 1,
  node_list: nodes,
  ...extra,
});
{
  let state = withMiasmaTrack(mapAt(10, [node(1, 100, false), node(2, 300, false), node(3, 500, true)]));
  assert.deepEqual(state.miasma_track, [{ turn: 10, radius: 400 }]);
  assert.equal(withMiasmaTrack(state), state, "没变化原样返回");
  // 同一回合又收到更新：只留最新的
  state = withMiasmaTrack({ ...state, node_list: [node(1, 100, false), node(2, 300, true), node(3, 500, true)] });
  assert.deepEqual(state.miasma_track, [{ turn: 10, radius: 200 }]);
  state = withMiasmaTrack({ ...state, total_turn: 11 });
  assert.equal(state.miasma_track.length, 2);
  // 回合数变小：新的一局，从头记
  state = withMiasmaTrack({ ...state, total_turn: 0 });
  assert.deepEqual(state.miasma_track, [{ turn: 0, radius: 200 }]);
  // 没开缩圈：不记
  assert.equal(withMiasmaTrack({ total_turn: 3, node_list: [node(1, 100, false)] }).miasma_track, undefined);
}

// —— 整图读取和移动都会记 ——
{
  const nodes = [node(1, 100, false), node(2, 300, false), node(3, 500, true)];
  let state = mergeDungeonState(null, mapAt(10, nodes), { kind: "map_index" });
  assert.deepEqual(state.miasma_track, [{ turn: 10, radius: 400 }]);
  // 走一步：这一步吞掉了 2 号格子
  state = applyDungeonActions(state, {
    after_current_node_id: 2,
    total_turn: 11,
    miasma_info: { ...miasmaInfo, shrink_node_ids: [2] },
  }).state;
  assert.deepEqual(state.miasma_track, [{ turn: 10, radius: 400 }, { turn: 11, radius: 200 }]);
  assert.deepEqual(estimateShrinkSpeed(state.miasma_track), { speed: 200, samples: 2 });
  // 换了一张地图：从头记
  state = mergeDungeonState(state, mapAt(12, nodes, { map_id: 2 }), { kind: "map_index" });
  assert.deepEqual(state.miasma_track, [{ turn: 12, radius: 400 }]);
}

console.log("miasma track tests passed");
