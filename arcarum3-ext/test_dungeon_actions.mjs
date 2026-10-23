import assert from "node:assert/strict";
import { applyDungeonActions, isRunStart, listActionScenarios } from "./shared/map-model.js";
import { createGuidebookState, resetGuidebookRun } from "./shared/guidebooks.js";
import { extractScenarioParty } from "./shared/party.js";

const node = (id, type, extra = {}) => ({
  node_id: id,
  node_type: type,
  position_x: id * 10,
  position_y: 0,
  adjacent_node_ids: [],
  is_visited: false,
  special_incident_id: null,
  ...extra,
});
const base = () => ({
  current_node_id: 1,
  total_turn: 4,
  possession_arcarum3_dungeon_point: 100,
  node_list: [node(1, 0, { is_visited: true }), node(2, 2), node(3, 5), node(4, 10, { special_incident_id: 3 })],
});
const find = (state, id) => state.node_list.find((item) => item.node_id === id);

// 没有地图、或响应不是对象：原样返回
assert.deepEqual(applyDungeonActions(null, { after_current_node_id: 2 }), { state: null, changed: false });
{
  const prev = base();
  const result = applyDungeonActions(prev, null);
  assert.equal(result.changed, false);
  assert.equal(result.state, prev);
}

// 走一步：位置更新，新格子算走过；不改动传入的对象
{
  const prev = base();
  const { state, changed } = applyDungeonActions(prev, { after_current_node_id: "2" });
  assert.equal(changed, true);
  assert.equal(state.current_node_id, 2);
  assert.equal(find(state, 2).is_visited, true);
  assert.equal(prev.current_node_id, 1, "不改动原来的状态");
  assert.equal(find(prev, 2).is_visited, false);
  assert.equal(find(state, 3), find(prev, 3), "没变的格子沿用原对象");
}

// 什么都没变：changed 为 false，返回原对象（窗口不用重画）
{
  const prev = base();
  const result = applyDungeonActions(prev, { after_current_node_id: 1, action_scenario_list: [{ action_type: 1 }] });
  assert.equal(result.changed, false);
  assert.equal(result.state, prev);
}

// 传送（5）：换到目的地，路过的格子清掉
{
  const { state } = applyDungeonActions(base(), {
    action_scenario_list: [{ action_type: 5, warp_node_id: 3, delete_node_ids: [2] }],
  });
  assert.equal(state.current_node_id, 3);
  assert.equal(find(state, 2).node_type, 0);
  assert.equal(find(state, 3).is_visited, true);
}

// 清掉格子（7）：特殊事件的编号一并清掉
{
  const { state, changed } = applyDungeonActions(base(), {
    action_scenario_list: [{ action_type: 7, delete_node_ids: [4, 99] }],
  });
  assert.equal(changed, true);
  assert.deepEqual([find(state, 4).node_type, find(state, 4).special_incident_id], [0, null]);
}

// 出现特殊事件（11）
{
  const { state } = applyDungeonActions(base(), {
    action_scenario_list: [{ action_type: 11, node_id: 3, special_incident_id: 9 }],
  });
  assert.deepEqual([find(state, 3).node_type, find(state, 3).special_incident_id], [10, 9]);
  // 没带编号的 11 只是镜头移过去，不动格子
  const untouched = applyDungeonActions(base(), { action_scenario_list: [{ action_type: 11, node_id: 3 }] });
  assert.equal(untouched.changed, false);
}

// finish_node_event：当前格子用掉、新出现的特殊事件
{
  const prev = { ...base(), current_node_id: 3 };
  const { state } = applyDungeonActions(prev, {
    is_delete_node: true,
    special_incident_appearance_info: {
      a: { appearance_list: [{ node_id: 2, special_incident_id: 5 }] },
      b: { appearance_list: [] },
      c: null,
    },
  });
  assert.equal(find(state, 3).node_type, 0);
  assert.deepEqual([find(state, 2).node_type, find(state, 2).special_incident_id], [10, 5]);
  // is_delete_node 为 false 时格子保留
  const kept = applyDungeonActions(prev, { is_delete_node: false, special_incident_appearance_info: {} });
  assert.equal(find(kept.state, 3).node_type, 5);
}

