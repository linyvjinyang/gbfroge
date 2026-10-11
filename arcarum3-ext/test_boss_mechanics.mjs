import assert from "node:assert/strict";
import {
  BOSS_GUIDES,
  battleStatusNotes,
  bossStatusNotes,
  findBossGuide,
  statusLogEntries,
} from "./shared/bossMechanics.js";
import { updateBattleState } from "./shared/battle.js";
import { listOmenLog, recordOmens } from "./shared/omens.js";

const buff = (detail, status = "9001") => ({ status, detail, isDebuff: false, remain: null });
const debuff = (detail, status = "9002") => ({ status, detail, isDebuff: true, remain: 3 });

// —— 速查：按英文名匹配四个 Boss ——
assert.equal(findBossGuide({ name: "禍門", nameEn: "Bane's Gate" }).id, "banes-gate");
assert.equal(findBossGuide({ name: "x", nameEn: "Infernobringer" }).id, "infernobringer");
assert.equal(findBossGuide({ name: "x", nameEn: "Beast of Anathema" }).id, "beast-of-anathema");
assert.equal(findBossGuide({ name: "x", nameEn: "Raskeid & Hewle" }).id, "raskeid-hewle");
assert.equal(findBossGuide({ name: "ゴブリン", nameEn: "Goblin" }), null);
assert.equal(findBossGuide(null), null);
for (const guide of BOSS_GUIDES) {
  assert.ok(guide.passive.length >= 2, `${guide.id} 要有被动规则`);
  assert.ok(guide.omens.every((omen) => omen.name && omen.cancel), `${guide.id} 的预兆都要有解除条件`);
}
const finalBoss = BOSS_GUIDES.find((guide) => guide.id === "raskeid-hewle");
assert.equal(finalBoss.destinies.length, 3, "最终 Boss 有三种隐藏命运");
assert.match(finalBoss.destinies[2].remove, /300 万无属性伤害/);
assert.match(BOSS_GUIDES.find((g) => g.id === "infernobringer").passive[0], /没人放奥义/);

// —— 第二天 Boss 的规则类状态：原文列出，不算紧急提示 ——
{
  const boss = {
    name: "インフェルノブリンガー",
    nameEn: "Infernobringer",
    conditions: [
      buff("味方が奥義を発動しなかったターン終了時、自分の憤炎Lvが1上昇/味方全体のアビリティダメージDOWN"),
      buff("攻撃UP"), // 普通增益，太短，不算规则
      debuff("敵が奥義を発動しなかったターン終了時に何かが起きる長い弱体説明"), // 我方上的弱体不算
      buff("味方が奥義を発動しなかったターン終了時、自分の憤炎Lvが1上昇/味方全体のアビリティダメージDOWN", "9009"),
    ],
  };
  const notes = bossStatusNotes(boss);
  assert.equal(notes.length, 1, "同一段说明只列一次");
  assert.match(notes[0].text, /憤炎Lv/);
  assert.equal(notes[0].alert, false);
  assert.equal(notes[0].title, "");
}

