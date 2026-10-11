import assert from "node:assert/strict";
import { CAP_TABLES, applySoftCap, displayedCap, softCapValue } from "./shared/damageCap.js";
import { aggregateGuidebookEffects, readProgressPercent } from "./shared/guidebookEffects.js";
import { captureDeck, extractDeck, summarizeDeck } from "./shared/deck.js";
import {
  battleKindForUrl,
  tallyAttackInfo,
  tallyScenarioDamage,
  updateBattleState,
} from "./shared/battle.js";

// —— 上限：对照 gbf.wiki Damage Cap 的算例 ——
const NA = CAP_TABLES.attack.tiers;
assert.equal(softCapValue(NA), 445000);
assert.equal(softCapValue(CAP_TABLES.special.tiers), 1685000);
assert.equal(softCapValue(CAP_TABLES.chain2.tiers), 1160000);
assert.equal(softCapValue(CAP_TABLES.chain3.tiers), 1410000);
assert.equal(softCapValue(CAP_TABLES.chain4.tiers), 1685000);
assert.equal(applySoftCap(250000, NA), 250000, "阈值以下不衰减");
assert.equal(Math.round(applySoftCap(1e6, NA)), 449000);
assert.equal(Math.round(applySoftCap(2e6, NA)), 459000);
assert.equal(Math.round(softCapValue(NA, 0.2)), 534000);
assert.equal(Math.round(applySoftCap(1e6, NA, 0.2)), 536800);
assert.equal(Math.round(softCapValue(NA, 0.2, 0.05)), 542700);
assert.equal(Math.round(applySoftCap(1e6, NA, 0.2, 0.05)), 545640);
assert.equal(Math.round(displayedCap(NA, { capUp: 0.2, amplify: 0.5 })), 801000);

// —— 导本倍率：同词条多份加算 ——
assert.equal(readProgressPercent("…与ダメージUP(81%/最大100%)"), 0.81);
assert.equal(readProgressPercent("通常攻撃のヒット数増加(＋3/最大＋10)"), null);
{
  const inventory = {
    7: { statusId: 7, num: 2 }, // 上限 10% ×2
    1: { statusId: 1, num: 3 }, // 攻击 20% ×3
    4: { statusId: 4, num: 1 }, // 奥义伤害 20% / 奥义上限 10%
    72: { statusId: 72, num: 1 }, // 与伤 50%
    20: { statusId: 20, num: 1 }, // 通常攻击与伤 30%
    85: { statusId: 85, num: 1 }, // 成长型
    86: { statusId: 86, num: 1 }, // 成长型但读不到当前值
    34: { statusId: 34, num: 1 }, // 种族限定
    30: { statusId: 30, num: 1 }, // 与伤害无关
  };
  const catalogue = {
    85: { rawName: "…味方全体の与ダメージUP(40%/最大100%)" },
  };
  const { mods, counted, conditional, unknownProgress } = aggregateGuidebookEffects(
    inventory,
    catalogue,
  );
  assert.ok(Math.abs(mods.capAll - 0.2) < 1e-9);
  assert.ok(Math.abs(mods.atk - 0.6) < 1e-9);
  assert.ok(Math.abs(mods.capSpecial - 0.1) < 1e-9);
  assert.ok(Math.abs(mods.specialDamage - 0.2) < 1e-9);
  assert.ok(Math.abs(mods.ampAll - 0.9) < 1e-9, "50% + 成长型当前 40%");
  assert.ok(Math.abs(mods.ampAttack - 0.3) < 1e-9);
  assert.deepEqual(conditional, [34]);
  assert.deepEqual(unknownProgress, [86]);
  assert.ok(counted.includes(85) && !counted.includes(30));
}

