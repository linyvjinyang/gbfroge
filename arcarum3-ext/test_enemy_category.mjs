import assert from "node:assert/strict";
import {
  ENEMY_CATEGORIES,
  compareWithOneTurnKills,
  enemyCategory,
  groupEnemiesByCategory,
} from "./shared/enemyCategory.js";
import { resetBattleRecord, updateBattleState } from "./shared/battle.js";

const START = "https://game.granbluefantasy.jp/rest/raid/start.json";
const ABILITY = "https://game.granbluefantasy.jp/rest/raid/ability_result.json";

// —— 类别 ——
assert.deepEqual(
  [2, 5, 3, 11, 10, 4, 1].map((type) => enemyCategory(type).name),
  ["小怪", "事件怪", "强敌", "超强敌", "特殊怪", "君临者", "Boss"],
);
assert.equal(enemyCategory("3").name, "强敌", "格子类型是字符串也认");
assert.equal(enemyCategory(null).name, "未归类");
assert.equal(enemyCategory(0).name, "未归类", "空地上不会有战斗");
assert.equal(ENEMY_CATEGORIES.length, 7);

const startJson = (raidId, name, lv, hp) => ({
  raid_id: raidId,
  is_arcarum3: true,
  turn: 1,
  boss: { param: [{ name: { ja: `Lv${lv} ${name}` }, hp: String(hp), hpmax: hp, Lv: String(lv), condition: {} }] },
  player: { param: [] },
});
const kill = (turn) => ({ status: { turn }, scenario: [{ cmd: "die", to: "boss", pos: 0 }] });

/** 进入一场战斗并在指定回合打死敌人 */
function fight(battle, raidId, nodeType, name, lv, hp, killTurn) {
  let state = updateBattleState(battle, startJson(raidId, name, lv, hp), { url: START, nodeType }).state;
  if (killTurn > 1) {
    state = updateBattleState(state, { status: { turn: killTurn }, scenario: [] }, { url: ABILITY }).state;
  }
  return updateBattleState(state, kill(killTurn + 1), { url: ABILITY }).state;
}

{
  // 本局：一回合打死 Lv50 小怪（60 万）
  let battle = fight(null, 1, 2, "ゴブリン", 50, 600_000, 1);
  assert.deepEqual(battle.record.oneTurnByType, { normal: { lv: "50", hpMax: 600_000, name: "ゴブリン" } });

  // 现在遇到 Lv90 小怪（150 万）：同类对比
  battle = updateBattleState(battle, startJson(2, "オーク", 90, 1_500_000), { url: START, nodeType: 2 }).state;
  let compare = compareWithOneTurnKills(battle, battle.bosses[0]);
  assert.equal(compare.category, "小怪");
  assert.equal(compare.lv, "90");
  assert.deepEqual(compare.reference, { lv: "50", hpMax: 600_000, name: "ゴブリン", sameCategory: true, category: "小怪" });
  assert.equal(compare.ratio, 2.5, "Lv90 小怪的血量是一回合打死过的 Lv50 小怪的 2.5 倍");

  // 第 2 回合才打死：不更新一回合记录
  battle = updateBattleState(battle, { status: { turn: 2 }, scenario: [] }, { url: ABILITY }).state;
  battle = updateBattleState(battle, kill(3), { url: ABILITY }).state;
  assert.equal(battle.record.oneTurnByType.normal.lv, "50");

  // 遇到强敌，但本局还没有一回合打死过强敌：退而用其他类里血量最大的那只来比
  battle = updateBattleState(battle, startJson(3, "オーガ", 60, 3_000_000), { url: START, nodeType: 3 }).state;
  compare = compareWithOneTurnKills(battle, battle.bosses[0]);
  assert.equal(compare.category, "强敌");
  assert.equal(compare.reference.sameCategory, false);
  assert.equal(compare.reference.category, "小怪");
  assert.equal(compare.ratio, 5);

  // 一回合打死这只强敌：强敌类有了自己的记录，小怪类不变
  battle = updateBattleState(battle, kill(2), { url: ABILITY }).state;
  assert.equal(battle.record.oneTurnByType.strong.lv, "60");
  assert.equal(battle.record.oneTurnByType.normal.lv, "50");
  assert.equal(battle.record.oneTurnHp, 3_000_000, "总的一回合最大血量照常更新");

  // 同类里取血量最大的：再打死一只更肉的小怪会顶掉，打死更脆的不会
  battle = fight(battle, 4, 2, "トロル", 70, 900_000, 1);
  assert.equal(battle.record.oneTurnByType.normal.lv, "70");
  battle = fight(battle, 5, 2, "スライム", 10, 50_000, 1);
  assert.equal(battle.record.oneTurnByType.normal.lv, "70");

  // 事件怪、超强敌、特殊怪各归各的类
  battle = fight(battle, 6, 5, "盗賊", 40, 400_000, 1);
  battle = fight(battle, 7, 11, "巨人", 120, 8_000_000, 1);
  battle = fight(battle, 8, 10, "狂信者", 80, 2_000_000, 1);
  assert.deepEqual(Object.keys(battle.record.oneTurnByType).sort(), ["event", "normal", "special", "strong", "terrifying"]);

  // 再遇到小怪：只跟小怪比，不受超强敌记录影响
  battle = updateBattleState(battle, startJson(9, "オーク", 90, 1_800_000), { url: START, nodeType: 2 }).state;
  compare = compareWithOneTurnKills(battle, battle.bosses[0]);
  assert.equal(compare.reference.lv, "70");
  assert.equal(compare.ratio, 2);

  // 血量不超过参照：ratio ≤ 1
  assert.equal(compareWithOneTurnKills(battle, { lv: "30", hpMax: 450_000 }).ratio, 0.5);

  // 开新一局（清零）：各类记录一起清掉
  const reset = resetBattleRecord(battle).state;
  assert.deepEqual(reset.record.oneTurnByType, {});
  assert.equal(compareWithOneTurnKills(reset, reset.bosses[0]).reference, null);
  assert.equal(compareWithOneTurnKills(reset, reset.bosses[0]).category, "小怪", "没有参照时照样给出归类");

  // 非肉鸽战斗：不比较
  assert.equal(compareWithOneTurnKills({ ...battle, isArcarum3: false }, battle.bosses[0]).reference, null);
  assert.equal(compareWithOneTurnKills(null, null).category, "未归类");
}

// —— 敌人记录分组：按类别，再按等级 ——
{
  const entry = (name, lv, nodeType, hpMax, oneTurnKills = 0) => ({ key: `${name}|Lv${lv}`, name, lv: String(lv), nodeType, hpMax, oneTurnKills });
  const groups = groupEnemiesByCategory([
    entry("ボス", 250, 1, 2_500_000_000),
    entry("オーク", 90, 2, 1_500_000),
    entry("ゴブリン", 50, 2, 600_000, 1),
    entry("オーガ", 60, 3, 3_000_000),
    entry("謎", "", null, 100),
    entry("スライム", 9, 2, 50_000, 2),
    entry("巨人", 120, 11, 8_000_000),
  ]);
  assert.deepEqual(groups.map((group) => group.name), ["小怪", "强敌", "超强敌", "Boss", "未归类"], "按难度顺序，未归类排最后");
  assert.deepEqual(groups[0].enemies.map((e) => e.lv), ["9", "50", "90"], "组内按等级数值从低到高（不是按字符串）");
  assert.deepEqual(groupEnemiesByCategory([]), []);
  assert.deepEqual(groupEnemiesByCategory(null), []);
}

console.log("enemy category tests passed");
