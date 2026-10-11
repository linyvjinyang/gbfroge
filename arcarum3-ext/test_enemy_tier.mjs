import assert from "node:assert/strict";
import {
  TIER_YELLOW_RATIO,
  enemyTier,
  resetBattleRecord,
  splitEnemyName,
  updateBattleState,
} from "./shared/battle.js";
import { enemyKey } from "./shared/enemyLog.js";

const START = "https://game.granbluefantasy.jp/rest/raid/start.json";
const ATTACK = "https://game.granbluefantasy.jp/rest/raid/normal_attack_result.json";
const ABILITY = "https://game.granbluefantasy.jp/rest/raid/ability_result.json";

// —— 名字里自带的等级前缀 ——
assert.deepEqual(splitEnemyName("Lv250 ラスケィド＆ヒューレ", "250"), { name: "ラスケィド＆ヒューレ", lv: "250" });
assert.deepEqual(splitEnemyName("Lv30 ゴブリン", null), { name: "ゴブリン", lv: "30" }, "没有单独的等级字段时从名字里取");
assert.deepEqual(splitEnemyName("Lv.120 Infernobringer", ""), { name: "Infernobringer", lv: "120" });
assert.deepEqual(splitEnemyName("ゴブリン", "30"), { name: "ゴブリン", lv: "30" });
assert.deepEqual(splitEnemyName("Lvアップの精霊", "5"), { name: "Lvアップの精霊", lv: "5" }, "不是等级前缀的不动");
assert.deepEqual(splitEnemyName("", null), { name: "", lv: "" });

const startJson = (raidId, enemies, isArcarum3 = true) => ({
  raid_id: raidId,
  is_arcarum3: isArcarum3,
  turn: 1,
  boss: {
    param: enemies.map(([name, hp]) => ({
      name: { ja: name, en: name },
      hp: String(hp),
      hpmax: hp,
      Lv: "30",
      condition: {},
    })),
  },
  player: { param: [] },
});
/** 一次行动：把 pos 位的敌人血量改成 hp（0 = 打死） */
const result = (turn, changes) => ({
  status: { turn },
  scenario: [
    { cmd: "damage", to: "boss", list: [{ value: 1000 }] },
    ...changes.map(([pos, hp]) => ({ cmd: "boss_gauge", pos, hp })),
  ],
});

{
  // 游戏原始名字带「Lv30 」前缀：拆开后显示和记录都不重复等级
  let { state: battle } = updateBattleState(null, startJson(1, [["Lv30 ゴブリン", 500_000]]), { url: START, nodeType: 5 });
  assert.equal(battle.bosses[0].name, "ゴブリン");
  assert.equal(battle.bosses[0].nameEn, "ゴブリン");
  assert.equal(battle.bosses[0].lv, "30");
  assert.equal(enemyKey(battle.bosses[0]), "ゴブリン|Lv30");

  // 本局还没有一回合击杀：没法比
  assert.deepEqual(enemyTier(battle, battle.bosses[0]), { tier: "unknown", ratio: null, reference: 0 });

  // 第 1 回合用技能打死（事件战斗）：记下它的血量
  ({ state: battle } = updateBattleState(battle, result(1, [[0, 0]]), { url: ABILITY }));
  assert.equal(battle.record.oneTurnHp, 500_000, "事件里的敌人也算；不限定是攻击打死的");

  // 下一场：三个敌人，血量分别是记录的 0.8 / 2.5 / 8 倍
  ({ state: battle } = updateBattleState(
    battle,
    startJson(2, [["小怪", 400_000], ["强敌", 1_250_000], ["首领", 4_000_000]]),
    { url: START, nodeType: 3 },
  ));
  assert.equal(battle.record.oneTurnHp, 500_000, "本局记录跨战斗保留");
  const tiers = battle.bosses.map((boss) => enemyTier(battle, boss));
  assert.deepEqual(tiers.map((t) => t.tier), ["green", "yellow", "red"]);
  assert.deepEqual(tiers.map((t) => t.ratio), [0.8, 2.5, 8]);

  // 边界：刚好 1 倍算绿，刚好 3 倍算黄
  assert.equal(enemyTier(battle, { hpMax: 500_000 }).tier, "green");
  assert.equal(enemyTier(battle, { hpMax: 500_000 * TIER_YELLOW_RATIO }).tier, "yellow");
  assert.equal(enemyTier(battle, { hpMax: 500_000 * TIER_YELLOW_RATIO + 1 }).tier, "red");
  // 同名敌人因为难度 / 局外加成血量变了：只看倍率，不认名字
  assert.equal(enemyTier(battle, { name: "ゴブリン", hpMax: 2_000_000 }).tier, "red");

  // 第 1 回合打死小怪：比记录小，不降低记录
  ({ state: battle } = updateBattleState(battle, result(1, [[0, 0]]), { url: ATTACK }));
  assert.equal(battle.record.oneTurnHp, 500_000);
  // 同一回合再打死强敌：记录提高到 125 万，首领从红变黄
  ({ state: battle } = updateBattleState(battle, result(2, [[1, 0]]), { url: ABILITY }));
  assert.equal(battle.record.oneTurnHp, 1_250_000);
  assert.equal(enemyTier(battle, battle.bosses[2]).tier, "red", "400 万 / 125 万 = 3.2 倍，仍是红");
  assert.ok(Math.abs(enemyTier(battle, battle.bosses[2]).ratio - 3.2) < 1e-9);
  // 第 2 回合才打死首领：不算一回合击杀
  ({ state: battle } = updateBattleState(battle, result(3, [[2, 0]]), { url: ATTACK }));
  assert.equal(battle.record.oneTurnHp, 1_250_000, "第 2 回合打死的不计入");

  // 只有死亡事件、没有伤害数字的行动也要算
  ({ state: battle } = updateBattleState(battle, startJson(3, [["脆皮", 3_000_000]]), { url: START }));
  ({ state: battle } = updateBattleState(
    battle,
    { status: { turn: 1 }, scenario: [{ cmd: "die", to: "boss", pos: 0 }] },
    { url: ABILITY },
  ));
  assert.equal(battle.record.oneTurnHp, 3_000_000);

  // 非肉鸽战斗：不写入、也不拿来比
  ({ state: battle } = updateBattleState(battle, startJson(4, [["野外怪", 99_000_000]], false), { url: START }));
  assert.equal(enemyTier(battle, battle.bosses[0]).tier, "unknown");
  ({ state: battle } = updateBattleState(battle, result(1, [[0, 0]]), { url: ATTACK }));
  assert.equal(battle.record.oneTurnHp, 3_000_000);

  // 清零（开新一局）：一回合记录也清掉
  const reset = resetBattleRecord(battle);
  assert.ok(reset.changed);
  assert.equal(reset.state.record.oneTurnHp, 0);
  assert.equal(reset.state.record.attackTurn, 0);
}

console.log("enemy tier tests passed");