// 顺带的数值：有就更新，没有就保持
{
  const { state } = applyDungeonActions(base(), { total_turn: "5", possession_arcarum3_dungeon_point: 250 });
  assert.equal(state.total_turn, 5);
  assert.equal(state.possession_arcarum3_dungeon_point, 250);
  const same = applyDungeonActions(base(), { total_turn: 4 });
  assert.equal(same.changed, false);
}

// 这一步被瘴气吞掉的格子、最新的瘴气状态（真实抓包里 miasma_info 带 before / after / shrink_node_ids）
{
  const prev = base();
  const after = { is_miasmic: true, center_position_x: 30, center_position_y: 0, level: 1, step: 2, pattern_id: 1 };
  const { state, changed } = applyDungeonActions(prev, {
    after_current_node_id: 2,
    miasma_info: { before: { is_miasmic: true }, after, shrink_node_ids: [3, 4] },
    total_turn: 5,
  });
  assert.equal(changed, true);
  assert.equal(find(state, 3).is_shrinking, true, "被吞掉的格子标成瘴气");
  assert.equal(find(state, 4).is_shrinking, true);
  assert.equal(Boolean(find(state, 1).is_shrinking), false);
  assert.deepEqual(state.miasma_info.after, after, "瘴气状态换成最新的");
  assert.equal("shrink_node_ids" in state.miasma_info, false, "这一步的变化不存进状态");
  assert.equal(prev.miasma_info, undefined, "不改动原来的状态");

  // 没有缩圈、瘴气状态也没变：不算变化
  const again = applyDungeonActions(state, {
    miasma_info: { before: { is_miasmic: true }, after, shrink_node_ids: [] },
  });
  assert.equal(again.changed, false);
}

// 行动脚本的几种写法
assert.equal(listActionScenarios({ action_scenario_list: [{ action_type: 1 }, null, 3] }).length, 1);
assert.equal(listActionScenarios({ data: { action_scenario_list: [{}] } }).length, 1);
assert.deepEqual(listActionScenarios({}), []);

// 队伍血量：取最后一步的
{
  const party = extractScenarioParty(
    {
      action_scenario_list: [
        { action_type: 3, after_party_status: [{ image_id: "a", hp: 10, max_hp: 100, attribute: 1 }] },
        { action_type: 4 },
        { action_type: 3, after_party_status: [{ image_id: "a", hp: "55", max_hp: "100", attribute: "1" }] },
        { action_type: 9, after_party_status: [] },
      ],
    },
    1234,
  );
  assert.deepEqual(party, {
    members: [{ imageId: "a", hp: 55, hpMax: 100, attribute: 1 }],
    updatedAt: 1234,
  });
  assert.equal(extractScenarioParty({ action_scenario_list: [{ action_type: 1 }] }), null);
  assert.equal(extractScenarioParty({}), null);
  assert.equal(extractScenarioParty(null), null);
}

// 一局的开头：第 1 天第 1 回合的整张地图
{
  const nodes = [node(1, 0)];
  assert.equal(isRunStart({ node_list: nodes, total_turn: 0 }), true);
  assert.equal(isRunStart({ node_list: nodes, total_turn: "0" }), true);
  assert.equal(isRunStart({ node_list: nodes, total_turn: 1 }), false, "第 2 回合不算");
  assert.equal(isRunStart({ node_list: nodes, total_turn: 0, day: 2 }), false, "第 2 天不算");
  assert.equal(isRunStart({ node_list: nodes }), false, "没有回合数时不乱猜");
  assert.equal(isRunStart({ node_list: nodes, total_turn: "" }), false);
  assert.equal(isRunStart({ node_list: [], total_turn: 0 }), false, "没有地图不算");
  assert.equal(isRunStart(null), false);
}

// 新的一局：清掉手里的导本，图鉴保留
{
  const previous = createGuidebookState();
  previous.catalogue = { 1: { statusId: 1, name: "a" } };
  previous.inventory = { 1: { statusId: 1, num: 2 } };
  previous.currentSpecialIncidentId = 4;
  const { state, changed } = resetGuidebookRun(previous);
  assert.equal(changed, true);
  assert.deepEqual(state.inventory, {});
  assert.equal(state.currentSpecialIncidentId, null);
  assert.equal(Object.keys(state.catalogue).length, 1, "图鉴不动");
  assert.equal(Object.keys(previous.inventory).length, 1, "不改动原来的状态");
  const again = resetGuidebookRun(state);
  assert.equal(again.changed, false);
  assert.equal(again.state, state);
}

console.log("dungeon action tests passed");
