import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  QUICKREF_SHORT_NAMES,
  buildQuickRef,
  hideQuickRefItem,
  isCursed,
  isNonStackable,
  quickRefName,
  quickRefShortName,
} from "./shared/guidebookQuickRef.js";
import { extractPartyStatus, mergePartyView, splitPartyRows } from "./shared/party.js";
import { parseCharacterGuidebook, translateCharacterGuidebook } from "./shared/characterGuidebooks.js";
import { getGuidebookDisplayName } from "./shared/guidebookTranslations.js";
import { updateBattleState } from "./shared/battle.js";
import { extractOmens, knownOmenCount, listOmenLog, recordOmens } from "./shared/omens.js";

// —— 导本速查：用随扩展附带的真实导本库 ——
const database = JSON.parse(
  await readFile(new URL("./data/guidebooks.json", import.meta.url), "utf8"),
);
const catalogue = database.entries;

assert.ok(isNonStackable(catalogue[32]), "必中带「重複不可」");
assert.equal(isNonStackable(catalogue[1]), false);
assert.ok(isCursed(catalogue[117]), "稀有度 99 是诅咒");
assert.ok(isCursed(catalogue[126]), "「先减后增」类按图标分类也算 debuff");
assert.equal(isCursed(catalogue[72]), false);
assert.equal(
  quickRefName(catalogue[77]),
  "全体奥义槽最大值变为200",
  "显示名去掉「(不可重复)」后缀",
);
assert.equal(quickRefName({ statusId: 5, text: {} }), "导本 #5");

{
  const state = {
    catalogue,
    inventory: {
      72: { statusId: 72, num: 1 }, // 金
      77: { statusId: 77, num: 1 }, // 金 · 不可重复
      32: { statusId: 32, num: 1 }, // 稀有 · 不可重复
      117: { statusId: 117, num: 2 }, // 诅咒
      126: { statusId: 126, num: 1 }, // 先减后增
      1: { statusId: 1, num: 3 }, // 普通，可重复 → 不在速查里
    },
  };
  const ref = buildQuickRef(state);

  assert.equal(ref.gold.length, 33, "金导本 = 稀有度 3 的全部条目");
  assert.ok(ref.gold.every((item) => item.rarity === 3));
  assert.deepEqual(ref.gold.slice(0, 2).map((item) => item.statusId), [72, 77], "已持有的排最前");
  assert.ok(ref.gold.some((item) => item.statusId === 77 && item.nonStackable), "金导本里的不可重复带标记");

  // 方块：全部不可重复（稀有 13 条在前，金的在后），位置固定
  assert.ok(ref.tiles.every((item) => item.nonStackable && item.rarity !== 99));
  const rareTiles = ref.tiles.filter((item) => item.rarity === 2);
  assert.equal(rareTiles.length, 13);
  assert.deepEqual(ref.tiles.slice(0, 13), rareTiles, "稀有的排在金的前面");
  assert.ok(ref.tiles.some((item) => item.statusId === 77 && item.rarity === 3), "金的不可重复也有方块");
  assert.ok(!ref.tiles.some((item) => item.statusId === 1 || item.statusId === 72));
  const tile = (id) => ref.tiles.find((item) => item.statusId === id);
  assert.equal(tile(32).short, "必中");
  assert.equal(tile(32).num, 1, "持有的方块点亮");
  assert.equal(tile(60).short, "全种族");
  assert.equal(tile(60).num, 0);
  assert.equal(tile(83).short, "召唤CD1");
  for (const item of ref.tiles) {
    assert.ok(item.short.length > 0 && [...item.short].length <= 6, `#${item.statusId} 的缩写要够短：${item.short}`);
    assert.ok(QUICKREF_SHORT_NAMES[item.statusId], `#${item.statusId}「${item.name}」需要一个人工缩写`);
    assert.equal(item.short, QUICKREF_SHORT_NAMES[item.statusId], "人工缩写优先于自动识别");
  }
  const unchanged = buildQuickRef({ catalogue, inventory: {} }).tiles.map((item) => item.statusId);
  assert.deepEqual(ref.tiles.map((item) => item.statusId), unchanged, "方块顺序不随持有变化");
  assert.equal(quickRefShortName(9999, "某个很长的新导本效果"), "某个很长的", "没有人工缩写时取前几个字");

  assert.deepEqual(
    ref.cursed.map((item) => [item.statusId, item.num]),
    [[117, 2], [126, 1]],
    "debuff 只列当前持有的",
  );
  assert.equal(ref.hiddenCount, 0);

  // 剔除：之后不再显示；debuff 不受影响
  let hidden = hideQuickRefItem([], 72);
  hidden = hideQuickRefItem(hidden, 32);
  hidden = hideQuickRefItem(hidden, 32);
  hidden = hideQuickRefItem(hidden, 77);
  hidden = hideQuickRefItem(hidden, 117);
  assert.deepEqual(hidden, [32, 72, 77, 117]);
  const trimmed = buildQuickRef(state, hidden);
  assert.equal(trimmed.gold.length, 31);
  assert.ok(!trimmed.gold.some((item) => item.statusId === 72 || item.statusId === 77));
  assert.ok(!trimmed.tiles.some((item) => item.statusId === 32 || item.statusId === 77));
  assert.equal(trimmed.hiddenCount, 3, "只统计速查里实际被隐藏的条目（金且不可重复的只算一次）");
  assert.equal(trimmed.cursed.length, 2, "debuff 是警告，不能被剔除");

  assert.deepEqual(buildQuickRef(null), { cursed: [], tiles: [], gold: [], hiddenCount: 0 });
}

