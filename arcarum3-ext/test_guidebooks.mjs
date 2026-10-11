import assert from "node:assert/strict";
import {
  GUIDEBOOK_STATE_VERSION,
  clearGuidebookSelection,
  createGuidebookState,
  listGuidebooks,
  mergeIncidentDatabases,
  serializeIncidentDatabase,
  updateGuidebookState,
} from "./shared/guidebooks.js";
import { normalizePlayerText } from "./shared/playerText.js";

const migratedResult = updateGuidebookState(
  {
    version: 1,
    catalogue: {
      "7": {
        statusId: 7,
        rawName: "Old text",
        rawNames: ["Old text"],
      },
    },
    inventory: {},
    shopLineup: {},
  },
  {},
  { url: "https://example.invalid/noop", now: 1 },
);
assert.equal(migratedResult.state.version, GUIDEBOOK_STATE_VERSION);
assert.equal(migratedResult.state.catalogue[7].text.en, "Old text");
assert.deepEqual(migratedResult.state.catalogue[7].observedTexts, [
  { language: "en", text: "Old text" },
]);

const liveSelectionFixture = {
  action_scenario_list: [
    {
      action_type: 401,
      scenario_type: 3,
      candidate_num: 3,
      select_num_min: 1,
      select_num_max: 1,
      status_list: [
        {
          status_id: 86,
          name: "候補@@導本86",
          rarity: 3,
          icon_category: 1,
          icon_type: 310,
        },
        {
          status_id: 63,
          name: "候補@@導本63",
          rarity: 2,
          icon_category: 3,
          icon_type: 401,
        },
        {
          status_id: 60,
          name: "候補@@導本60",
          rarity: 2,
          icon_category: 3,
          icon_type: 401,
        },
      ],
    },
  ],
};

const liveSelectionResult = updateGuidebookState(null, liveSelectionFixture, {
  url: "https://game.granbluefantasy.jp/rest/arcarum3/dungeon/proceed_node_event",
  now: 10,
  language: "ja",
});
assert.deepEqual(liveSelectionResult.state.activeSelection, {
  scenarioType: 3,
  candidateNum: 3,
  selectNumMin: 1,
  selectNumMax: 1,
  candidates: [
    {
      statusId: 86,
      rawName: "候補@@導本86",
      rarity: 3,
      iconCategory: 1,
      iconType: 310,
    },
    {
      statusId: 63,
      rawName: "候補@@導本63",
      rarity: 2,
      iconCategory: 3,
      iconType: 401,
    },
    {
      statusId: 60,
      rawName: "候補@@導本60",
      rarity: 2,
      iconCategory: 3,
      iconType: 401,
    },
  ],
  capturedAt: 10,
  source: "node_event",
});
assert.deepEqual(
  Object.keys(liveSelectionResult.state.catalogue),
  ["60", "63", "86"],
  "401 候选应进入历史目录",
);
assert.deepEqual(
  liveSelectionResult.state.activeSelection.candidates.map((entry) => entry.statusId),
  [86, 63, 60],
  "候选顺序必须与接口一致",
);
assert.equal(Object.keys(liveSelectionResult.state.inventory).length, 0);

const incidentFixture = {
  node_type: 5,
  action_scenario_list: [
    {
      scenario_type: 1,
      text: "宁静は淡い光を放つ空間に辿り着いた。<br>壁面には煌びやかな鉱脈が走っている。",
      image: "common_486.jpg",
    },
    {
      scenario_type: 2,
      choice_ids: [
        {
          choice_id: 10110101,
          title: "鉱石を掘る",
          text: "味方全体HP-25%、セフィラコイン+250<br>「ルボルライト」を獲得",
          is_disabled: false,
          is_quest_check: false,
          turn: 1,
        },
        {
          choice_id: 10110102,
          title: "落ちている<br>鉱石を拾う",
          text: "セフィラコイン+100",
          is_disabled: false,
          is_quest_check: false,
          turn: 1,
        },
      ],
    },
  ],
};

const incidentResult = updateGuidebookState(
  liveSelectionResult.state,
  incidentFixture,
  {
    url: "https://game.granbluefantasy.jp/rest/arcarum3/dungeon/proceed_node_event",
    now: 11,
    language: "ja",
  },
);
assert.equal(incidentResult.state.activeSelection, null);
assert.deepEqual(incidentResult.state.activeIncident, {
  selectionId: 101101,
  specialIncidentId: null,
  nodeType: 5,
  eventKind: "normal",
  description: normalizePlayerText(incidentFixture.action_scenario_list[0].text),
  image: "common_486.jpg",
  options: incidentFixture.action_scenario_list[1].choice_ids.map((option) => ({
    choiceId: option.choice_id,
    title: option.title,
    text: option.text,
    turn: option.turn,
    disabled: option.is_disabled,
    questCheck: option.is_quest_check,
  })),
  capturedAt: 11,
  source: "node_event",
});
const incidentDatabase = serializeIncidentDatabase(incidentResult.state);
assert.deepEqual(Object.keys(incidentDatabase.entries), ["101101"]);
assert.equal(
  incidentDatabase.entries[101101].options[10110101].title.ja,
  "鉱石を掘る",
);
assert.equal(
  incidentDatabase.entries[101101].options[10110101].text.ja,
  "味方全体HP-25%、セフィラコイン+250<br>「ルボルライト」を獲得",
);
assert.equal(
  incidentDatabase.entries[101101].description.ja,
  normalizePlayerText(incidentFixture.action_scenario_list[0].text),
);

