import {
  MSG,
  STORAGE_KEY,
  GUIDEBOOK_STORAGE_KEY,
  DECK_STORAGE_KEY,
  BATTLE_STORAGE_KEY,
  OMEN_STORAGE_KEY,
  PARTY_STORAGE_KEY,
  ENEMY_STORAGE_KEY,
  SHOP_STORAGE_KEY,
  CAPTURE_PATHS,
  PROFILE_CAPTURE_PATHS,
  GUIDEBOOK_CAPTURE_PATHS,
  DECK_CAPTURE_PATHS,
  BATTLE_CAPTURE_PATHS,
} from "./shared/constants.js";
import { resetBattleRecord, updateBattleState } from "./shared/battle.js";
import { captureDeck, createDeckState } from "./shared/deck.js";
import {
  clearGuidebookSelection,
  mergeIncidentDatabases,
  mergeGuidebookDatabaseIntoState,
  mergeIncidentDatabaseIntoState,
  resetGuidebookRun,
  updateGuidebookState,
} from "./shared/guidebooks.js";
import {
  mergeGuidebookDatabases,
  normalizeGuidebookDatabase,
} from "./shared/guidebookDatabase.js";
import {
  applyDungeonActions,
  extractDungeon,
  inferDay,
  isRunStart,
  mergeDungeonState,
} from "./shared/map-model.js";
import { createOmenLog, recordOmens } from "./shared/omens.js";
import { statusLogEntries } from "./shared/bossMechanics.js";
import { extractPartyStatus, extractScenarioParty } from "./shared/party.js";
import { createEnemyLog, recordKills, recordSightings } from "./shared/enemyLog.js";
import { createShopState, recordShopLineup, recordShopPurchase } from "./shared/shops.js";

/** @type {number|null} */
let mapWindowId = null;
let guidebookUpdateQueue = Promise.resolve();
let buildUpdateQueue = Promise.resolve();
let guidebookSeedPromise = null;
let incidentSeedPromise = null;
/** 刚收到 start_dungeon、还没等到这一局的第一张地图 */
let pendingRunStart = false;

// Open side panel on action click
chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: String(err) }));
  return true; // async
});

async function handleMessage(message, sender) {
  switch (message?.type) {
    case MSG.API_CAPTURED:
      return onApiCaptured(message.payload);
    case MSG.GET_STATE:
      return { ok: true, state: await getState() };
    case MSG.GET_GUIDEBOOKS:
      return { ok: true, state: await getGuidebooks() };
    case MSG.CLEAR_GUIDEBOOK_SELECTION:
      return clearActiveGuidebookSelection();
    case MSG.OPEN_MAP_WINDOW:
      return openMapWindow(message.options || {});
    case MSG.FOCUS_MAP_WINDOW:
      return focusMapWindow();
    case MSG.CLEAR_STATE:
      await chrome.storage.local.remove(STORAGE_KEY);
      broadcastState(null);
      return { ok: true };
    case MSG.GET_BUILD:
      return {
        ok: true,
        deck: await getDeckState(),
        battle: await getBattleState(),
        omens: await getOmenLog(),
        party: await getPartyState(),
        enemies: await getEnemyLog(),
        shops: await getShopState(),
      };
    case MSG.RESET_BATTLE_RECORD:
      return enqueueBuildUpdate(async () => {
        const result = resetBattleRecord(await getBattleState());
        if (result.changed) {
          await chrome.storage.local.set({ [BATTLE_STORAGE_KEY]: result.state });
        }
        return { ok: true, changed: result.changed, battle: result.state };
      });
    default:
      return { ok: false, error: "unknown message" };
  }
}

function matchCapture(url, patterns) {
  try {
    const path = new URL(url).pathname;
    return patterns.some((re) => re.test(path));
  } catch {
    return false;
  }
}

function classify(url) {
  const path = new URL(url).pathname;
  if (/\/socket\/query/i.test(path)) return "player_profile";
  if (/\/arcarum3\/book(?:\/|$)/i.test(path)) return "guidebook_page";
  if (/spacebook_status_list/i.test(path)) return "guidebook_list";
  if (/spacebook_status_add/i.test(path)) return "guidebook_add";
  if (/spacebook_status_remove/i.test(path)) return "guidebook_remove";
  if (/dungeon_shop_lineup/i.test(path)) return "guidebook_shop";
  if (/purchase_dungeon_shop_item/i.test(path)) return "guidebook_purchase";
  if (/\/result(?:multi)?\/content\/index/i.test(path)) return "battle_result";
  if (/content\/index/i.test(path)) return "map_index";
  if (/move_node/i.test(path)) return "move_node";
  if (/finish_node_event|proceed_node_event/i.test(path)) return "node_event";
  if (/start_dungeon/i.test(path)) return "start_dungeon";
  return "other";
}

