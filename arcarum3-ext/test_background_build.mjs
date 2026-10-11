/** 后台：盘子每次读到就刷新、战斗状态串行更新 */
import assert from "node:assert/strict";

const storage = {};
const sessionStorage = {};
const messageListeners = [];
const tabMessages = [];

globalThis.fetch = async () => ({
  ok: true,
  async json() {
    return { schemaVersion: 1, updatedAt: null, entries: {}, unresolved: [] };
  },
});

globalThis.chrome = {
  runtime: {
    onInstalled: { addListener() {} },
    onMessage: { addListener(listener) { messageListeners.push(listener); } },
    sendMessage: async () => ({ ok: true }),
    getURL: (path) => `chrome-extension://test/${path}`,
  },
  tabs: {
    async sendMessage(tabId, message) { tabMessages.push([tabId, message.type]); },
  },
  sidePanel: { setPanelBehavior: async () => {} },
  storage: {
    local: {
      async get(key) {
        if (typeof key === "string") return { [key]: storage[key] };
        return { ...storage };
      },
      async set(values) { Object.assign(storage, structuredClone(values)); },
      async remove(key) { for (const item of [].concat(key)) delete storage[item]; },
    },
    session: {
      async get(key) { return { [key]: sessionStorage[key] }; },
      async set(values) { Object.assign(sessionStorage, structuredClone(values)); },
    },
  },
  windows: {
    async get() { return null; },
    async update() { return null; },
    async create() { return { id: 1 }; },
    onRemoved: { addListener() {} },
  },
};

await import("./background.js");

function dispatch(message) {
  return new Promise((resolve) => {
    messageListeners[0](message, {}, resolve);
  });
}

function capture(url, body, requestBody) {
  return dispatch({
    type: "API_CAPTURED",
    payload: { url, method: "POST", status: 200, body, requestBody },
  });
}

/** 从游戏页（7 号标签页）发来的抓包 */
function captureFromTab(url, body) {
  return new Promise((resolve) => {
    messageListeners[0](
      { type: "API_CAPTURED", payload: { url, method: "GET", status: 200, body } },
      { tab: { id: 7 } },
      resolve,
    );
  });
}


const ORIGIN = "https://game.granbluefantasy.jp";

function deckBody(mainName) {
  const weapons = {};
  for (let slot = 1; slot <= 13; slot++) {
    weapons[slot] = {
      master: { id: `1040${slot}`, name: slot === 1 ? mainName : `武器${slot}`, attribute: "1" },
      param: { image_id: `1040${slot}00`, level: "100" },
    };
  }
  return { deck: { priority: 11, pc: { weapons, summons: {}, sub_summons: {}, damage_info: {} }, npc: {} } };
}

// —— 盘子 ——
const empty = await dispatch({ type: "GET_BUILD" });
assert.equal(empty.deck.deck, null);
assert.equal(empty.battle, null);

const first = await capture(`${ORIGIN}/party/deck/1/1?_=1`, deckBody("主手A"));
assert.deepEqual(first, { ok: true, kind: "deck", captured: true });
let build = await dispatch({ type: "GET_BUILD" });
assert.equal(build.deck.deck.weapons[0].name, "主手A");
assert.equal(build.deck.source, "/party/deck/1/1");

const second = await capture(`${ORIGIN}/party/deck/1/2?_=2`, JSON.stringify(deckBody("主手B")));
assert.equal(second.captured, true, "再次读到盘子时直接刷新");
build = await dispatch({ type: "GET_BUILD" });
assert.equal(build.deck.deck.weapons[0].name, "主手B");

// 肉鸽下的编成接口：路径不固定，按结构识别
const roguelike = await capture(`${ORIGIN}/rest/arcarum3/dungeon/party_deck?_=3`, {
  option: { party: deckBody("肉鸽主手").deck },
});
assert.deepEqual(roguelike, { ok: true, kind: "deck", captured: true });
build = await dispatch({ type: "GET_BUILD" });
assert.equal(build.deck.deck.weapons[0].name, "肉鸽主手");