const incidentWithGenericLeave = updateGuidebookState(
  incidentResult.state,
  {
    node_type: 5,
    action_scenario_list: [
      { scenario_type: 1, text: "転移装置を見つけた。", image: "bg_48.jpg" },
      {
        scenario_type: 2,
        choice_ids: [
          { choice_id: 10080101, title: "入る", text: "宝箱マスへ転移する", turn: 1 },
          { choice_id: 1, title: "立ち去る", text: "探索に戻る" },
        ],
      },
    ],
  },
  {
    url: "https://game.granbluefantasy.jp/rest/arcarum3/dungeon/proceed_node_event",
    now: 12,
    language: "ja",
  },
);
assert.ok(incidentWithGenericLeave.state.incidentCatalogue[100801]);
assert.equal(
  incidentWithGenericLeave.state.incidentCatalogue[100801].options[1].choiceId,
  1,
);
assert.equal(
  Object.keys(incidentWithGenericLeave.state.incidentCatalogue).some((key) =>
    key.startsWith("choices:")),
  false,
);

const specialNodeContextResult = updateGuidebookState(
  {
    ...createGuidebookState(),
    incidentCatalogue: {
      "special:16": {
        selectionId: null,
        specialIncidentId: 16,
        nodeType: 10,
        eventKind: "special",
        notes: { "zh-CN": "" },
        name: { "zh-CN": "洞窟", ja: "洞窟", en: "Cave" },
        enumKey: "CAVE",
        group: "地点特殊",
        tips: ["多阶段探索事件", "具有金色地点底图"],
        image: "",
        description: {
          "zh-CN": "最多探索5次，每次可能遇到奖励或战斗；持有特定血液道具时可引出特定魔物。",
        },
        observedDescriptions: [],
        options: {},
        sources: ["special-incident-meta"],
        firstSeenAt: null,
        lastSeenAt: null,
      },
    },
  },
  {
    option: {
      dungeon: {
        current_node_id: 17,
        node_list: [
          {
            node_id: 17,
            node_type: 10,
            special_incident_id: 16,
          },
        ],
      },
    },
  },
  {
    url: "https://game.granbluefantasy.jp/arcarum3/dungeon/content/index/0",
    now: 20,
  },
);
assert.equal(specialNodeContextResult.state.currentSpecialIncidentId, 16);

const specialIncidentResult = updateGuidebookState(
  specialNodeContextResult.state,
  {
    node_type: 10,
    action_scenario_list: [
      {
        scenario_type: 1,
        text: "山を貫く長い洞窟が、目の前に口を開けている。",
        image: "common_40.jpg",
      },
      {
        scenario_type: 2,
        choice_ids: [
          {
            choice_id: 10501601,
            title: "洞窟に入る",
            text: "危険を顧みず洞窟を探索する<br>10%：味方全体のHP-10％",
            turn: 1,
            is_disabled: false,
            is_quest_check: false,
          },
          {
            choice_id: 10501602,
            title: "アイテムを<br>使用する",
            text: "一部の魔物が嫌う「異臭漂う生血」を<br>使いながら探索する",
            turn: 1,
            is_disabled: true,
            is_quest_check: false,
          },
          {
            choice_id: 10501603,
            title: "引き返す",
            text: "洞窟を出る",
            turn: null,
            is_disabled: false,
            is_quest_check: false,
          },
        ],
      },
    ],
  },
  {
    url: "https://game.granbluefantasy.jp/rest/arcarum3/dungeon/proceed_node_event",
    now: 21,
    language: "ja",
  },
);
assert.equal(specialIncidentResult.state.activeIncident.specialIncidentId, 16);
assert.equal(specialIncidentResult.state.activeIncident.eventKind, "special");
assert.equal(
  specialIncidentResult.state.incidentCatalogue["special:16"].options[10501601].title.ja,
  "洞窟に入る",
);
assert.equal(
  specialIncidentResult.state.incidentCatalogue["special:16"].description.ja,
  "山を貫く長い洞窟が、目の前に口を開けている。",
);
assert.deepEqual(
  specialIncidentResult.state.incidentCatalogue["special:16"].observedDescriptions,
  [{ language: "ja", text: "山を貫く長い洞窟が、目の前に口を開けている。" }],
);
assert.equal(
  specialIncidentResult.state.incidentCatalogue["special:16"].eventKind,
  "special",
);
assert.equal(
  specialIncidentResult.state.incidentCatalogue["special:16"].name["zh-CN"],
  "洞窟",
  "捕获特殊事件选项不能覆盖已有特殊事件元数据",
);
assert.equal(
  specialIncidentResult.state.incidentCatalogue[105016],
  undefined,
  "特殊事件不能按普通 choice_id 前缀另建一组",
);