// —— 盘子：每次读到就刷新 ——
function deckPayload(mainName = "主手剣") {
  const weapons = {};
  for (let slot = 1; slot <= 13; slot++) {
    weapons[slot] =
      slot === 12
        ? {}
        : {
            master: { id: `10400${slot}`, name: slot === 1 ? mainName : `武器${slot}`, attribute: "1", series_id: "3" },
            param: { image_id: `10400${slot}00`, level: "150" },
            skill1: { name: "攻刃", description: "火属性キャラの攻撃力上昇(大)", image: "skill_atk_1_3" },
          };
  }
  return {
    deck: {
      priority: 11,
      name: "編成1",
      pc: {
        weapons,
        summons: {
          1: { master: { id: "2040001", name: "主召喚", attribute: "1" }, param: { image_id: "2040001000", level: "200" } },
          2: {},
        },
        sub_summons: { 1: { master: { id: "2040002", name: "サブ", attribute: "1" }, param: { image_id: "2040002000" } } },
        damage_info: {
          assumed_normal_damage: 123456,
          assumed_advantage_damage: 234567,
          hp: 40000,
          effect_value_info: [{ icon_img: "cap", value: "20", is_max: true }],
          weapon_skill_enhance_param: { weapon_skill_enhance: 140, weapon_skill_enhance_magna: 0, weapon_skill_enhance_evil: 0 },
        },
        after_damage_info: {},
      },
      npc: { 1: { master: { id: "3040001", name: "キャラ", attribute: 1 }, param: { image_id_3: "3040001000_01" } } },
    },
  };
}
{
  assert.equal(extractDeck({}), null);
  assert.equal(extractDeck({ deck: { pc: { weapons: {} } } }), null);

  const first = captureDeck(null, deckPayload(), {
    now: 1000,
    url: "https://game.granbluefantasy.jp/party/deck/1/1?_=1",
  });
  assert.ok(first.changed);
  const deck = first.state.deck;
  assert.equal(deck.weapons.length, 13);
  assert.equal(deck.weapons[11], null, "空栏位保留为 null，槽位序号不乱");
  assert.equal(deck.weapons[0].name, "主手剣");
  assert.equal(deck.weapons[0].skills[0].description, "火属性キャラの攻撃力上昇(大)");
  assert.equal(deck.summons.length, 2);
  assert.equal(deck.summons[1].slot, 6, "副召唤石排在主栏 5 格之后");
  assert.equal(deck.characters[0].name, "キャラ");
  assert.equal(deck.damageInfo.normalDamage, 123456);
  assert.equal(deck.damageInfo.enhance.normal, 140);
  assert.equal(first.state.capturedAt, 1000);
  assert.equal(first.state.source, "/party/deck/1/1");
  assert.deepEqual(summarizeDeck(first.state), { total: 12, summons: 2 });

  const second = captureDeck(first.state, deckPayload("別の編成"), { now: 2000 });
  assert.ok(second.changed, "每次读到都刷新为最新的盘子");
  assert.equal(second.state.deck.weapons[0].name, "別の編成");
  assert.equal(second.state.capturedAt, 2000);

  const unrelated = captureDeck(second.state, { option: { dungeon: { node_list: [] } } }, { now: 3000 });
  assert.equal(unrelated.changed, false, "不含盘子的响应不能清掉已有盘子");
  assert.equal(unrelated.state.deck.weapons[0].name, "別の編成");

  // 肉鸽接口的包装层级不确定：只要某层带 pc.weapons 就能识别
  const nested = extractDeck({ option: { party: deckPayload("肉鸽主手").deck } });
  assert.equal(nested.weapons[0].name, "肉鸽主手");
  const bare = extractDeck(deckPayload("裸 deck").deck);
  assert.equal(bare.weapons[0].name, "裸 deck");

  // after_damage_info 有内容时优先（游戏在变更编成后给出的新数值）
  const changed = deckPayload();
  changed.deck.pc.after_damage_info = { assumed_normal_damage: 99, effect_value_info: [] };
  assert.equal(extractDeck(changed).damageInfo.normalDamage, 99);
}

// —— 战斗：血量、状态、实测伤害 ——
const START_URL = "https://game.granbluefantasy.jp/rest/raid/start.json?_=1";
const ATTACK_URL = "https://game.granbluefantasy.jp/rest/raid/normal_attack_result.json?_=2";
const ABILITY_URL = "https://game.granbluefantasy.jp/rest/multiraid/ability_result.json?_=3";
assert.equal(battleKindForUrl(START_URL), "start");
assert.equal(battleKindForUrl(ATTACK_URL), "attack");
assert.equal(battleKindForUrl(ABILITY_URL), "ability");
assert.equal(battleKindForUrl("https://game.granbluefantasy.jp/rest/arcarum3/dungeon/move_node"), null);
assert.equal(battleKindForUrl("https://game.granbluefantasy.jp/rest/raid/setting"), null);

