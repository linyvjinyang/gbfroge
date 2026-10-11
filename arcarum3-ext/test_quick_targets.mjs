import assert from "node:assert/strict";
import {
  defaultOpeningTarget,
  findNearestNode,
  hopDistances,
  listSpecialIncidents,
  quickTarget,
} from "./shared/path/quickTargets.js";
import {
  isRecordedBattle,
  predictKill,
  resetBattleRecord,
  updateBattleState,
} from "./shared/battle.js";

/**
 * 一条链 1-2-3-4-5-6-7，外加支路 3-8、5-9。
 *   2 君临者，4 特殊(温泉 12，已访问)，6 特殊(研究者 8)，7 君临者，
 *   8 特殊(洞窟 16)，9 Boss；传送口 10、11 挂在 1 上。
 */
function makeState(overrides = {}) {
  const node = (id, type, adjacent, extra = {}) => ({
    node_id: id,
    node_type: type,
    adjacent_node_ids: adjacent,
    position_x: id * 100,
    position_y: 100,
    is_visited: false,
    special_incident_id: null,
    ...extra,
  });
  const node_list = [
    node(1, 0, [2, 10, 11]),
    node(2, 4, [1, 3]),
    node(3, 0, [2, 4, 8]),
    node(4, 10, [3, 5], { special_incident_id: 12, is_visited: true }),
    node(5, 0, [4, 6, 9]),
    node(6, 10, [5, 7], { special_incident_id: 8 }),
    node(7, 4, [6]),
    node(8, 10, [3], { special_incident_id: 16 }),
    node(9, 1, [5]),
    node(10, 10, [1], { special_incident_id: 5 }),
    node(11, 10, [1], { special_incident_id: 6 }),
  ];
  return { current_node_id: 1, node_list, ...overrides };
}

// —— 步数 ——
{
  const dist = hopDistances(makeState());
  assert.equal(dist.get(1), 0);
  assert.equal(dist.get(6), 5);
  assert.equal(dist.get(8), 3);
  assert.equal(dist.get(9), 5, "Boss 可以作为终点到达");

  // Boss 挡在路中间时不能穿过去
  const blocked = makeState();
  blocked.node_list.find((n) => n.node_id === 5).node_type = 1;
  const blockedDist = hopDistances(blocked);
  assert.equal(blockedDist.get(5), 4);
  assert.equal(blockedDist.has(6), false, "不能穿过 Boss 去更远的节点");
}

// —— 本局特殊事件 ——
{
  const list = listSpecialIncidents(makeState());
  assert.deepEqual(
    list.map((item) => [item.name, item.nodeId, item.visited]),
    [
      ["浮空城研究者", 6, false],
      ["温泉", 4, true],
      ["洞窟", 8, false],
      ["浮空城传送口", 10, false],
    ],
    "研究者排最前，传送口合并成一项",
  );
  assert.deepEqual(list.at(-1).nodeIds, [10, 11]);
  assert.deepEqual(listSpecialIncidents(null), []);
}

// —— 快捷目标 ——
{
  const state = makeState();
  assert.deepEqual(quickTarget(state, "researcher"), { nodeId: 6, hops: 5 });
  assert.deepEqual(quickTarget(state, "boss"), { nodeId: 9, hops: 5 });
  assert.deepEqual(quickTarget(state, "ruler"), { nodeId: 2, hops: 1 }, "两个君临者取近的");
  assert.deepEqual(
    quickTarget(state, "special"),
    { nodeId: 8, hops: 3 },
    "最近特殊：跳过已访问的温泉和传送口",
  );

  // 站在君临者上时，找的是另一个
  assert.deepEqual(quickTarget(makeState({ current_node_id: 2 }), "ruler"), { nodeId: 7, hops: 5 });

  const noBoss = makeState();
  noBoss.node_list = noBoss.node_list.filter((n) => n.node_id !== 9);
  assert.equal(quickTarget(noBoss, "boss").nodeId, null);
  assert.match(quickTarget(noBoss, "boss").reason, /Boss 还没出现/);

  const visited = makeState();
  visited.node_list.find((n) => n.node_id === 6).is_visited = true;
  assert.equal(quickTarget(visited, "researcher").nodeId, null);

  assert.equal(quickTarget(makeState({ current_node_id: null }), "ruler").nodeId, null);
  assert.equal(
    findNearestNode(state, (n) => n.node_id === 1),
    null,
    "当前位置自己不算目标",
  );
}