// —— 最终 Boss 的三种命运：认出来并给出解除条件 ——
{
  const boss = {
    name: "ラスケイド＆ヒューレ",
    nameEn: "Raskeid & Hewle",
    conditions: [
      buff("ターン終了時に敵のHPが回復 ◆無属性ダメージを3000000与えると解除", "1"),
      buff("ターン終了時にアビリティ使用間隔が変化 ◆強化効果を無効化する効果を3回使用で解除", "2"),
      buff("ターン終了時に最大HPの50%の無属性ダメージ ◆5回攻撃行動を行うと解除", "3"),
      buff("攻撃UP", "4"),
    ],
  };
  const notes = bossStatusNotes(boss);
  assert.deepEqual(notes.map((note) => note.title), ["回归命运", "衰弱命运", "毁灭命运"]);
  assert.ok(notes.every((note) => note.alert));
  assert.match(notes[0].hint, /解除：造成 300 万无属性伤害/);
  assert.match(notes[1].hint, /解除：1 回合内使用 3 次消除强化效果/);
  assert.match(notes[2].hint, /解除：攻击 5 次/);

  // 英文客户端的说明也能认
  const english = bossStatusNotes({
    nameEn: "Raskeid & Hewle",
    conditions: [buff("Restores foe HP at end of turn (Removed upon dealing 3,000,000 plain DMG)")],
  });
  assert.equal(english[0].title, "回归命运");

  // 同样的文字出现在别的敌人身上：不套用最终 Boss 的命名，但带「解除」仍然提示
  const other = bossStatusNotes({ nameEn: "Goblin", conditions: boss.conditions });
  assert.ok(other.every((note) => note.title === "" && note.alert));

  // 认不出是哪种、但说明里写了解除方式的状态：照样提示并显示原文
  const unknown = bossStatusNotes({
    nameEn: "Raskeid & Hewle",
    conditions: [buff("謎の効果 ◆条件達成で解除")],
  });
  assert.equal(unknown.length, 1);
  assert.ok(unknown[0].alert);
  assert.equal(unknown[0].title, "");

  // 游戏里的真实原文（玩家截图）：衰弱命运
  const REAL_DEBILITATING =
    "ターン終了時、この効果を消費して味方全体のアビリティの使用間隔を3ターン延長する状態" +
    "(消去不可/1ターンに強化効果を無効化する効果を3回与えると解除)";
  const real = bossStatusNotes({ nameEn: "Raskeid & Hewle", conditions: [buff(REAL_DEBILITATING)] });
  assert.equal(real.length, 1);
  assert.equal(real[0].title, "衰弱命运");
  assert.ok(real[0].alert);
  assert.match(real[0].hint, /技能使用间隔延长 3 回合。解除：1 回合内使用 3 次消除强化效果/);

  // 游戏把它放在弱体列表里、或者挂在我方身上，也一样要认出来
  const asDebuff = bossStatusNotes({ nameEn: "Raskeid & Hewle", conditions: [debuff(REAL_DEBILITATING)] });
  assert.equal(asDebuff[0]?.title, "衰弱命运");
  const battle = {
    bosses: [{ name: "ラスケイド", nameEn: "Raskeid & Hewle", alive: true, conditions: [buff("攻撃UP")] }],
    players: [
      { name: "主人公", conditions: [debuff(REAL_DEBILITATING), debuff("防御DOWN"), buff("長い長い長い自分の強化効果の説明文です")] },
      { name: "カイム", conditions: [debuff(REAL_DEBILITATING)] },
    ],
  };
  const fromPlayers = battleStatusNotes(battle);
  assert.deepEqual(fromPlayers.map((note) => note.title), ["衰弱命运"], "我方身上只取带解除方式的，且不重复");
  assert.equal(statusLogEntries(battle).length, 1);
  // 已击败的敌人不再算
  assert.deepEqual(
    battleStatusNotes({ bosses: [{ ...boss, alive: false }], players: [] }),
    [],
  );

  // 写入记录：kind 区分状态与预兆
  const entries = statusLogEntries({ bosses: [{ ...boss, alive: true }], players: [] });
  assert.equal(entries.length, 3);
  assert.ok(entries.every((entry) => entry.kind === "status" && entry.key.startsWith("status|")));
  const omen = { name: "", conditions: ["スキルを8回使用"], key: "|スキルを8回使用", fields: [] };
  const { log, newKeys } = recordOmens(null, {
    bossName: boss.name,
    nodeType: 1,
    day: 2,
    omens: [omen, ...entries],
    now: 5,
  });
  assert.equal(newKeys.length, 4);
  const [logged] = listOmenLog(log);
  assert.deepEqual(logged.omens.map((item) => item.kind), ["omen", "status", "status", "status"]);
  assert.equal(logged.omens[1].name, "回归命运");
}

// —— 战斗状态里保留英文名，Boss 换形态后速查仍能匹配 ——
{
  const { state } = updateBattleState(
    null,
    {
      raid_id: 1,
      is_arcarum3: true,
      turn: 1,
      boss: { param: [{ name: { ja: "ベインズゲート", en: "Bane's Gate" }, hp: "100", hpmax: 100, condition: {} }] },
      player: { param: [] },
    },
    { url: "https://game.granbluefantasy.jp/rest/raid/start.json", nodeType: 1 },
  );
  assert.equal(state.bosses[0].nameEn, "Bane's Gate");
  assert.equal(findBossGuide(state.bosses[0]).id, "banes-gate");
}

console.log("boss mechanics tests passed");