// 不带盘子的 arcarum3 响应：不能清掉盘子，也不影响原有处理
const other = await capture(`${ORIGIN}/rest/arcarum3/dungeon/party_status?_=4`, { party: [] });
assert.equal(other.ignored, true);
const moved = await capture(`${ORIGIN}/rest/arcarum3/dungeon/move_node?_=5`, { after_current_node_id: 3 });
assert.equal(moved.kind, "move_node", "地图接口照常走原流程");
build = await dispatch({ type: "GET_BUILD" });
assert.equal(build.deck.deck.weapons[0].name, "肉鸽主手");

// —— 战斗 ——
const ignored = await capture(`${ORIGIN}/rest/raid/setting?_=1`, {});
assert.equal(ignored.ignored, true, "无关的战斗接口直接忽略");

/** 地图：1 普通战斗、2 Boss、3 强敌；当前位置由 move_node 更新 */
async function standOn(nodeId) {
  await capture(`${ORIGIN}/arcarum3/dungeon/content/index/0?_=${nodeId}`, {
    option: {
      dungeon: {
        name: "test",
        current_node_id: nodeId,
        total_turn: 3,
        node_list: [
          { node_id: 1, node_type: 2, position_x: 0, position_y: 0, adjacent_node_ids: [2, 3] },
          { node_id: 2, node_type: 1, position_x: 100, position_y: 0, adjacent_node_ids: [1] },
          { node_id: 3, node_type: 3, position_x: 0, position_y: 100, adjacent_node_ids: [1] },
        ],
      },
    },
  });
}
const startBody = (raidId, omen) => ({
  raid_id: raidId,
  is_arcarum3: true,
  turn: 1,
  boss: { param: [{ name: { ja: raidId === 9 ? "雑魚" : "ボス" }, hp: "900000", hpmax: 900000, condition: {} }] },
  player: { param: [{ name: "主人公", hp: 100, hpmax: 100, alive: 1, condition: {} }] },
  ...(omen ? { special_skill_indicate: [{ interrupt_display_text: omen }] } : {}),
});

await standOn(1);
const started = await capture(`${ORIGIN}/rest/raid/start.json?_=1`, startBody(9));
assert.deepEqual(started, { ok: true, kind: "battle", updated: true });
build = await dispatch({ type: "GET_BUILD" });
assert.equal(build.battle.nodeType, 2, "进入战斗时记下所在格子的类型");

// 连续两次行动结果并发到达：血量与最高伤害都不能丢
await Promise.all([
  capture(`${ORIGIN}/rest/raid/ability_result.json?_=2`, {
    status: { turn: 1 },
    scenario: [
      { cmd: "damage", to: "boss", list: [{ value: 300000 }] },
      { cmd: "boss_gauge", pos: 0, hp: 600000 },
    ],
  }),
  capture(`${ORIGIN}/rest/raid/normal_attack_result.json?_=3`, {
    status: { turn: 2 },
    scenario: [
      { cmd: "attack", from: "player", damage: [[{ value: 200000 }]] },
      { cmd: "boss_gauge", pos: 0, hp: 400000 },
    ],
  }),
]);
build = await dispatch({ type: "GET_BUILD" });
assert.equal(build.battle.bosses[0].hp, 400000);
assert.equal(build.battle.turn, 2);
assert.deepEqual(build.battle.best, { attack: 200000, special: 0, other: 300000 });
assert.equal(build.battle.record.attackTurn, 200000, "普通战斗格的平A计入本局记录");
assert.equal(build.battle.lastAction.kind, "attack");
assert.deepEqual(build.omens.bosses, {}, "没有预兆时不写预兆记录");

// 敌人记录：普通战斗里登记了敌人，还没打死
assert.deepEqual(
  Object.values(build.enemies.enemies).map((e) => [e.name, e.hpMax, e.seen, e.kills, e.nodeType]),
  [["雑魚", 900000, 1, 0, 2]],
);

// 第 2 回合才打死：记一次击杀，但不是一回合击杀
await capture(`${ORIGIN}/rest/raid/normal_attack_result.json?_=31`, {
  status: { turn: 3 },
  scenario: [
    { cmd: "attack", from: "player", damage: [[{ value: 100000 }]] },
    { cmd: "die", to: "boss", pos: 0 },
  ],
});
build = await dispatch({ type: "GET_BUILD" });
assert.deepEqual(
  Object.values(build.enemies.enemies).map((e) => [e.kills, e.oneTurnKills, e.bestTurns]),
  [[1, 0, 2]],
);