// —— 开局默认目标：研究者第一优先 ——
{
  const state = makeState();
  assert.equal(defaultOpeningTarget(state), 6);
  assert.equal(defaultOpeningTarget(state, { dismissedNodeId: 6 }), null, "玩家清掉后不再自动设回");
  assert.equal(defaultOpeningTarget(state, { dismissedNodeId: 99 }), 6);
  const none = makeState();
  none.node_list = none.node_list.filter((n) => n.node_id !== 6);
  assert.equal(defaultOpeningTarget(none), null);
}

// —— 平A记录（只记普通战斗格）+ 击杀预测 ——
const START = "https://game.granbluefantasy.jp/rest/raid/start.json";
const ATTACK = "https://game.granbluefantasy.jp/rest/raid/normal_attack_result.json";
const ABILITY = "https://game.granbluefantasy.jp/rest/raid/ability_result.json";
const startJson = (raidId, hp, isArcarum3 = true) => ({
  raid_id: raidId,
  is_arcarum3: isArcarum3,
  turn: 1,
  boss: {
    param: [
      { name: { ja: "敵A" }, hp: String(hp), hpmax: hp, condition: {} },
      { name: { ja: "敵B" }, hp: "400000", hpmax: 400000, condition: {} },
    ],
  },
  player: { param: [] },
});
/** 一次攻击：平A若干下 + 一发奥义 + 一段追加伤害 */
const attackJson = (hits, bossHp, special = 0) => ({
  status: { turn: 2 },
  scenario: [
    { cmd: "attack", from: "player", damage: [hits.map((value) => ({ value }))] },
    ...(special ? [{ cmd: "special", list: [{ damage: [{ value: special }] }] }] : []),
    { cmd: "damage", to: "boss", list: [{ value: 50000 }] },
    { cmd: "boss_gauge", pos: 0, hp: bossHp },
  ],
});
const NORMAL = { url: START, nodeType: 2 };
{
  let { state: battle } = updateBattleState(null, startJson(1, 2_000_000), NORMAL);
  assert.equal(battle.nodeType, 2);
  assert.ok(isRecordedBattle(battle));
  let prediction = predictKill(battle);
  assert.equal(prediction.reference, 0);
  assert.equal(prediction.enemies[0].turns, null, "没有平A记录时不给预测");
  assert.equal(prediction.totalHp, 2_400_000);

  // 技能伤害不算平A
  ({ state: battle } = updateBattleState(
    battle,
    { status: { turn: 1 }, scenario: [{ cmd: "damage", to: "boss", list: [{ value: 900000 }] }] },
    { url: ABILITY },
  ));
  assert.equal(battle.record.attackTurn, 0);

  // 按下攻击后的全部伤害都算：平A 30 万 ×2 + 追加 5 万 = 65 万
  ({ state: battle } = updateBattleState(battle, attackJson([300000, 300000], 1_100_000), { url: ATTACK }));
  assert.equal(battle.record.attackTurn, 650000, "通常攻击和这一回合的追加伤害都计入");
  ({ state: battle } = updateBattleState(battle, attackJson([200000], 900_000), { url: ATTACK }));
  assert.equal(battle.record.attackTurn, 650000, "较低的回合不覆盖记录");

  // 已经打到第 2 回合：不再预测
  assert.equal(battle.turn, 2);
  prediction = predictKill(battle);
  assert.equal(prediction.active, false, "过了第 1 回合，预测血量和伤害没有意义");
  assert.equal(prediction.reference, 0);
  assert.deepEqual(prediction.enemies.map((e) => [e.damage, e.kill, e.turns]), [[0, false, null], [0, false, null]]);
  assert.equal(battle.record.attackTurn, 650000, "记录本身不受影响");

  // 第 1 回合：逐个敌人对比血条，能打掉多少、打完剩多少、能不能击杀
  prediction = predictKill({ ...battle, turn: 1 });
  assert.equal(prediction.active, true);
  assert.equal(prediction.reference, 650000);
  assert.deepEqual(
    prediction.enemies.map((e) => [e.name, e.hp, e.damage, e.hpAfter, e.kill, e.turns]),
    [
      ["敵A", 900000, 650000, 250000, false, 2],
      ["敵B", 400000, 400000, 0, true, 1],
    ],
    "打掉的血量不超过敌人的剩余血量",
  );
  assert.equal(prediction.totalTurns, 2, "合计 130 万 / 65 万 → 2 回合");

  // 带奥义的回合：奥义伤害也计入
  ({ state: battle } = updateBattleState(battle, attackJson([300000], 600_000, 1_500_000), { url: ATTACK }));
  assert.equal(battle.record.attackTurn, 1_850_000, "平A 30 万 + 奥义 150 万 + 追加 5 万");
  ({ state: battle } = resetBattleRecord(battle));
  ({ state: battle } = updateBattleState(battle, attackJson([300000, 300000], 900_000), { url: ATTACK }));
  assert.equal(battle.record.attackTurn, 650000);

  // 事件敌人、强敌、Boss 等任何肉鸽战斗都计入：检测到敌人就行
  let expected = 650000;
  for (const nodeType of [1, 3, 11, 5, 4, 10, null]) {
    ({ state: battle } = updateBattleState(battle, startJson(100 + (nodeType ?? 0), 500_000), { url: START, nodeType }));
    assert.equal(isRecordedBattle(battle), true);
    assert.equal(battle.record.attackTurn, expected, "记录跨战斗保留");
    assert.equal(predictKill(battle).enemies[0].kill, true, "50 万血，一回合可击杀");
    expected += 100000;
    ({ state: battle } = updateBattleState(battle, attackJson([expected - 50000], 1), { url: ATTACK }));
    assert.equal(battle.record.attackTurn, expected, `格子类型 ${nodeType} 的战斗也计入记录`);
  }

  // 刷新页面重新收到同一场战斗的 start：格子类型不丢
  ({ state: battle } = updateBattleState(battle, startJson(200, 500_000), NORMAL));
  ({ state: battle } = updateBattleState(battle, startJson(200, 500_000), { url: START }));
  assert.equal(battle.nodeType, 2);

  // 非肉鸽战斗：不写记录，也不给预测
  ({ state: battle } = updateBattleState(battle, startJson(300, 500_000, false), NORMAL));
  assert.equal(isRecordedBattle(battle), false);
  assert.equal(predictKill(battle).reference, 0);
  ({ state: battle } = updateBattleState(battle, attackJson([9999999], 1), { url: ATTACK }));
  assert.equal(battle.record.attackTurn, expected);

  // 击杀后不再列出
  const dead = structuredClone(battle);
  dead.bosses.forEach((boss) => { boss.hp = 0; boss.alive = false; });
  assert.deepEqual(predictKill(dead).enemies, []);
  assert.equal(predictKill(dead).totalTurns, null);

  const reset = resetBattleRecord(battle);
  assert.ok(reset.changed);
  assert.equal(reset.state.record.attackTurn, 0);
  assert.equal(reset.state.bosses.length, 2, "清零只动记录，不动战斗状态");
  assert.equal(resetBattleRecord(null).changed, false);
  assert.equal(predictKill(null).totalTurns, null);
}

console.log("quick targets & kill prediction tests passed");