// —— 角色专属导本：不知道编号，靠文字格式识别 ——
{
  // 玩家截图里的原文（妮娅）
  const NIER =
    "バトル開始時にニーアが「恋人の正位置」を発動/永久ノ誓イが使用可能になる/" +
    "攻撃開始時にニーアと主人公がバトルメンバーにいる時、2人に再攻撃効果　◆ニーアがバトルメンバーにいる時のみ発動(重複不可)";
  assert.deepEqual(parseCharacterGuidebook(NIER), {
    character: "ニーア",
    characterZh: "妮娅",
    arcana: "恋人",
    short: "恋人",
  });
  assert.match(translateCharacterGuidebook(NIER), /妮娅发动「恋人的正位」.*再攻击效果/);

  // 已有的两本用同一种格式，识别结果要和人工起的缩写一致
  assert.equal(parseCharacterGuidebook(catalogue[108].text.ja).short, "女帝");
  assert.equal(parseCharacterGuidebook(catalogue[110].text.ja).short, "愚者");
  assert.equal(parseCharacterGuidebook(catalogue[110].text.ja).characterZh, "凯姆");
  // 没见过的牌名 / 角色：原样保留，不会认不出来
  assert.deepEqual(
    parseCharacterGuidebook("バトル開始時にフラウが「未知の札の正位置」を発動/なにか　◆フラウがバトルメンバーにいる時のみ発動(重複不可)"),
    { character: "フラウ", characterZh: "弗劳", arcana: "未知の札", short: "未知の札" },
  );
  assert.equal(parseCharacterGuidebook("攻撃力UP(20%)"), null);
  assert.equal(translateCharacterGuidebook("攻撃力UP(20%)"), "");
  assert.equal(translateCharacterGuidebook(catalogue[108].text.ja), "", "没有逐字核对过的不乱翻译");

  // 游戏里新出现、编号未知（这里随便用 999）的角色导本：自动进金导本列表和不可重复方块
  const fresh = { statusId: 999, rawName: NIER, text: { "zh-CN": "", ja: NIER, en: "" }, rarity: 3, iconCategory: 3 };
  const ref = buildQuickRef({ catalogue: { ...catalogue, 999: fresh }, inventory: { 999: { statusId: 999, num: 1 } } });
  const tile = ref.tiles.find((item) => item.statusId === 999);
  assert.ok(tile, "带「重複不可」→ 有方块");
  assert.equal(tile.short, "恋人", "缩写用牌名，不需要人工登记编号");
  assert.equal(tile.num, 1);
  assert.match(tile.name, /^战斗开始时，妮娅发动「恋人的正位」/, "显示中文");
  assert.ok(!/不可重复/.test(tile.name), "「(不可重复)」后缀照常去掉");
  assert.equal(ref.gold[0].statusId, 999, "也在金导本列表里，持有的排最前");
  // 导本页的显示名用同一份翻译；已有中文的条目不受影响
  assert.match(getGuidebookDisplayName(fresh), /妮娅发动「恋人的正位」/);
  assert.equal(getGuidebookDisplayName(catalogue[108]), catalogue[108].text["zh-CN"]);
}