async function onApiCaptured({
  url,
  body,
  requestBody,
  method,
  status,
  gameLanguage,
}) {
  const isMapCapture = url && matchCapture(url, CAPTURE_PATHS);
  const isProfileCapture = url && matchCapture(url, PROFILE_CAPTURE_PATHS);
  const isGuidebookCapture = url && matchCapture(url, GUIDEBOOK_CAPTURE_PATHS);
  const isDeckCapture = url && matchCapture(url, DECK_CAPTURE_PATHS);
  const isBattleCapture = url && matchCapture(url, BATTLE_CAPTURE_PATHS);
  if (
    !url ||
    (!isMapCapture && !isGuidebookCapture && !isProfileCapture && !isDeckCapture && !isBattleCapture)
  ) {
    return { ok: true, ignored: true };
  }

  let json = body;
  if (typeof body === "string") {
    try {
      json = JSON.parse(body);
    } catch {
      return { ok: true, ignored: true, reason: "not-json" };
    }
  }

  // 开新一局：上一局的战斗记录（攻击回合最高伤害等）、商店货架、队伍血量都不带过去
  // （导本由下面的导本处理在同一个响应里清掉）
  if (/\/rest\/arcarum3\/start_dungeon/i.test(url)) {
    await clearRunBuildState();
    pendingRunStart = true;
  }

  // 第 1 天第 1 回合的整张地图：新的一局。
  // 没抓到 start_dungeon（页面没加载完、在别处开的局）时靠这里发现，把上一局的状态全部清掉。
  // 抓到过 start_dungeon 的话那时已经清过，不再清第二遍；同一回合里刷新页面也不算。
  const freshMap = isMapCapture ? extractDungeon(json) : null;
  if (freshMap) {
    const announced = pendingRunStart;
    pendingRunStart = false;
    if (!announced && isRunStart(freshMap) && !isRunStart(await getState())) {
      await resetRunState();
    }
  }

  // 商店：记下所在格子的货架；买了东西就扣库存（导本的处理照常往下走）
  if (/\/rest\/arcarum3\/dungeon\/dungeon_shop_lineup\//i.test(url)) {
    await updateShopState(async (previous) =>
      recordShopLineup(previous, {
        nodeId: (await getState())?.current_node_id,
        tabId: Number(url.match(/dungeon_shop_lineup\/([^/?#]+)/i)?.[1]) || 0,
        response: json,
      }));
  }
  if (/\/rest\/arcarum3\/dungeon\/purchase_dungeon_shop_item/i.test(url)) {
    const lineupId = parseRequestField(requestBody, "lineup_id");
    await updateShopState(async (previous) =>
      recordShopPurchase(previous, { nodeId: (await getState())?.current_node_id, lineupId }));
  }

  // 地图上的队伍血量（不在战斗里时以它为准）
  if (/\/rest\/arcarum3\/dungeon\/party_status/i.test(url)) {
    const party = extractPartyStatus(json);
    if (party) {
      await chrome.storage.local.set({ [PARTY_STORAGE_KEY]: party });
      return { ok: true, kind: "party", members: party.members.length };
    }
  }

  // 移动、事件、选项之后的队伍血量：不用等玩家自己点开队伍状态
  if (/\/rest\/arcarum3\/dungeon\//i.test(url)) {
    const party = extractScenarioParty(json);
    if (party) await chrome.storage.local.set({ [PARTY_STORAGE_KEY]: party });
  }

  // 盘子按响应结构识别；同一个 arcarum3 响应还可能带地图或导本，所以不提前返回
  let deckCaptured = false;
  if (isDeckCapture) {
    deckCaptured = (await updateDeckState((previous) => captureDeck(previous, json, { url }))).changed;
    if (!isMapCapture && !isGuidebookCapture && !isProfileCapture) {
      return deckCaptured
        ? { ok: true, kind: "deck", captured: true }
        : { ok: true, ignored: true };
    }
  }
  if (isBattleCapture) {
    const result = await updateBattleCapture(json, url);
    return { ok: true, kind: "battle", updated: result.changed };
  }

  const kind = classify(url);
  const playerName = extractPlayerName(json, url);
  if (playerName) await persistPlayerName(playerName);
  if (isProfileCapture && !isMapCapture && !isGuidebookCapture) {
    return { ok: true, kind, playerName };
  }
  const guidebookUpdate = await persistGuidebookCapture(json, {
    url,
    requestBody,
    language: gameLanguage,
    playerName,
  });

  if (!isMapCapture) {
    return {
      ok: true,
      kind,
      guidebooks: Object.keys(guidebookUpdate.state.catalogue).length,
      inventory: Object.keys(guidebookUpdate.state.inventory).length,
    };
  }

  const dungeon = extractDungeon(json);
  const prev = await getState();

  // Always keep last raw capture for debug
  const captureMeta = {
    url,
    method: method || "GET",
    status: status ?? 200,
    kind,
    at: Date.now(),
  };

  let state = prev;
  if (dungeon) {
    state = mergeDungeonState(prev, dungeon, { url, kind });
  } else if (json && typeof json === "object") {
    // 不带整张地图的响应（移动、事件、选项）：把位置和格子的变化补到现有地图上
    const patched = applyDungeonActions(prev, json);
    if (patched.changed) {
      state = {
        ...patched.state,
        updatedAt: Date.now(),
        lastUrl: url,
        lastKind: kind,
      };
    }
  }

  if (!state) {
    // store capture only
    state = {
      node_list: [],
      lastCapture: captureMeta,
      updatedAt: Date.now(),
      lastUrl: url,
      lastKind: kind,
      rawNote: dungeon ? null : "no dungeon node_list in this response",
    };
  } else {
    state = { ...state, lastCapture: captureMeta };
  }

  await chrome.storage.local.set({ [STORAGE_KEY]: state });
  broadcastState(state);
  return {
    ok: true,
    kind,
    nodes: state.node_list?.length || 0,
    current: state.current_node_id,
  };
}

function extractPlayerName(json, url) {
  const candidates = [
    json?.nickname,
    json?.data?.nickname,
    json?.option?.nickname,
    json?.data?.option?.nickname,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  try {
    const nickname = new URL(url).searchParams.get("nickname");
    return nickname?.trim() || "";
  } catch {
    return "";
  }
}

async function persistPlayerName(playerName) {
  const name = String(playerName || "").trim();
  if (!name) return;
  const previous = await getState();
  if (!previous || previous.playerName !== name) {
    const state = { ...(previous || {}), playerName: name, updatedAt: Date.now() };
    await chrome.storage.local.set({ [STORAGE_KEY]: state });
    broadcastState(state);
  }
  const previousGuidebooks = await getGuidebooks();
  if (previousGuidebooks.playerName !== name) {
    const state = { ...previousGuidebooks, playerName: name };
    await chrome.storage.local.set({ [GUIDEBOOK_STORAGE_KEY]: state });
    broadcastGuidebooks(state);
  }
}

async function getState() {
  const bag = await chrome.storage.local.get(STORAGE_KEY);
  return bag[STORAGE_KEY] || null;
}

async function getDeckState() {
  const bag = await chrome.storage.local.get(DECK_STORAGE_KEY);
  return bag[DECK_STORAGE_KEY] || createDeckState();
}

async function getBattleState() {
  const bag = await chrome.storage.local.get(BATTLE_STORAGE_KEY);
  return bag[BATTLE_STORAGE_KEY] || null;
}

/** 盘子与战斗状态都是读-改-写，串行化避免连续响应互相覆盖 */
function enqueueBuildUpdate(task) {
  const run = buildUpdateQueue.catch(() => {}).then(task);
  buildUpdateQueue = run;
  return run;
}

function updateDeckState(reducer) {
  return enqueueBuildUpdate(async () => {
    const result = reducer(await getDeckState());
    if (result.changed) {
      await chrome.storage.local.set({ [DECK_STORAGE_KEY]: result.state });
    }
    return { ok: true, changed: result.changed, deck: result.state };
  });
}

function clearRunBuildState() {
  return enqueueBuildUpdate(() =>
    chrome.storage.local.remove([BATTLE_STORAGE_KEY, SHOP_STORAGE_KEY, PARTY_STORAGE_KEY]));
}

/** 上一局留下的状态全部清掉。跨局的记录（预兆、敌人、导本图鉴）和盘子不动。 */
async function resetRunState() {
  await clearRunBuildState();
  guidebookUpdateQueue = guidebookUpdateQueue
    .catch(() => {})
    .then(async () => {
      const result = resetGuidebookRun(await getGuidebooks());
      if (result.changed) {
        await chrome.storage.local.set({ [GUIDEBOOK_STORAGE_KEY]: result.state });
        broadcastGuidebooks(result.state);
      }
    });
  await guidebookUpdateQueue;
}

async function getShopState() {
  const bag = await chrome.storage.local.get(SHOP_STORAGE_KEY);
  return bag[SHOP_STORAGE_KEY] || createShopState();
}

function updateShopState(reducer) {
  return enqueueBuildUpdate(async () => {
    const result = await reducer(await getShopState());
    if (result.changed) await chrome.storage.local.set({ [SHOP_STORAGE_KEY]: result.state });
    return result;
  });
}

/** 请求体可能是 JSON 字符串、表单字符串或对象：取其中一个字段 */
function parseRequestField(requestBody, field) {
  if (!requestBody) return null;
  if (typeof requestBody === "object") return requestBody[field] ?? null;
  try {
    return JSON.parse(requestBody)?.[field] ?? null;
  } catch {
    return new URLSearchParams(String(requestBody)).get(field);
  }
}

async function getEnemyLog() {
  const bag = await chrome.storage.local.get(ENEMY_STORAGE_KEY);
  return bag[ENEMY_STORAGE_KEY] || createEnemyLog();
}

/**
 * 敌人记录：新战斗登记出现的敌人；每次行动后把被打死的记一次击杀。
 * @param {object | null} before 这次响应之前的战斗状态
 */
async function updateEnemyLog(before, battle, isStart) {
  if (!battle?.isArcarum3) return;
  let log = await getEnemyLog();
  let changed = false;
  // 刷新页面会重新收到同一场战斗的 start，不能重复登记
  if (isStart && before?.raidId !== battle.raidId) {
    ({ log, changed } = recordSightings(log, battle));
  }
  const kills = recordKills(log, before, battle);
  if (kills.changed) {
    log = kills.log;
    changed = true;
  }
  if (changed) await chrome.storage.local.set({ [ENEMY_STORAGE_KEY]: log });
}

async function getPartyState() {
  const bag = await chrome.storage.local.get(PARTY_STORAGE_KEY);
  return bag[PARTY_STORAGE_KEY] || null;
}

async function getOmenLog() {
  const bag = await chrome.storage.local.get(OMEN_STORAGE_KEY);
  return bag[OMEN_STORAGE_KEY] || createOmenLog();
}

/** 进入战斗时所在格子的类型和天数：决定攻击回合是否计入记录、预兆是否特别提示 */
async function currentNodeContext() {
  const map = await getState();
  const currentId = map?.current_node_id;
  const node = (map?.node_list || []).find((item) => Number(item.node_id) === Number(currentId));
  return {
    nodeType: node ? Number(node.node_type) : null,
    day: map?.node_list?.length ? inferDay(map) : null,
  };
}

function updateBattleCapture(json, url) {
  return enqueueBuildUpdate(async () => {
    const isStart = /\/start\.json/i.test(url);
    const context = isStart ? await currentNodeContext() : {};
    const before = await getBattleState();
    const result = updateBattleState(before, json, {
      url,
      nodeType: context.nodeType,
    });
    if (!result.changed) return { changed: false };

    let battle = result.state;
    await updateEnemyLog(before, battle, isStart);
    // 记录只收肉鸽战斗：预兆的解除条件 + Boss 身上的规则类状态。
    // 第一次见到的条目在本场战斗里一直标为「新」
    const seen = battle.isArcarum3
      ? [...(battle.omens || []), ...statusLogEntries(battle)]
      : [];
    if (seen.length) {
      const recorded = recordOmens(await getOmenLog(), {
        bossName: battle.bosses?.[0]?.name,
        nodeType: battle.nodeType,
        day: context.day,
        omens: seen,
      });
      if (recorded.changed) {
        await chrome.storage.local.set({ [OMEN_STORAGE_KEY]: recorded.log });
      }
      if (recorded.newKeys.length) {
        battle = {
          ...battle,
          newOmenKeys: [...new Set([...(battle.newOmenKeys || []), ...recorded.newKeys])],
        };
      }
    }
    await chrome.storage.local.set({ [BATTLE_STORAGE_KEY]: battle });
    return { changed: true };
  });
}

async function getGuidebooks() {
  const bag = await chrome.storage.local.get(GUIDEBOOK_STORAGE_KEY);
  const previous = bag[GUIDEBOOK_STORAGE_KEY] || null;
  const [guidebookSeed, incidentSeed] = await Promise.all([
    getBundledGuidebookDatabase(),
    getBundledIncidentDatabase(),
  ]);
  const guidebookMerged = mergeGuidebookDatabaseIntoState(previous, guidebookSeed);
  const incidentMerged = mergeIncidentDatabaseIntoState(
    guidebookMerged.state,
    incidentSeed,
  );
  if (guidebookMerged.changed || incidentMerged.changed) {
    await chrome.storage.local.set({ [GUIDEBOOK_STORAGE_KEY]: incidentMerged.state });
  }
  if (guidebookMerged.conflicts.length) {
    console.warn("[gbfroge] guidebook seed conflicts", guidebookMerged.conflicts);
  }
  return incidentMerged.state;
}

function getBundledGuidebookDatabase() {
  if (!guidebookSeedPromise) {
    const load = (path) => fetch(chrome.runtime.getURL(path))
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then(normalizeGuidebookDatabase)
      .catch((error) => {
        console.warn(`[gbfroge] failed to load ${path}`, error);
        return normalizeGuidebookDatabase({
          schemaVersion: 1,
          updatedAt: null,
          entries: {},
          unresolved: [],
        });
      });
    guidebookSeedPromise = Promise.all([
      load("data/guidebooks.json"),
      load("data/guidebooks.zh-CN.json"),
    ]).then((databases) => {
      const merged = mergeGuidebookDatabases(databases);
      if (merged.conflicts.length) {
        console.warn("[gbfroge] guidebook locale seed conflicts", merged.conflicts);
      }
      return merged.database;
    });
  }
  return guidebookSeedPromise;
}

function getBundledIncidentDatabase() {
  if (!incidentSeedPromise) {
    const load = (path) => fetch(chrome.runtime.getURL(path))
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .catch((error) => {
        console.warn(`[gbfroge] failed to load ${path}`, error);
        return { schemaVersion: 1, updatedAt: null, entries: {} };
      });
    incidentSeedPromise = Promise.all([
      load("data/events.json"),
      load("data/events.zh-CN.json"),
    ]).then(mergeIncidentDatabases);
  }
  return incidentSeedPromise;
}

async function persistGuidebookCapture(response, options) {
  let result = null;
  guidebookUpdateQueue = guidebookUpdateQueue
    .catch(() => {})
    .then(async () => {
      const previous = await getGuidebooks();
      result = updateGuidebookState(previous, response, options);
      if (result.changed) {
        await chrome.storage.local.set({
          [GUIDEBOOK_STORAGE_KEY]: result.state,
        });
        broadcastGuidebooks(result.state);
      }
    });
  await guidebookUpdateQueue;
  return result;
}

async function clearActiveGuidebookSelection() {
  let result = null;
  guidebookUpdateQueue = guidebookUpdateQueue
    .catch(() => {})
    .then(async () => {
      const previous = await getGuidebooks();
      result = clearGuidebookSelection(previous);
      if (result.changed) {
        await chrome.storage.local.set({
          [GUIDEBOOK_STORAGE_KEY]: result.state,
        });
        broadcastGuidebooks(result.state);
      }
    });
  await guidebookUpdateQueue;
  return { ok: true, changed: result.changed, state: result.state };
}

function broadcastState(state) {
  chrome.runtime.sendMessage({ type: MSG.STATE_UPDATED, state }).catch(() => {});
}

function broadcastGuidebooks(state) {
  chrome.runtime
    .sendMessage({ type: MSG.GUIDEBOOKS_UPDATED, state })
    .catch(() => {});
}

async function openMapWindow(options = {}) {
  const width = options.width || 1400;
  const height = options.height || 900;
  const url = chrome.runtime.getURL("map/map.html");

  if (mapWindowId != null) {
    try {
      const win = await chrome.windows.get(mapWindowId);
      if (win) {
        await chrome.windows.update(mapWindowId, { focused: true });
        // reload so it picks latest? optional — storage listener handles updates
        return { ok: true, windowId: mapWindowId, reused: true };
      }
    } catch {
      mapWindowId = null;
    }
  }

  const win = await chrome.windows.create({
    url,
    type: "popup",
    width,
    height,
    focused: true,
  });
  mapWindowId = win.id ?? null;
  return { ok: true, windowId: mapWindowId, reused: false };
}

async function focusMapWindow() {
  if (mapWindowId == null) return openMapWindow();
  try {
    await chrome.windows.update(mapWindowId, { focused: true });
    return { ok: true, windowId: mapWindowId };
  } catch {
    mapWindowId = null;
    return openMapWindow();
  }
}

chrome.windows.onRemoved.addListener((id) => {
  if (id === mapWindowId) mapWindowId = null;
});