const startJson = {
  raid_id: 777,
  quest_id: "900001",
  is_arcarum3: true,
  turn: 1,
  boss: {
    param: [
      { name: { ja: "敵A", en: "Foe A" }, hp: "1000000", hpmax: 1000000, Lv: "100", attr: "2", condition: { buff: [{ status: "1001", detail: "攻撃UP" }] } },
      { name: { ja: "敵B", en: "Foe B" }, hp: "500000", hpmax: 500000, Lv: "100", attr: "2", condition: {} },
    ],
  },
  player: {
    param: [
      { name: "主人公", hp: 20000, hpmax: 30000, attr: "1", alive: 1, condition: { buff: [{ status: "1383", detail: "攻撃力UP" }], debuff: [{ status: "1019", detail: "毒", remain: 3 }] } },
    ],
  },
};
{
  const none = updateBattleState(null, { scenario: [] }, { url: ATTACK_URL });
  assert.equal(none.changed, false, "没有 start 时忽略行动结果");

  const started = updateBattleState(null, startJson, { url: START_URL, now: 10 });
  assert.ok(started.changed);
  let battle = started.state;
  assert.equal(battle.raidId, "777");
  assert.ok(battle.isArcarum3);
  assert.equal(battle.bosses.length, 2);
  assert.equal(battle.bosses[0].name, "敵A");
  assert.equal(battle.bosses[0].hp, 1000000);
  assert.equal(battle.bosses[0].conditions[0].status, "1001");
  assert.equal(battle.players[0].conditions.length, 2);
  assert.ok(battle.players[0].conditions[1].isDebuff);
  assert.equal(battle.lastAction, null);

  const attackJson = {
    status: { turn: 2 },
    scenario: [
      { cmd: "attack", from: "player", pos: 0, damage: { 1: [{ value: 400000, hp: 600000 }], 2: [{ value: 445000 }, { value: 0 }] } },
      { cmd: "special", pos: 0, list: [{ damage: [{ value: 1600000 }] }] },
      { cmd: "damage", to: "boss", list: [{ value: 90000 }, { value: 120000 }] },
      { cmd: "loop_damage", to: "boss", list: [[{ value: 30000 }], [{ value: 31000 }]] },
      { cmd: "damage", to: "player", list: [{ value: 9999, pos: 0 }] },
      { cmd: "attack", from: "boss", damage: [[{ value: 5000, pos: 0 }]] },
      { cmd: "boss_gauge", pos: 0, hp: 250000, hpmax: 1000000, name: { ja: "敵A" } },
      { cmd: "die", to: "boss", pos: 1 },
      { cmd: "condition", to: "boss", pos: 0, condition: { debuff: [{ status: "1003", detail: "防御DOWN" }] } },
      { cmd: "condition", to: "player", pos: 0, condition: { buff: [{ status: "1383" }] } },
    ],
  };
  const tally = tallyScenarioDamage(attackJson.scenario);
  assert.deepEqual(tally.attack, { hits: 2, total: 845000, max: 445000 }, "0 伤害不计入命中");
  assert.deepEqual(tally.special, { hits: 1, total: 1600000, max: 1600000 });
  assert.deepEqual(tally.other, { hits: 4, total: 271000, max: 120000 });

  ({ state: battle } = updateBattleState(battle, attackJson, { url: ATTACK_URL, now: 20 }));
  assert.equal(battle.turn, 2);
  assert.equal(battle.bosses[0].hp, 250000);
  assert.equal(battle.bosses[1].hp, 0);
  assert.equal(battle.bosses[1].alive, false);
  assert.equal(battle.bosses[0].conditions[0].status, "1003");
  assert.equal(battle.players[0].conditions.length, 1);
  assert.equal(battle.lastAction.kind, "attack");
  assert.equal(battle.lastAction.turn, 1, "记录的是行动发生时的回合");
  assert.equal(battle.lastAction.total, 845000 + 1600000 + 271000);
  assert.deepEqual(battle.best, { attack: 445000, special: 1600000, other: 120000 });

  const weak = { scenario: [{ cmd: "damage", to: "boss", list: [{ value: 50000 }] }], status: { turn: 2 } };
  ({ state: battle } = updateBattleState(battle, weak, { url: ABILITY_URL, now: 30 }));
  assert.equal(battle.lastAction.kind, "ability");
  assert.equal(battle.best.other, 120000, "本场最高单发不被较低的值覆盖");

  const noDamage = { scenario: [{ cmd: "condition", to: "player", pos: 0, condition: {} }], status: { turn: 2 } };
  const kept = updateBattleState(battle, noDamage, { url: ABILITY_URL, now: 40 });
  assert.equal(kept.state.lastAction.kind, "ability", "无伤害的行动不清掉上一次实测");
  assert.equal(kept.state.players[0].conditions.length, 0);

  const reloaded = updateBattleState(battle, startJson, { url: START_URL, now: 50 });
  assert.deepEqual(reloaded.state.best, battle.best, "同一场战斗刷新页面后保留实测记录");
  const next = updateBattleState(battle, { ...startJson, raid_id: 778 }, { url: START_URL, now: 60 });
  assert.deepEqual(next.state.best, { attack: 0, special: 0, other: 0 }, "新战斗重新统计");
  assert.equal(next.state.lastAction, null);
}