const normalizedIncidentDatabase = mergeIncidentDatabases([
  {
    schemaVersion: 1,
    updatedAt: "2026-07-30T14:24:52.407Z",
    entries: {
      "choices:10080101-1": {
        selectionId: null,
        eventKind: "normal",
        notes: { "zh-CN": "优先前往宝箱较多的一侧。" },
        options: {
          "1": { choiceId: 1, title: { ja: "立ち去る" } },
          "10080101": { choiceId: 10080101, title: { ja: "入る" } },
        },
      },
    },
  },
  {
    schemaVersion: 1,
    updatedAt: "2026-07-30T15:24:52.407Z",
    entries: {
      "100801": {
        selectionId: 100801,
        notes: { "zh-CN": "" },
        options: {},
      },
    },
  },
]);
assert.deepEqual(Object.keys(normalizedIncidentDatabase.entries), ["100801"]);
assert.equal(normalizedIncidentDatabase.entries[100801].selectionId, 100801);
assert.equal(normalizedIncidentDatabase.entries[100801].options[1].choiceId, 1);
assert.equal(normalizedIncidentDatabase.entries[100801].eventKind, "normal");
assert.equal(
  normalizedIncidentDatabase.entries[100801].notes["zh-CN"],
  "优先前往宝箱较多的一侧。",
);

const normalizedSpecialIncidentDatabase = mergeIncidentDatabases([
  {
    schemaVersion: 1,
    updatedAt: "2026-08-01T15:02:10.716Z",
    entries: {
      "special:9": {
        selectionId: null,
        specialIncidentId: 9,
        nodeType: 10,
        eventKind: "special",
        name: { "zh-CN": "时停塔", ja: "時計塔" },
        notes: { "zh-CN": "" },
        description: { "zh-CN": "进入不计入缩圈时间的四连战。" },
        options: {},
      },
      "105007": {
        selectionId: 105007,
        specialIncidentId: null,
        nodeType: 10,
        eventKind: "normal",
        description: { ja: "動かぬ時の中で、魔術師たちが術式を展開する。" },
        options: {
          "10500701": {
            choiceId: 10500701,
            title: { ja: "塔を上る" },
            text: { ja: "時の止まった空間で敵と戦闘" },
          },
        },
      },
    },
  },
]);
assert.deepEqual(Object.keys(normalizedSpecialIncidentDatabase.entries), ["special:9"]);
assert.equal(normalizedSpecialIncidentDatabase.entries["special:9"].eventKind, "special");
assert.equal(normalizedSpecialIncidentDatabase.entries["special:9"].selectionId, null);
assert.equal(normalizedSpecialIncidentDatabase.entries["special:9"].specialIncidentId, 9);
assert.equal(
  normalizedSpecialIncidentDatabase.entries["special:9"].options[10500701].title.ja,
  "塔を上る",
);

const incidentCompletedResult = updateGuidebookState(
  incidentResult.state,
  { node_type: 5, action_scenario_list: [{ scenario_type: 3, action_type: 500 }] },
  {
    url: "https://game.granbluefantasy.jp/rest/arcarum3/dungeon/incident_choose",
    requestBody: JSON.stringify({ choice_id: 10110102 }),
    now: 12,
  },
);
assert.equal(
  incidentCompletedResult.state.activeIncident,
  null,
  "事件选择完成且没有后续选项时应清除快照",
);

const preservedSelectionResult = updateGuidebookState(
  liveSelectionResult.state,
  {},
  { url: "https://example.invalid/unrelated", now: 11 },
);
assert.deepEqual(
  preservedSelectionResult.state.activeSelection,
  liveSelectionResult.state.activeSelection,
  "无关请求不能清除实时选择",
);

const replacedSelectionResult = updateGuidebookState(
  preservedSelectionResult.state,
  {
    action_scenario_list: [
      {
        action_type: 401,
        scenario_type: 3,
        candidate_num: 1,
        select_num_min: 1,
        select_num_max: 1,
        status_list: [{ status_id: 63, name: "新的候補", rarity: 2 }],
      },
    ],
  },
  {
    url: "https://game.granbluefantasy.jp/rest/arcarum3/dungeon/move_node",
    now: 12,
    language: "ja",
  },
);
assert.deepEqual(
  replacedSelectionResult.state.activeSelection.candidates.map((entry) => entry.statusId),
  [63],
  "后续 401 应替换旧候选",
);

const confirmedSelectionResult = updateGuidebookState(
  replacedSelectionResult.state,
  liveSelectionFixture,
  {
    url: "https://game.granbluefantasy.jp/rest/arcarum3/dungeon/proceed_node_event_spacebook_status_add",
    requestBody: JSON.stringify({ status_ids: [63] }),
    now: 13,
  },
);
assert.equal(confirmedSelectionResult.state.activeSelection, null);
assert.equal(
  confirmedSelectionResult.state.inventory[63].num,
  1,
  "确认选择应在同一次更新中写入库存",
);

const restartedSelectionResult = updateGuidebookState(
  liveSelectionResult.state,
  {},
  {
    url: "https://game.granbluefantasy.jp/rest/arcarum3/start_dungeon",
    now: 14,
  },
);
assert.equal(restartedSelectionResult.state.activeSelection, null);
assert.equal(restartedSelectionResult.state.activeIncident, null);

const manuallyClearedResult = clearGuidebookSelection(liveSelectionResult.state);
assert.equal(manuallyClearedResult.changed, true);
assert.equal(manuallyClearedResult.state.activeSelection, null);
assert.deepEqual(
  manuallyClearedResult.state.catalogue,
  liveSelectionResult.state.catalogue,
  "手动清除不能影响历史目录",
);
const repeatedClearResult = clearGuidebookSelection(manuallyClearedResult.state);
assert.equal(repeatedClearResult.changed, false);