// —— 预兆记录 ——
{
  assert.deepEqual(extractOmens({}), []);
  assert.deepEqual(extractOmens({ status: { special_skill_indicate: [] } }), []);

  const response = {
    status: {
      special_skill_indicate: [
        {
          special_skill_name: "終焉の<br>一撃",
          interrupt_display_text: ["<span>10回</span>ダメージ", "", "弱体効果を3つ付与"],
          gauge: 3,
        },
      ],
    },
  };
  const [omen] = extractOmens(response);
  assert.equal(omen.name, "終焉の 一撃");
  assert.deepEqual(omen.conditions, ["10回ダメージ", "弱体効果を3つ付与"], "去掉标签和空条件");
  assert.deepEqual(omen.fields, ["gauge", "interrupt_display_text", "special_skill_name"]);
  // 开场响应里也可能在顶层
  assert.equal(extractOmens({ special_skill_indicate: response.status.special_skill_indicate }).length, 1);

  let result = recordOmens(null, { bossName: "ボス", nodeType: 1, day: 2, omens: [omen], now: 10 });
  assert.ok(result.changed);
  assert.deepEqual(result.newKeys, [omen.key]);
  assert.equal(knownOmenCount(result.log, "ボス"), 1);

  const again = recordOmens(result.log, { bossName: "ボス", omens: [omen], now: 20 });
  assert.equal(again.changed, false, "见过的预兆不算变化");
  assert.deepEqual(again.newKeys, []);
  assert.equal(again.log.bosses["ボス"].day, 2, "后续响应不带天数时保留原来的");

  const second = extractOmens({ status: { special_skill_indicate: [{ interrupt_display_text: ["奥義を2回発動"] }] } });
  result = recordOmens(result.log, { bossName: "ボス", omens: second, now: 30 });
  assert.equal(knownOmenCount(result.log, "ボス"), 2);
  result = recordOmens(result.log, { bossName: "雑魚", nodeType: 2, day: 1, omens: second, now: 40 });

  const list = listOmenLog(result.log);
  assert.deepEqual(list.map((boss) => [boss.name, boss.alert, boss.omens.length]), [
    ["ボス", true, 2],
    ["雑魚", false, 1],
  ]);
  assert.deepEqual(list[0].omens[0].conditions, ["10回ダメージ", "弱体効果を3つ付与"], "按首次出现的顺序");

  assert.equal(recordOmens(result.log, { bossName: "", omens: second }).changed, false);
  assert.equal(recordOmens(result.log, { bossName: "ボス", omens: [] }).changed, false);
  assert.deepEqual(listOmenLog(null), []);
}

