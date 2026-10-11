import assert from "node:assert/strict";

const storage = {};
const messageListeners = [];
const downloads = [];

globalThis.fetch = async (url) => ({
  ok: true,
  async json() {
    if (String(url).endsWith("data/guidebooks.json")) {
      return {
        schemaVersion: 1,
        updatedAt: null,
        entries: {
          24: {
            statusId: 24,
            text: { ja: "自属性スキルエンハンス(60%)" },
            rarity: 2,
          },
        },
        unresolved: [],
      };
    }
    if (String(url).endsWith("data/guidebooks.zh-CN.json")) {
      return {
        schemaVersion: 1,
        updatedAt: null,
        entries: {
          24: {
            statusId: 24,
            text: { "zh-CN": "自属性加护强化(60%)" },
            rarity: 2,
          },
        },
        unresolved: [],
      };
    }
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
  sidePanel: { setPanelBehavior: async () => {} },
  storage: {
    local: {
      async get(key) {
        if (typeof key === "string") return { [key]: storage[key] };
        return { ...storage };
      },
      async set(values) { Object.assign(storage, values); },
      async remove(key) { for (const item of [].concat(key)) delete storage[item]; },
    },
  },
  downloads: {
    async download(options) {
      downloads.push(options);
      return downloads.length;
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
assert.equal(messageListeners.length, 1);

function dispatch(message) {
  return new Promise((resolve) => {
    messageListeners[0](message, {}, resolve);
  });
}

const profileResult = await dispatch({
  type: "API_CAPTURED",
  payload: {
    url: "https://game.granbluefantasy.jp/socket/query?nickname=Alice",
    method: "GET",
    status: 200,
    body: JSON.stringify({ nickname: "Alice" }),
  },
});
assert.equal(profileResult.ok, true);
assert.equal(profileResult.kind, "player_profile");
assert.equal(profileResult.playerName, "Alice");
assert.equal((await dispatch({ type: "GET_STATE" })).state.playerName, "Alice");
assert.equal((await dispatch({ type: "GET_GUIDEBOOKS" })).state.playerName, "Alice");
const seededGuidebooks = await dispatch({ type: "GET_GUIDEBOOKS" });
assert.equal(seededGuidebooks.state.catalogue[24].text["zh-CN"], "自属性加护强化(60%)");
assert.equal(seededGuidebooks.state.catalogue[24].text.ja, "自属性スキルエンハンス(60%)");

const statusResult = await dispatch({
  type: "API_CAPTURED",
  payload: {
    url: "https://game.granbluefantasy.jp/rest/arcarum3/dungeon/spacebook_status_list",
    method: "GET",
    status: 200,
    gameLanguage: "ja",
    body: JSON.stringify({
      status_list: [
        { status_id: 201, name: "攻撃力上昇", rarity: 3, num: 2 },
      ],
    }),
  },
});
assert.equal(statusResult.ok, true);
assert.equal(statusResult.guidebooks, 2);

const firstState = await dispatch({ type: "GET_GUIDEBOOKS" });
assert.equal(firstState.state.catalogue[201].rawName, "攻撃力上昇");
assert.equal(firstState.state.catalogue[201].text.ja, "攻撃力上昇");
assert.equal(firstState.state.inventory[201].num, 2);

const bookPageResult = await dispatch({
  type: "API_CAPTURED",
  payload: {
    url: "https://game.granbluefantasy.jp/arcarum3/book/content/index",
    method: "GET",
    status: 200,
    body: JSON.stringify({
      option: {
        status_list: [
          {
            user_status_id: 8101,
            status_id: 204,
            name: "导本页原文",
            rarity: 2,
          },
        ],
      },
    }),
  },
});
assert.equal(bookPageResult.ok, true);
assert.equal(bookPageResult.ignored, undefined, "导本页响应不能在入口被忽略");
const bookPageState = await dispatch({ type: "GET_GUIDEBOOKS" });
assert.equal(bookPageState.state.catalogue[204].rawName, "导本页原文");
assert.equal(bookPageState.state.inventory[204].num, 1);

await Promise.all([
  dispatch({
    type: "API_CAPTURED",
    payload: {
      url: "https://game.granbluefantasy.jp/rest/arcarum3/dungeon/move_node",
      body: JSON.stringify({
        action_scenario_list: [
          { action_type: 401, status_list: [{ status_id: 202, name: "并发B", rarity: 2 }] },
        ],
      }),
    },
  }),
  dispatch({
    type: "API_CAPTURED",
    payload: {
      url: "https://game.granbluefantasy.jp/rest/arcarum3/dungeon/incident_choose",
      body: JSON.stringify({
        action_scenario_list: [
          { action_type: 401, status_list: [{ status_id: 203, name: "并发C", rarity: 1 }] },
        ],
      }),
    },
  }),
]);

const concurrentState = await dispatch({ type: "GET_GUIDEBOOKS" });
assert.equal(concurrentState.state.catalogue[202].rawName, "并发B");
assert.equal(concurrentState.state.catalogue[203].rawName, "并发C");
assert.ok(concurrentState.state.activeSelection);

await new Promise((resolve) => setTimeout(resolve, 350));
downloads.length = 0;

await dispatch({
  type: "API_CAPTURED",
  payload: {
    url: "https://game.granbluefantasy.jp/rest/arcarum3/dungeon/proceed_node_event",
    gameLanguage: "ja",
    body: JSON.stringify({
      node_type: 5,
      action_scenario_list: [
        { scenario_type: 1, text: "鉱脈を見つけた。", image: "common_486.jpg" },
        {
          scenario_type: 2,
          choice_ids: [
            {
              choice_id: 10110101,
              title: "鉱石を掘る",
              text: "セフィラコイン+250",
              is_disabled: false,
              is_quest_check: false,
              turn: 1,
            },
          ],
        },
      ],
    }),
  },
});
const incidentState = await dispatch({ type: "GET_GUIDEBOOKS" });
assert.equal(incidentState.state.incidentCatalogue[101101].options[10110101].title.ja, "鉱石を掘る");
await new Promise((resolve) => setTimeout(resolve, 350));
assert.deepEqual(
  downloads.map((item) => item.filename),
  [],
  "新事件不能触发自动下载",
);

const clearSelectionResult = await dispatch({
  type: "CLEAR_GUIDEBOOK_SELECTION",
});
assert.equal(clearSelectionResult.ok, true);
assert.equal(clearSelectionResult.changed, true);
assert.equal(clearSelectionResult.state.activeSelection, null);
assert.equal(Object.keys(clearSelectionResult.state.catalogue).length, 5);

const repeatedClearSelectionResult = await dispatch({
  type: "CLEAR_GUIDEBOOK_SELECTION",
});
assert.equal(repeatedClearSelectionResult.ok, true);
assert.equal(repeatedClearSelectionResult.changed, false);

await dispatch({
  type: "API_CAPTURED",
  payload: {
    url: "https://game.granbluefantasy.jp/rest/arcarum3/start_dungeon",
    body: "{}",
  },
});
const resetState = await dispatch({ type: "GET_GUIDEBOOKS" });
assert.equal(Object.keys(resetState.state.inventory).length, 0);
assert.equal(Object.keys(resetState.state.catalogue).length, 5);

await dispatch({ type: "CLEAR_STATE" });
const preservedState = await dispatch({ type: "GET_GUIDEBOOKS" });
assert.equal(Object.keys(preservedState.state.catalogue).length, 5);

// —— 开局继承导本（真实抓包的接口和顺序）：候选不算持有，确认后只记选中的 ——
{
  const send = (url, body, requestBody) =>
    dispatch({ type: "API_CAPTURED", payload: { url, method: requestBody ? "POST" : "GET", status: 200, body, requestBody } });
  const base = "https://game.granbluefantasy.jp/rest/arcarum3/dungeon";
  const mapUrl = "https://game.granbluefantasy.jp/arcarum3/dungeon/content/index/0?_=1";
  const waitingMap = {
    option: {
      dungeon: {
        name: "test",
        carryover_select_num_max: 1,
        carryover_select_num_min: 1,
        dungeon_status: 9,
        current_node_id: 1,
        total_turn: 0,
        node_list: [{ node_id: 1, node_type: 0, position_x: 0, position_y: 0, adjacent_node_ids: [] }],
      },
    },
  };
  await send("https://game.granbluefantasy.jp/rest/arcarum3/start_dungeon", { redirect_scene: null }, JSON.stringify({ dungeon_id: 1 }));
  await send(mapUrl, waitingMap);
  await send(`${base}/spacebook_status_list?filter_type=4&_=1&t=2`, {
    status_list: [
      { name: "ダメージ上限UP(10%)", status_id: 7, icon_category: 1, icon_type: 308, rarity: 1, num: 1 },
      { name: "背水", status_id: 10, icon_category: 1, icon_type: 4, rarity: 1, num: 1 },
    ],
  });
  let inherit = (await dispatch({ type: "GET_GUIDEBOOKS" })).state;
  assert.deepEqual(inherit.inventory, {}, "继承候选不进持有");
  assert.equal(inherit.activeSelection.source, "inherit");
  assert.equal(inherit.activeSelection.selectNumMax, 1);

  // 选好后游戏先回地图，再发确认
  await send(mapUrl, waitingMap);
  const confirmed = await send(
    `${base}/carryover_spacebook_status`,
    {
      action_scenario_list: [{ action_type: 400, scenario_type: 3, status_list: [{ name: "背水", status_id: 10, rarity: 1 }] }],
      dungeon_status: 2,
      total_turn: 0,
    },
    JSON.stringify({ special_token: null, status_ids: [10] }),
  );
  assert.equal(confirmed.kind, "guidebook_add");
  inherit = (await dispatch({ type: "GET_GUIDEBOOKS" })).state;
  assert.deepEqual(Object.keys(inherit.inventory), ["10"], "只记选中的那本");
  assert.equal(inherit.inventory[10].num, 1);
  assert.equal(inherit.activeSelection, null);
}

console.log("background guidebooks: all assertions passed");