const manuallyClearedIncident = clearGuidebookSelection(incidentResult.state);
assert.equal(manuallyClearedIncident.changed, true);
assert.equal(manuallyClearedIncident.state.activeIncident, null);

const collidingStatusResult = updateGuidebookState(
  null,
  {
    weapon_skill: { status_id: 21, name: "攻刃" },
    unrelated_status: { status_id: 249, name: "攻刃" },
    action_scenario_list: [
      {
        action_type: 401,
        status_list: [
          {
            status_id: 21,
            name: "アビリティ与ダメージUP(30%)",
            rarity: 2,
            icon_category: 1,
            icon_type: 312,
          },
        ],
      },
    ],
  },
  {
    url: "https://game.granbluefantasy.jp/rest/arcarum3/dungeon/incident_choose",
    now: 1,
    language: "ja",
  },
);
assert.equal(
  collidingStatusResult.state.catalogue[21].text.ja,
  "アビリティ与ダメージUP(30%)",
  "导本动作外的同名 status_id 不能抢占导本文本",
);
assert.equal(
  collidingStatusResult.state.catalogue[249],
  undefined,
  "响应中的非导本 status_id 不能进入目录",
);

const migratedPollutionResult = updateGuidebookState(
  {
    ...createGuidebookState(),
    version: 3,
    catalogue: Object.fromEntries(
      [192, 202, 244, 249, 254, 259, 274, 279, 304, 309].map((statusId) => [
        statusId,
        {
          statusId,
          rawName: "错误短标签",
          text: { "zh-CN": "", ja: "错误短标签", en: "" },
          rarity: null,
          iconCategory: null,
          iconType: null,
        },
      ]),
    ),
  },
  {},
  { url: "https://game.granbluefantasy.jp/rest/arcarum3/dungeon/move_node", now: 2 },
);
assert.deepEqual(
  Object.keys(migratedPollutionResult.state.catalogue),
  [],
  "旧版本误收且没有导本元数据的跨域状态应在迁移时清除",
);

const migratedCollidingTextResult = updateGuidebookState(
  {
    ...createGuidebookState(),
    version: 3,
    catalogue: {
      21: {
        statusId: 21,
        rawName: "攻刃",
        rawNames: ["攻刃", "アビリティ与ダメージUP(30%)"],
        text: { "zh-CN": "攻刃", ja: "攻刃", en: "" },
        observedTexts: [
          { language: "ja", text: "攻刃" },
          { language: "ja", text: "アビリティ与ダメージUP(30%)" },
        ],
        rarity: 2,
        iconCategory: 1,
        iconType: 312,
      },
      50: {
        statusId: 50,
        rawName: "「太極の陰陽」習得",
        rawNames: [
          "「太極の陰陽」習得",
          "味方全体がダメージアビリティ使用時、敵の現HPに応じた無属性ダメージ",
        ],
        text: { "zh-CN": "习得「太极之阴阳」", ja: "「太極の陰陽」習得", en: "" },
        observedTexts: [
          { language: "ja", text: "「太極の陰陽」習得" },
          {
            language: "ja",
            text: "味方全体がダメージアビリティ使用時、敵の現HPに応じた無属性ダメージ",
          },
        ],
        rarity: 2,
        iconCategory: 1,
        iconType: 401,
      },
    },
  },
  {},
  { url: "https://game.granbluefantasy.jp/rest/arcarum3/dungeon/move_node", now: 3 },
);
assert.equal(
  migratedCollidingTextResult.state.catalogue[21].text.ja,
  "アビリティ与ダメージUP(30%)",
);
assert.equal(migratedCollidingTextResult.state.catalogue[21].text["zh-CN"], "");
assert.deepEqual(migratedCollidingTextResult.state.catalogue[21].observedTexts, [
  { language: "ja", text: "アビリティ与ダメージUP(30%)" },
]);
assert.deepEqual(migratedCollidingTextResult.state.catalogue[50].observedTexts, [
  {
    language: "ja",
    text: "味方全体がダメージアビリティ使用時、敵の現HPに応じた無属性ダメージ",
  },
]);
assert.equal(
  migratedCollidingTextResult.state.catalogue[50].text.ja,
  "味方全体がダメージアビリティ使用時、敵の現HPに応じた無属性ダメージ",
);

const localizedResult = updateGuidebookState(
  null,
  {
    action_scenario_list: [
      {
        action_type: 401,
        status_list: [{ status_id: 8, name: "攻撃力が上昇" }],
      },
    ],
  },
  {
    url: "https://game.granbluefantasy.jp/rest/arcarum3/dungeon/incident_choose",
    now: 2,
    language: "ja",
  },
);
assert.equal(localizedResult.state.catalogue[8].text.ja, "攻撃力が上昇");
assert.deepEqual(localizedResult.state.catalogue[8].observedTexts, [
  { language: "ja", text: "攻撃力が上昇" },
]);
assert.equal(localizedResult.catalogueChanged, true);
assert.equal(localizedResult.state.inventory[8], undefined);