// 再遇到同一个敌人，这次第 1 回合就打死：标成一回合击杀
await capture(`${ORIGIN}/rest/raid/start.json?_=32`, { ...startBody(9), raid_id: 91 });
await capture(`${ORIGIN}/rest/raid/start.json?_=33`, { ...startBody(9), raid_id: 91 }); // 刷新页面
await capture(`${ORIGIN}/rest/raid/ability_result.json?_=34`, {
  status: { turn: 1 },
  scenario: [{ cmd: "damage", to: "boss", list: [{ value: 900000 }] }, { cmd: "boss_gauge", pos: 0, hp: 0 }],
});
build = await dispatch({ type: "GET_BUILD" });
assert.deepEqual(
  Object.values(build.enemies.enemies).map((e) => [e.seen, e.kills, e.oneTurnKills, e.bestTurns]),
  [[2, 2, 1, 1]],
  "刷新页面不重复登记；第 1 回合内打死算一回合击杀",
);

// Boss 格：攻击回合也计入记录；预兆（解除条件）写入记录并标为新
await standOn(2);
await capture(`${ORIGIN}/rest/raid/start.json?_=4`, startBody(10, ["10回ダメージ", "弱体効果を3つ付与"]));
await capture(`${ORIGIN}/rest/raid/normal_attack_result.json?_=5`, {
  status: { turn: 2, special_skill_indicate: [{ interrupt_display_text: ["10回ダメージ", "弱体効果を3つ付与"] }] },
  scenario: [{ cmd: "attack", from: "player", damage: [[{ value: 999999 }]] }],
});
build = await dispatch({ type: "GET_BUILD" });
assert.equal(build.battle.nodeType, 1);
assert.equal(build.battle.record.attackTurn, 999999, "Boss 战的攻击回合也计入记录");
assert.equal(Object.keys(build.enemies.enemies).length, 2, "Boss 也登记进敌人记录");
assert.equal(build.enemies.enemies["ボス|Lv?"].nodeType, 1);
assert.deepEqual(build.battle.omens[0].conditions, ["10回ダメージ", "弱体効果を3つ付与"]);
assert.equal(build.battle.newOmenKeys.length, 1, "第一次见到的预兆标为新");
assert.equal(build.omens.bosses["ボス"].nodeType, 1);
assert.equal(build.omens.bosses["ボス"].day, 1);
assert.equal(Object.keys(build.omens.bosses["ボス"].omens).length, 1);

// 同一个 Boss 的第二种预兆：追加到记录里
await capture(`${ORIGIN}/rest/raid/ability_result.json?_=6`, {
  status: { turn: 3, special_skill_indicate: [{ interrupt_display_text: ["奥義を2回発動"] }] },
  scenario: [],
});
build = await dispatch({ type: "GET_BUILD" });
assert.equal(Object.keys(build.omens.bosses["ボス"].omens).length, 2);
assert.equal(build.battle.newOmenKeys.length, 2);
// 预兆结束（status 里不再有）：当前预兆清空，记录保留
await capture(`${ORIGIN}/rest/raid/ability_result.json?_=7`, { status: { turn: 3 }, scenario: [] });
build = await dispatch({ type: "GET_BUILD" });
assert.deepEqual(build.battle.omens, []);
assert.equal(Object.keys(build.omens.bosses["ボス"].omens).length, 2);

// 手动清零
const resetResult = await dispatch({ type: "RESET_BATTLE_RECORD" });
assert.ok(resetResult.changed);
assert.equal(resetResult.battle.record.attackTurn, 0);
assert.equal(resetResult.battle.bosses[0].hp, 900000, "清零不影响战斗状态");