// —— 按攻击后的 hit 数（口径照 Tarou） ——
{
  const scenario = [
    // 两个角色的通常攻击：三连 + 单发，其中一发 0 伤害（被回避）不算
    { cmd: "attack", from: "player", damage: { 1: [{ value: 100 }], 2: [{ value: 110 }], 3: [{ value: 120 }] } },
    { cmd: "attack", from: "player", damage: [[{ value: 200 }, { value: 0 }]] },
    // 奥义：伤害条目 1 条，但画面上跳 3 个数字（total 里有一条是 0，不算）
    {
      cmd: "special",
      list: [{ damage: [{ value: 5000 }] }],
      total: [{ split: ["5", "0", "0", "0"] }, { split: ["1"] }, { split: ["2"] }, { split: ["0"] }],
    },
    // 没有 total 的奥义：按伤害条目数
    { cmd: "special_npc", list: [{ damage: [{ value: 3000 }, { value: 3000 }] }] },
    // 只有演出、没有 list 的 special 不算连锁
    { cmd: "special", kind: "cutin" },
    // 技能 / 追加伤害
    { cmd: "damage", to: "boss", list: [{ value: 400 }, { value: 0 }] },
    { cmd: "loop_damage", to: "boss", list: [[{ value: 10 }, { value: 10 }], [{ value: 10 }]] },
    // 打在我方身上的不算
    { cmd: "damage", to: "player", list: [{ value: 999 }] },
    // 敌人行动之后的都不算
    { cmd: "turn", mode: "boss" },
    { cmd: "attack", from: "player", damage: [[{ value: 77777 }]] },
    { cmd: "damage", to: "boss", list: [{ value: 88888 }] },
  ];
  const info = tallyAttackInfo(scenario);
  assert.deepEqual(info, {
    hit: 4 + 3 + 2 + 1 + 3,
    chain: 2,
    attack: 530,
    special: 11000,
    ability: 430,
    total: 11960,
  });
  assert.deepEqual(tallyAttackInfo(null), { hit: 0, chain: 0, attack: 0, special: 0, ability: 0, total: 0 });

  // 只有按攻击才更新；用技能不动它；换一场战斗清空
  const START = "https://game.granbluefantasy.jp/rest/raid/start.json";
  const ATTACK = "https://game.granbluefantasy.jp/rest/raid/normal_attack_result.json";
  const ABILITY = "https://game.granbluefantasy.jp/rest/raid/ability_result.json";
  const start = (raidId) => ({
    raid_id: raidId,
    is_arcarum3: true,
    turn: 1,
    boss: { param: [{ name: { ja: "敵" }, hp: "9999999", hpmax: 9999999, condition: {} }] },
    player: { param: [] },
  });
  let { state: battle } = updateBattleState(null, start(1), { url: START });
  assert.equal(battle.lastAttack, null);
  ({ state: battle } = updateBattleState(battle, { status: { turn: 1 }, scenario: [{ cmd: "damage", to: "boss", list: [{ value: 5 }] }] }, { url: ABILITY }));
  assert.equal(battle.lastAttack, null, "用技能不算按攻击");
  ({ state: battle } = updateBattleState(battle, { status: { turn: 2 }, scenario }, { url: ATTACK, now: 7 }));
  assert.equal(battle.lastAttack.hit, 13);
  assert.equal(battle.lastAttack.chain, 2);
  assert.equal(battle.lastAttack.turn, 1, "记的是按下攻击时的回合");
  ({ state: battle } = updateBattleState(battle, { status: { turn: 2 }, scenario: [{ cmd: "damage", to: "boss", list: [{ value: 5 }] }] }, { url: ABILITY }));
  assert.equal(battle.lastAttack.hit, 13, "之后用技能不覆盖");
  ({ state: battle } = updateBattleState(battle, start(1), { url: START }));
  assert.equal(battle.lastAttack.hit, 13, "同一场战斗刷新页面后保留");
  ({ state: battle } = updateBattleState(battle, start(2), { url: START }));
  assert.equal(battle.lastAttack, null, "新战斗清空");
}

console.log("build data tests passed");