const repeatedResult = updateGuidebookState(
  localizedResult.state,
  {
    action_scenario_list: [
      {
        action_type: 401,
        status_list: [{ status_id: 8, name: "攻撃力が上昇" }],
      },
    ],
  },
  {
    url: "https://game.granbluefantasy.jp/rest/arcarum3/dungeon/incident_choose",
    now: 3,
    language: "ja",
  },
);
assert.equal(repeatedResult.changed, true, "最后看到时间仍应更新");
assert.equal(repeatedResult.catalogueChanged, false, "重复原文不能触发数据库导出");

const unresolvedResult = updateGuidebookState(
  repeatedResult.state,
  {
    action_scenario_list: [
      {
        action_type: 401,
        status_list: [{ name: "Unknown candidate" }],
      },
    ],
  },
  {
    url: "https://game.granbluefantasy.jp/rest/arcarum3/dungeon/incident_choose",
    now: 4,
    language: "en",
  },
);
assert.equal(unresolvedResult.state.unresolved[0].text, "Unknown candidate");
assert.equal(unresolvedResult.state.unresolved[0].language, "en");
assert.equal(unresolvedResult.catalogueChanged, true);

const resolvedResult = updateGuidebookState(
  unresolvedResult.state,
  {
    action_scenario_list: [
      {
        action_type: 401,
        status_list: [{ status_id: 9, name: "Unknown candidate" }],
      },
    ],
  },
  {
    url: "https://game.granbluefantasy.jp/rest/arcarum3/dungeon/incident_choose",
    now: 5,
    language: "en",
  },
);
assert.equal(resolvedResult.state.unresolved.length, 0);
assert.equal(resolvedResult.state.catalogue[9].text.en, "Unknown candidate");

const unresolvedKanji = updateGuidebookState(
  null,
  {
    action_scenario_list: [
      { action_type: 401, status_list: [{ name: "攻撃力上昇" }] },
    ],
  },
  {
    url: "https://game.granbluefantasy.jp/rest/arcarum3/dungeon/incident_choose",
    now: 6,
    language: "ja",
  },
);
const resolvedKanji = updateGuidebookState(
  unresolvedKanji.state,
  {
    action_scenario_list: [
      { action_type: 401, status_list: [{ status_id: 10, name: "攻撃力上昇" }] },
    ],
  },
  {
    url: "https://game.granbluefantasy.jp/rest/arcarum3/dungeon/incident_choose",
    now: 7,
  },
);
assert.equal(resolvedKanji.state.catalogue[10].text.ja, "攻撃力上昇");
assert.equal(resolvedKanji.state.unresolved.length, 0);

let state = createGuidebookState();

({ state } = updateGuidebookState(
  state,
  {
    status_list: [
      {
        status_id: 101,
        name: "原文@@导本A",
        rarity: 3,
        icon_category: 2,
        icon_type: 7,
        num: 2,
      },
      { status_id: 102, name: "原文導本B", rarity: 1, num: 1 },
    ],
  },
  {
    url: "https://game.granbluefantasy.jp/rest/arcarum3/dungeon/spacebook_status_list",
    now: 1000,
  },
));

assert.equal(state.catalogue[101].rawName, "原文@@导本A");
assert.deepEqual(state.catalogue[101].rawNames, ["原文@@导本A"]);
assert.equal(state.inventory[101].num, 2);
assert.equal(listGuidebooks(state, { inventoryOnly: true }).length, 2);

({ state } = updateGuidebookState(
  state,
  {
    action_scenario_list: [
      {
        action_type: 401,
        status_list: [{ status_id: 103, name: "候補C", rarity: 2 }],
      },
    ],
  },
  { url: "https://game.granbluefantasy.jp/rest/arcarum3/dungeon/move_node", now: 2000 },
));
assert.equal(state.catalogue[103].rawName, "候補C");
assert.equal(state.inventory[103], undefined);

({ state } = updateGuidebookState(
  state,
  {
    action_scenario_list: [
      {
        action_type: 400,
        status_list: [{ status_id: 103, name: "候補C", rarity: 2 }],
      },
    ],
  },
  { url: "https://game.granbluefantasy.jp/rest/arcarum3/dungeon/move_node", now: 3000 },
));
assert.equal(state.inventory[103].num, 1);

({ state } = updateGuidebookState(
  state,
  {
    action_scenario_list: [
      {
        action_type: 400,
        status_list: [{ status_id: 103, name: "候補C", rarity: 2 }],
      },
    ],
  },
  {
    url: "https://game.granbluefantasy.jp/rest/arcarum3/dungeon/proceed_node_event_spacebook_status_add",
    requestBody: JSON.stringify({ status_ids: [103] }),
    now: 4000,
  },
));
assert.equal(state.inventory[103].num, 2, "同一获得响应不能重复计数");

({ state } = updateGuidebookState(
  state,
  {
    action_scenario_list: [
      {
        action_type: 402,
        status_list: [{ status_id: 103, name: "候補C", rarity: 2 }],
      },
    ],
  },
  { url: "https://game.granbluefantasy.jp/rest/arcarum3/dungeon/proceed_node_event_spacebook_status_remove", now: 5000 },
));
assert.equal(state.inventory[103].num, 1);