// —— 不在战斗里：移动、事件的响应也要让地图和队伍血量动起来 ——
await standOn(1);
const getMap = async () => (await dispatch({ type: "GET_STATE" })).state;
await capture(`${ORIGIN}/rest/arcarum3/dungeon/move_node?_=30`, {
  after_current_node_id: 3,
  action_scenario_list: [
    { action_type: 1 },
    { action_type: 3, after_party_status: [{ image_id: "3040000000_01", hp: 4321, max_hp: 9000, attribute: 2 }] },
  ],
});
let map = await getMap();
assert.equal(map.current_node_id, 3, "走了一步，当前位置跟着动");
assert.equal(map.node_list.find((node) => node.node_id === 3).is_visited, true, "站上去的格子算走过");
build = await dispatch({ type: "GET_BUILD" });
assert.deepEqual(
  build.party.members.map((member) => [member.imageId, member.hp, member.hpMax]),
  [["3040000000_01", 4321, 9000]],
  "移动之后的队伍血量直接读出来，不用点开队伍状态",
);
// 事件结束：这一格用掉了，别处冒出特殊事件
await capture(`${ORIGIN}/rest/arcarum3/dungeon/finish_node_event?_=31`, {
  is_delete_node: true,
  special_incident_appearance_info: { 1: { appearance_list: [{ node_id: 2, special_incident_id: 7 }] } },
});
map = await getMap();
assert.equal(map.node_list.find((node) => node.node_id === 3).node_type, 0, "用掉的格子变空地");
assert.deepEqual(
  [map.node_list.find((node) => node.node_id === 2).node_type, map.node_list.find((node) => node.node_id === 2).special_incident_id],
  [10, 7],
  "新出现的特殊事件标到地图上",
);
// 传送
await capture(`${ORIGIN}/rest/arcarum3/dungeon/proceed_node_event?_=32`, {
  action_scenario_list: [{ action_type: 5, warp_node_id: 1, delete_node_ids: [2] }],
});
map = await getMap();
assert.equal(map.current_node_id, 1, "传送后当前位置换到目的地");
assert.equal(map.node_list.find((node) => node.node_id === 2).node_type, 0);

// —— 商店：进店记货架、买东西扣库存 ——
await standOn(3);
const lineup = await capture(`${ORIGIN}/rest/arcarum3/dungeon/dungeon_shop_lineup/1?_=40`, {
  coin_amount: 500,
  item_list: [
    { lineup_id: 11, item_type: 4, status_id: 1, name: "攻撃力UP(20%)", rarity: 1, price: 200, stock_num: 1, can_purchase: true },
    { lineup_id: 12, item_type: 6, item_name: "導本効果削除", price: 250, stock_num: 1, can_purchase: true },
  ],
});
assert.equal(lineup.kind, "guidebook_shop", "原来的导本商店处理照常进行");
build = await dispatch({ type: "GET_BUILD" });
assert.equal(build.shops.coin, 500);
assert.deepEqual(
  build.shops.shops[3].tabs[1].map((item) => [item.lineupId, item.price, item.stock, item.category]),
  [[11, 200, 1, "book:1"], [12, 250, 1, "type:6"]],
  "货架记在当前所在的格子（3 号）下",
);
await capture(`${ORIGIN}/rest/arcarum3/dungeon/purchase_dungeon_shop_item?_=41`, { ok: true }, JSON.stringify({ lineup_id: 12 }));
build = await dispatch({ type: "GET_BUILD" });
assert.deepEqual(build.shops.shops[3].tabs[1].map((item) => item.stock), [1, 0], "买了消除导本，库存扣掉");
// 表单格式的请求体也认
await capture(`${ORIGIN}/rest/arcarum3/dungeon/purchase_dungeon_shop_item?_=42`, { ok: true }, "lineup_id=11&foo=1");
build = await dispatch({ type: "GET_BUILD" });
assert.deepEqual(build.shops.shops[3].tabs[1].map((item) => item.stock), [0, 0]);

// 开新一局：上一局的战斗记录不带过去，预兆记录跨局保留
await capture(`${ORIGIN}/rest/arcarum3/start_dungeon?_=8`, { ok: true });
build = await dispatch({ type: "GET_BUILD" });
assert.equal(build.battle, null, "开新一局清掉上一局的战斗记录");
assert.deepEqual(build.shops.shops, {}, "开新一局清掉上一局的商店货架");
assert.equal(Object.keys(build.omens.bosses["ボス"].omens).length, 2, "预兆记录跨局保留");
assert.equal(build.enemies.enemies["雑魚|Lv?"].oneTurnKills, 1, "敌人记录跨局保留");