// —— 队伍血量：地图与战斗两种来源 ——
{
  assert.equal(extractPartyStatus({}), null);
  assert.equal(extractPartyStatus({ party: [] }), null);
  const party = extractPartyStatus(
    { party: [{ image_id: "150201_sw_0_01", hp: "12000", max_hp: "30000", attribute: "4" }, { image_id: "3040001000_01", hp: 0, max_hp: 20000 }] },
    100,
  );
  assert.deepEqual(party.members[0], { imageId: "150201_sw_0_01", hp: 12000, hpMax: 30000, attribute: 4 });
  assert.equal(extractPartyStatus([{ image_id: 1, hp: 5, max_hp: 10 }], 1).members.length, 1, "也接受数组本体");

  let view = mergePartyView(party, null);
  assert.equal(view.source, "map");
  assert.match(view.members[0].imageUrl, /\/leader\/raid_normal\/150201_sw_0_01\.jpg$/);
  assert.match(view.members[1].imageUrl, /\/npc\/raid_normal\/3040001000_01\.jpg$/);
  assert.equal(view.members[1].alive, false);
  assert.deepEqual(mergePartyView(null, null), { source: null, members: [] });

  // 战斗开始后以战斗里的血量为准，并随敌方攻击更新
  const START = "https://game.granbluefantasy.jp/rest/raid/start.json";
  const ATTACK = "https://game.granbluefantasy.jp/rest/raid/normal_attack_result.json";
  let { state: battle } = updateBattleState(
    null,
    {
      raid_id: 1,
      is_arcarum3: true,
      turn: 1,
      boss: { param: [{ name: { ja: "敵" }, hp: "100", hpmax: 100, condition: {} }] },
      player: {
        param: [
          { name: "主人公", pid: "150201_sw_0", cjs: "mc_1", hp: 12000, hpmax: 30000, alive: 1, condition: { buff: [{ status: "1383" }] } },
          { name: "カイム", pid: "3040001000", cjs: "npc_3040001000_01", hp: 20000, hpmax: 20000, alive: 1, condition: {} },
        ],
      },
    },
    { url: START, now: 200 },
  );
  view = mergePartyView(party, battle);
  assert.equal(view.source, "battle");
  assert.deepEqual(view.members.map((m) => [m.name, m.hp, m.hpMax]), [["主人公", 12000, 30000], ["カイム", 20000, 20000]]);
  // 与 Tarou 一致：只取 pid 的第一段再加 _01
  assert.match(view.members[0].imageUrl, /\/leader\/s\/150201_01\.jpg$/);
  assert.match(view.members[1].imageUrl, /\/npc\/s\/3040001000_01\.jpg$/);
  assert.equal(view.members[0].conditions.length, 1);
  assert.deepEqual(view.members.map((m) => m.front), [true, true], "没有 formation 时前 4 人算前排");

  // 六人队：默认前 4 人是前排；有 formation 时按它（后排换上来的也算）
  const six = structuredClone(battle);
  six.players = Array.from({ length: 6 }, (_, index) => ({ ...battle.players[0], pos: index, name: `P${index}` }));
  assert.deepEqual(mergePartyView(null, six).members.map((m) => m.front), [true, true, true, true, false, false]);
  six.formation = [0, 4, 2, 5];
  assert.deepEqual(mergePartyView(null, six).members.map((m) => m.front), [true, false, true, false, true, true]);

  // 两行显示：前排按站位顺序，后排按队伍顺序
  let rows = splitPartyRows(mergePartyView(null, six).members);
  assert.deepEqual(rows.front.map((m) => m.name), ["P0", "P4", "P2", "P5"]);
  assert.deepEqual(rows.back.map((m) => m.name), ["P1", "P3"]);
  delete six.formation;
  rows = splitPartyRows(mergePartyView(null, six).members);
  assert.deepEqual(rows.front.map((m) => m.name), ["P0", "P1", "P2", "P3"], "没有站位数据时前 4 人是前排");
  assert.deepEqual(rows.back.map((m) => m.name), ["P4", "P5"]);
  assert.deepEqual(splitPartyRows([]), { front: [], back: [] });

  // 开场响应里的站位：前排两人倒下后，后排补到前面（玩家截图里的情况）
  const midBattle = updateBattleState(
    null,
    {
      raid_id: 77,
      is_arcarum3: true,
      turn: 11,
      boss: { param: [{ name: { ja: "敵" }, hp: "100", hpmax: 100, condition: {} }] },
      player: {
        param: [0, 90011, 0, 79807, 90534, 62778].map((hp, index) => ({
          name: `C${index}`, pid: `30400${index}000`, cjs: "npc_x", hp, hpmax: 100000, alive: hp > 0 ? 1 : 0, condition: {},
        })),
      },
      // 每个前排角色一项，pos 是角色序号
      ability: { 1: { pos: 1 }, 2: { pos: 3 }, 3: { pos: 4 }, 4: { pos: 5 } },
    },
    { url: START, now: 1 },
  ).state;
  assert.deepEqual(midBattle.formation, [1, 3, 4, 5]);
  rows = splitPartyRows(mergePartyView(null, midBattle).members);
  assert.deepEqual(rows.front.map((m) => m.hp), [90011, 79807, 90534, 62778], "还活着的四人是前排");
  assert.deepEqual(rows.back.map((m) => m.hp), [0, 0], "倒下的两人在后排");

  ({ state: battle } = updateBattleState(
    battle,
    {
      status: { turn: 2 },
      scenario: [
        { cmd: "attack", from: "boss", damage: [[{ pos: 0, value: 4000, hp: 8000 }, { pos: 1, value: 25000, hp: 0 }]] },
        { cmd: "heal", to: "player", list: [{ pos: 0, value: 3000, hp: 11000 }] },
        { cmd: "damage", to: "player", list: [{ pos: 9, value: 1, hp: 1 }, { pos: 0, value: 500 }] },
      ],
    },
    { url: ATTACK, now: 300 },
  ));
  assert.equal(battle.players[0].hp, 11000, "受击与回复都按条目里的剩余血量更新；没带血量的条目忽略");
  assert.equal(battle.players[1].hp, 0);
  assert.equal(battle.players[1].alive, false);

  // 前排换人后：pos 是站位，要按 formation 换算成角色序号
  ({ state: battle } = updateBattleState(
    battle,
    { status: { turn: 3, formation: ["1", "0"] }, scenario: [] },
    { url: ATTACK, now: 310 },
  ));
  ({ state: battle } = updateBattleState(
    battle,
    { status: { turn: 4 }, scenario: [{ cmd: "attack", from: "boss", damage: [[{ pos: 1, value: 1000, hp: 10000 }]] }] },
    { url: ATTACK, now: 320 },
  ));
  assert.equal(battle.players[0].hp, 10000, "站位 1 现在是 0 号角色");

  // 回到地图后收到更新的 party_status：改用地图的数值，名字沿用战斗里的
  const later = extractPartyStatus({ party: [{ image_id: "a", hp: 9000, max_hp: 30000 }, { image_id: "b", hp: 6000, max_hp: 20000 }] }, 999);
  view = mergePartyView(later, battle);
  assert.equal(view.source, "map");
  assert.deepEqual(view.members.map((m) => [m.name, m.hp]), [["主人公", 9000], ["カイム", 6000]]);
  assert.deepEqual(view.members[0].conditions, [], "地图上不显示战斗状态");
}

console.log("quick ref & omen tests passed");