({ state } = updateGuidebookState(
  state,
  {
    item_list: [
      {
        lineup_id: 55,
        status_id: 104,
        name: "商店D",
        rarity: 99,
        icon_category: 1,
        icon_type: 4,
      },
    ],
  },
  { url: "https://game.granbluefantasy.jp/rest/arcarum3/dungeon/dungeon_shop_lineup/1", now: 6000 },
));
assert.equal(state.shopLineup[55], 104);
assert.equal(state.catalogue[104].rawName, "商店D");
assert.equal(state.activeShop.tabId, 1);
assert.deepEqual(state.activeShop.items, [
  {
    lineupId: 55,
    itemType: "",
    statusId: 104,
    rawName: "商店D",
    rawComment: "商店D",
    itemImage: "",
    price: null,
    stockNum: null,
    canPurchase: false,
    rarity: 99,
    iconCategory: 1,
    iconType: 4,
  },
]);

({ state } = updateGuidebookState(
  state,
  {
    item_list: [
      {
        lineup_id: 9,
        item_type: "6",
        item_name: "導本効果削除",
        item_comment: "導本効果を1つ選んで消失させる。",
        price: 100,
        stock_num: 1,
        can_purchase: true,
      },
    ],
  },
  { url: "https://game.granbluefantasy.jp/rest/arcarum3/dungeon/dungeon_shop_lineup/1", now: 6500 },
));
assert.equal(state.activeShop.items[0].rawName, "導本効果削除");
assert.equal(state.activeShop.items[0].rawComment, "導本効果を1つ選んで消失させる。");
assert.equal(state.activeShop.items[0].itemType, "6");
assert.equal(state.activeShop.items[0].price, 100);
assert.equal(state.activeShop.items[0].stockNum, 1);
assert.equal(state.activeShop.items[0].canPurchase, true);

({ state } = updateGuidebookState(
  state,
  {
    item_list: [
      {
        lineup_id: 8,
        item_type: "5",
        item_name: "ルボルライト",
        item_comment: "内側から溢れんばかりの<br>見慣れぬ赤い輝きを放つ希少な一塊。",
        item_image: "dungeon_item_01",
        price: 100,
        stock_num: 1,
        can_purchase: true,
      },
      {
        lineup_id: 1,
        item_type: "1",
        item_name: "ウェポン・スクロール",
        item_comment: "摂理の異なる世界飛沫へ入った際に<br>封印された武器を解放するための巻物。",
        item_image: "scroll_01",
        price: 200,
        stock_num: 0,
        can_purchase: false,
      },
    ],
  },
  { url: "https://game.granbluefantasy.jp/rest/arcarum3/dungeon/dungeon_shop_lineup/2", now: 6600 },
));
assert.equal(state.activeShop.tabId, 2);
assert.equal(state.activeShop.items.length, 2);
assert.equal(state.activeShop.items[0].rawName, "ルボルライト");
assert.equal(state.activeShop.items[0].itemImage, "dungeon_item_01");
assert.equal(state.activeShop.items[1].stockNum, 0);
assert.equal(state.activeShop.items[1].canPurchase, false);

({ state } = updateGuidebookState(
  state,
  {},
  {
    url: "https://game.granbluefantasy.jp/rest/arcarum3/dungeon/dungeon_shop_lineup/1",
    now: 6900,
  },
));
({ state } = updateGuidebookState(
  state,
  {
    item_list: [
      {
        lineup_id: 55,
        item_type: "4",
        status_id: 104,
        name: "商店D",
        rarity: 99,
        icon_category: 1,
        icon_type: 4,
        price: 50,
        stock_num: 1,
        can_purchase: true,
      },
    ],
  },
  {
    url: "https://game.granbluefantasy.jp/rest/arcarum3/dungeon/dungeon_shop_lineup/1",
    now: 6950,
  },
));
({ state } = updateGuidebookState(
  state,
  {},
  {
    url: "https://game.granbluefantasy.jp/rest/arcarum3/dungeon/purchase_dungeon_shop_item",
    requestBody: "lineup_id=55",
    now: 7000,
  },
));
assert.equal(state.inventory[104].num, 1);
assert.equal(state.activeShop.items[0].stockNum, 0);
assert.equal(state.activeShop.items[0].canPurchase, false);

({ state } = updateGuidebookState(
  state,
  { option: { dungeon: { current_node_id: 1, node_list: [] } } },
  {
    url: "https://game.granbluefantasy.jp/arcarum3/dungeon/content/index/0",
    now: 7100,
  },
));
assert.equal(
  state.activeShop,
  null,
  "退出商店回到地图页后，左侧商店快照应消失",
);
assert.equal(
  state.shopLineup[55],
  104,
  "退出商店只清除左侧快照，不应丢失购买映射",
);

({ state } = updateGuidebookState(
  state,
  { status_list: [{ status_id: 101, name: "原文导本A改", rarity: 3, num: 1 }] },
  {
    url: "https://game.granbluefantasy.jp/rest/arcarum3/dungeon/spacebook_status_list",
    now: 8000,
  },
));
assert.deepEqual(state.catalogue[101].rawNames, ["原文@@导本A", "原文导本A改"]);
assert.equal(state.inventory[101].num, 1);
assert.equal(Object.keys(state.inventory).length, 1, "权威列表应替换当前持有状态");

({ state } = updateGuidebookState(
  state,
  {},
  { url: "https://game.granbluefantasy.jp/rest/arcarum3/start_dungeon", now: 9000 },
));
assert.equal(Object.keys(state.inventory).length, 0);
assert.equal(Object.keys(state.catalogue).length, 4, "开新局不能清空历史收录");