// —— 第 1 天第 1 回合：没抓到 start_dungeon 也要认出新的一局 ——
const mapAt = (turn, current = 1) => ({
  option: {
    dungeon: {
      name: "test",
      current_node_id: current,
      total_turn: turn,
      node_list: [
        { node_id: 1, node_type: 0, position_x: 0, position_y: 0, adjacent_node_ids: [2] },
        { node_id: 2, node_type: 8, position_x: 100, position_y: 0, adjacent_node_ids: [1] },
      ],
    },
  },
});
const fillRun = async () => {
  await captureFromTab(`${ORIGIN}/rest/arcarum3/dungeon/party_status?_=50`, {
    party: [{ image_id: "3040000000_01", hp: 1, max_hp: 9000, attribute: 2 }],
  });
  await captureFromTab(`${ORIGIN}/rest/arcarum3/dungeon/dungeon_shop_lineup/1?_=51`, {
    coin_amount: 10,
    item_list: [{ lineup_id: 1, item_type: 6, item_name: "x", price: 5, stock_num: 1, can_purchase: true }],
  });
  await captureFromTab(`${ORIGIN}/rest/raid/start.json?_=52`, startBody(9));
};

// 上一局打到第 6 回合，留下了队伍血量、商店、战斗
await captureFromTab(`${ORIGIN}/arcarum3/dungeon/content/index/0?_=49`, mapAt(5, 2));
await fillRun();
build = await dispatch({ type: "GET_BUILD" });
assert.ok(build.party && build.battle && Object.keys(build.shops.shops).length, "上一局的状态都在");

// 新一局的第一张地图
await captureFromTab(`${ORIGIN}/arcarum3/dungeon/content/index/0?_=53`, mapAt(0));
build = await dispatch({ type: "GET_BUILD" });
assert.equal(build.battle, null, "第 1 天第 1 回合：清掉上一局的战斗记录");
assert.equal(build.party, null, "清掉上一局的队伍血量");
assert.deepEqual(build.shops.shops, {}, "清掉上一局的商店货架");
assert.ok(build.deck.deck, "盘子不清：每次读到直接刷新");
assert.equal(build.enemies.enemies["雑魚|Lv?"].oneTurnKills, 1, "敌人记录跨局保留");

// 同一回合里刷新页面：不算新的一局
await fillRun();
await captureFromTab(`${ORIGIN}/arcarum3/dungeon/content/index/0?_=54`, mapAt(0));
build = await dispatch({ type: "GET_BUILD" });
assert.ok(build.party && build.battle, "第 1 回合里刷新页面不清状态");

// 抓到了 start_dungeon：那时清一次，地图出来不再清第二遍
await captureFromTab(`${ORIGIN}/rest/arcarum3/start_dungeon?_=55`, { ok: true });
build = await dispatch({ type: "GET_BUILD" });
assert.equal(build.party, null, "start_dungeon 也清队伍血量");
await captureFromTab(`${ORIGIN}/rest/arcarum3/dungeon/party_status?_=56`, {
  party: [{ image_id: "3040000000_01", hp: 9000, max_hp: 9000, attribute: 2 }],
});
await captureFromTab(`${ORIGIN}/arcarum3/dungeon/content/index/0?_=57`, mapAt(0));
build = await dispatch({ type: "GET_BUILD" });
assert.equal(build.party.members[0].hp, 9000, "start_dungeon 之后读到的新数据不会被地图再清一遍");

// —— 排查用的抓包记录：只记肉鸽接口，放在内存里，不带用户 ID ——
await capture(`${ORIGIN}/rest/arcarum3/dungeon/spacebook_status_list?filter_type=4&_=1&t=2&uid=12345678`, {
  status_list: [{ status_id: 7, name: "ダメージ上限UP(10%)", num: 1, user_id: "12345678" }],
});
await new Promise((resolve) => setTimeout(resolve, 30));
{
  const entries = sessionStorage.gbfrogeCaptureLog.entries;
  assert.ok(entries.length > 10, "肉鸽接口都记下来了");
  assert.equal(entries.at(-1).url, "/rest/arcarum3/dungeon/spacebook_status_list?filter_type=4");
  assert.equal(entries.at(-1).response.status_list[0].name, "ダメージ上限UP(10%)");
  assert.equal(JSON.stringify(entries).includes("12345678"), false, "记录里不带用户 ID");
  assert.equal(entries.some((entry) => /\/raid\//.test(entry.url)), false, "战斗接口不记");
  assert.equal(storage.gbfrogeCaptureLog, undefined, "不写进本地存储，只放在内存里");
}

// 只听不发：后台从不向游戏页发消息
assert.deepEqual(tabMessages, [], "后台不向游戏页发任何指令");

console.log("background build tests passed");