({ state } = updateGuidebookState(
  state,
  {
    option: {
      result_data: {
        arcarum3: {
          reward_list: [
            { reward_type: 1, detail: [{ status_id: 999 }] },
            {
              reward_type: 4,
              detail: [{ status_id: 105, name: "战斗奖励E", rarity: 2 }],
            },
          ],
        },
      },
    },
  },
  { url: "https://game.granbluefantasy.jp/result/content/index/1", now: 10000 },
));
assert.equal(state.catalogue[105].rawName, "战斗奖励E");
assert.equal(state.inventory[105].num, 1);
assert.equal(state.catalogue[999], undefined, "非导本奖励不能进入目录");

({ state } = updateGuidebookState(
  state,
  {
    option: {
      status_list: [
        {
          user_status_id: 8001,
          status_id: 201,
          name: "既有导本A",
          rarity: 3,
          icon_category: 1,
          icon_type: 5,
        },
        {
          user_status_id: 8002,
          status_id: 201,
          name: "既有导本A",
          rarity: 3,
          icon_category: 1,
          icon_type: 5,
        },
        {
          user_status_id: 8003,
          status_id: 202,
          name: "既有导本B",
          rarity: 1,
          icon_category: 2,
          icon_type: 7,
        },
      ],
    },
  },
  {
    url: "https://game.granbluefantasy.jp/arcarum3/book/content/index",
    now: 11000,
  },
));
assert.equal(state.inventory[201].num, 2, "导本页应按持有实例聚合数量");
assert.equal(state.inventory[202].num, 1);
assert.equal(Object.keys(state.inventory).length, 2, "导本页应替换当前持有状态");

// —— 开局「从上一局继承导本」：候选列表不是持有（真实抓包：filter_type=4，每项都带 num） ——
{
  const inheritResponse = {
    status_list: [
      { name: "ダメージ上限UP(10%)", target_type: null, target_param: "", display_ailment_id: null, status_id: 7, icon_category: 1, icon_type: 308, rarity: 1, is_duplication_possible: 1, deck_condition: 0, num: 1 },
      { name: "背水", target_type: null, target_param: "", display_ailment_id: null, status_id: 10, icon_category: 1, icon_type: 4, rarity: 1, is_duplication_possible: 1, deck_condition: 0, num: 1 },
    ],
  };
  const listUrl = "https://game.granbluefantasy.jp/rest/arcarum3/dungeon/spacebook_status_list";
  let run = createGuidebookState();
  let result = updateGuidebookState(run, inheritResponse, {
    url: `${listUrl}?filter_type=4&_=1791705159127&t=1791705159481`,
    now: 100,
  });
  run = result.state;
  assert.equal(result.changed, true);
  assert.deepEqual(run.inventory, {}, "继承候选不能算进手里的导本");
  assert.deepEqual(Object.keys(run.catalogue).sort(), ["10", "7"], "候选照常收进图鉴");
  assert.deepEqual(run.activeSelection.candidates.map((item) => item.statusId), [7, 10], "候选显示在「本次选择」里");
  assert.equal(run.activeSelection.source, "inherit");

  // 选了「背水」并确认：只有选中的进入持有，候选清掉
  run = updateGuidebookState(run, {}, {
    url: "https://game.granbluefantasy.jp/rest/arcarum3/dungeon/proceed_node_event_spacebook_status_add",
    requestBody: JSON.stringify({ status_ids: [10] }),
    now: 200,
  }).state;
  assert.deepEqual(Object.keys(run.inventory), ["10"], "只有选中的那本进入持有");
  assert.equal(run.activeSelection, null);

  // 手里已经有导本时再看到继承候选：不影响已有的
  run = updateGuidebookState(run, inheritResponse, { url: `${listUrl}?filter_type=4`, now: 300 }).state;
  assert.deepEqual(Object.keys(run.inventory), ["10"]);
  assert.equal(run.inventory[10].num, 1);
  assert.ok(run.activeSelection);

  // 没确认就回到地图：候选不再显示，手里的不变
  run = updateGuidebookState(run, { option: {} }, {
    url: "https://game.granbluefantasy.jp/arcarum3/dungeon/content/index/0",
    now: 400,
  }).state;
  assert.equal(run.activeSelection, null, "回到地图后继承候选清掉");
  assert.deepEqual(Object.keys(run.inventory), ["10"]);

  // 地图里事件给的选择（401）不受「回到地图」影响
  run = updateGuidebookState(run, {
    action_scenario_list: [{ action_type: 401, status_list: [{ status_id: 7, name: "ダメージ上限UP(10%)", rarity: 1 }] }],
  }, { url: "https://game.granbluefantasy.jp/rest/arcarum3/dungeon/move_node", now: 500 }).state;
  run = updateGuidebookState(run, { option: {} }, {
    url: "https://game.granbluefantasy.jp/arcarum3/dungeon/content/index/0",
    now: 600,
  }).state;
  assert.ok(run.activeSelection, "事件的导本选择在刷新地图后仍保留");

  // 不带 filter_type、或别的 filter_type：仍然是持有列表，整体校正
  run = updateGuidebookState(run, inheritResponse, { url: `${listUrl}?filter_type=1`, now: 700 }).state;
  assert.deepEqual(Object.keys(run.inventory).sort(), ["10", "7"], "其他列表照旧按真实持有校正");
  run = updateGuidebookState(run, { status_list: [inheritResponse.status_list[0]] }, { url: listUrl, now: 800 }).state;
  assert.deepEqual(Object.keys(run.inventory), ["7"]);

  // —— 真实抓包的完整顺序：地图（等继承）→ 候选列表 → 又回地图 → 确认 → 地图 ——
  {
    const mapUrl = "https://game.granbluefantasy.jp/arcarum3/dungeon/content/index/0";
    const mapBody = (dungeonStatus) => ({
      option: {
        dungeon: {
          carryover_select_num_max: 1,
          carryover_select_num_min: 1,
          dungeon_status: dungeonStatus,
          total_turn: 0,
          node_list: [],
        },
      },
    });
    let flow = updateGuidebookState(createGuidebookState(), { redirect_scene: null }, {
      url: "https://game.granbluefantasy.jp/rest/arcarum3/start_dungeon",
      requestBody: JSON.stringify({ deck_id: 31032, difficulty: 0, dungeon_id: 1, special_token: null }),
      now: 10,
    }).state;
    flow = updateGuidebookState(flow, mapBody(9), { url: mapUrl, now: 20 }).state;
    assert.deepEqual(flow.carryoverSelect, { min: 1, max: 1 }, "记下这一局能继承几本");
    flow = updateGuidebookState(flow, { status_list: [inheritResponse.status_list[1]] }, {
      url: `${listUrl}?filter_type=4`,
      now: 30,
    }).state;
    assert.deepEqual(flow.inventory, {});
    assert.equal(flow.activeSelection.selectNumMax, 1, "候选带上能选几本");
    // 选好之后游戏先回到地图（还在等继承），候选不能在这里清掉
    flow = updateGuidebookState(flow, mapBody(9), { url: mapUrl, now: 40 }).state;
    assert.ok(flow.activeSelection, "还在等继承时回到地图，候选留着");
    // 确认：请求里是选中的编号，响应里是「获得」
    const confirmed = updateGuidebookState(
      flow,
      {
        action_scenario_list: [
          { action_type: 400, scenario_type: 3, status_list: [{ deck_condition: 0, icon_category: 1, icon_type: 4, is_duplication_possible: 1, name: "背水", rarity: 1, status_id: 10 }] },
        ],
        dungeon_status: 2,
        node_type: 0,
        total_turn: 0,
      },
      {
        url: "https://game.granbluefantasy.jp/rest/arcarum3/dungeon/carryover_spacebook_status",
        requestBody: JSON.stringify({ special_token: null, status_ids: [10] }),
        now: 50,
      },
    );
    flow = confirmed.state;
    assert.deepEqual(Object.keys(flow.inventory), ["10"], "继承确认后，选中的那本进入持有");
    assert.equal(flow.inventory[10].num, 1, "请求和响应说的是同一本，只算一次");
    assert.equal(flow.inventory[10].source, "gain");
    assert.equal(flow.activeSelection, null, "确认后候选清掉");
    // 之后的地图（正常探索）不影响持有
    flow = updateGuidebookState(flow, mapBody(2), { url: mapUrl, now: 60 }).state;
    assert.deepEqual(Object.keys(flow.inventory), ["10"]);

    // 一本都不继承：什么都不加
    let skipped = updateGuidebookState(createGuidebookState(), inheritResponse, { url: `${listUrl}?filter_type=4`, now: 30 }).state;
    skipped = updateGuidebookState(skipped, { action_scenario_list: [], dungeon_status: 2 }, {
      url: "https://game.granbluefantasy.jp/rest/arcarum3/dungeon/carryover_spacebook_status",
      requestBody: JSON.stringify({ special_token: null, status_ids: [] }),
      now: 50,
    }).state;
    assert.deepEqual(skipped.inventory, {});
    assert.equal(skipped.activeSelection, null);

    // 只有响应、读不到请求内容时：按响应里的「获得」加
    let byResponse = updateGuidebookState(createGuidebookState(), inheritResponse, { url: `${listUrl}?filter_type=4`, now: 30 }).state;
    byResponse = updateGuidebookState(
      byResponse,
      { action_scenario_list: [{ action_type: 400, status_list: [inheritResponse.status_list[0]] }] },
      { url: "https://game.granbluefantasy.jp/rest/arcarum3/dungeon/carryover_spacebook_status", now: 50 },
    ).state;
    assert.deepEqual(Object.keys(byResponse.inventory), ["7"]);

    // 没在等继承的地图（正常探索中）会清掉残留的候选
    let stale = updateGuidebookState(createGuidebookState(), inheritResponse, { url: `${listUrl}?filter_type=4`, now: 30 }).state;
    stale = updateGuidebookState(stale, mapBody(2), { url: mapUrl, now: 40 }).state;
    assert.equal(stale.activeSelection, null);
  }

  // filter_type 放在请求体里也认
  run = updateGuidebookState(createGuidebookState(), inheritResponse, {
    url: listUrl,
    requestBody: "filter_type=4",
    now: 900,
  }).state;
  assert.deepEqual(run.inventory, {});
}

console.log("guidebooks: all assertions passed");
