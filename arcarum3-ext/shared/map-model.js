import { NODE_TYPE, NODE_TYPE_NAMES } from "./nodeTypes.js";
import {
  resolveSpecialEventIconFile,
  isSkyCastleTruePortalConfirmed,
} from "./nodeTypes.js";
import { ensureSafeZoneShrinking, getMiasmaCenter, withMiasmaTrack } from "./miasma.js";

/**
 * Extract dungeon object from various GBF response shapes.
 */
export function extractDungeon(payload) {
  if (!payload || typeof payload !== "object") return null;

  // direct dungeon
  if (Array.isArray(payload.node_list)) return payload;

  // content/index: { data?, option: { dungeon } }
  const opt = payload.option || payload.data?.option;
  if (opt?.dungeon?.node_list) return opt.dungeon;

  // sometimes nested under data.option after HTML shell
  if (payload.data?.option?.dungeon?.node_list) return payload.data.option.dungeon;

  // move_node / proceed may return partial updates
  if (payload.dungeon?.node_list) return payload.dungeon;

  return null;
}

/**
 * Merge a new dungeon snapshot into previous state.
 * Full node_list replaces; partial fields patch current node / miasma etc.
 */
export function mergeDungeonState(prev, dungeon, meta = {}) {
  if (!dungeon) return prev;

  const next = {
    ...(prev || {}),
    name: dungeon.name ?? prev?.name ?? null,
    map_id: dungeon.map_id ?? prev?.map_id ?? null,
    current_node_id:
      dungeon.current_node_id != null
        ? Number(dungeon.current_node_id)
        : prev?.current_node_id ?? null,
    node_list: Array.isArray(dungeon.node_list)
      ? dungeon.node_list.map(normalizeNode)
      : prev?.node_list || [],
    node_icon_info: dungeon.node_icon_info || prev?.node_icon_info || [],
    miasma_info: dungeon.miasma_info ?? prev?.miasma_info ?? null,
    dungeon_status: dungeon.dungeon_status ?? prev?.dungeon_status ?? null,
    total_turn:
      dungeon.total_turn != null
        ? Number(dungeon.total_turn)
        : prev?.total_turn ?? null,
    possession_arcarum3_dungeon_point:
      dungeon.possession_arcarum3_dungeon_point != null
        ? Number(dungeon.possession_arcarum3_dungeon_point)
        : prev?.possession_arcarum3_dungeon_point ?? null,
    hint: dungeon.hint ?? prev?.hint ?? null,
    // 游戏 JSON 通常无 day；预览可注入；否则用启发式
    day:
      dungeon.day != null && Number(dungeon.day) > 0
        ? Number(dungeon.day)
        : prev?.day ?? null,
    updatedAt: Date.now(),
    lastUrl: meta.url || prev?.lastUrl || null,
    lastKind: meta.kind || prev?.lastKind || null,
  };

  // Patch single-node type change (e.g. boss appear) if response only carries one node
  if (!Array.isArray(dungeon.node_list) && dungeon.node_id != null && dungeon.node_type != null) {
    const id = Number(dungeon.node_id);
    next.node_list = (next.node_list || []).map((n) =>
      n.node_id === id
        ? {
            ...n,
            node_type: Number(dungeon.node_type),
            special_incident_id:
              dungeon.special_incident_id !== undefined
                ? dungeon.special_incident_id
                : n.special_incident_id,
            is_visited:
              dungeon.is_visited !== undefined ? !!dungeon.is_visited : n.is_visited,
          }
        : n
    );
  }

  // appearBoss from miasma
  const appear =
    dungeon.miasma_info?.appearBoss ||
    dungeon.appearBoss ||
    meta.appearBoss;
  if (appear?.targetNodeId != null) {
    const id = Number(appear.targetNodeId);
    next.node_list = (next.node_list || []).map((n) =>
      n.node_id === id ? { ...n, node_type: 1 } : n
    );
    next.boss_node_id = id;
  }

  // 毒圈已开但服务端尚未标 is_shrinking 时：按圆心+圈图半径用位置关系补全
  // （金色安全区外 → is_shrinking=true）；已有标记则尊重服务端
  // 换了一张地图（新的一局）：缩圈记录从头来
  if (prev?.map_id != null && next.map_id != null && prev.map_id !== next.map_id) {
    next.miasma_track = [];
  }
  return withMiasmaTrack(ensureSafeZoneShrinking(next));
}

function toNodeId(value) {
  if (value == null || value === "") return null;
  const id = Number(value);
  return Number.isFinite(id) ? id : null;
}

/** 响应里的行动脚本（移动、事件、选项的结果都放在这里） */
export function listActionScenarios(response) {
  const list =
    response?.action_scenario_list ??
    response?.actionScenarioList ??
    response?.data?.action_scenario_list ??
    response?.data?.actionScenarioList;
  return Array.isArray(list) ? list.filter((item) => item && typeof item === "object") : [];
}

/**
 * 移动、事件、选项这些响应不带整张地图，只带变化：把变化补到现有地图上。
 * 没有这一步的话，地图要等下一次整图读取（基本只有打完一场战斗回到地图时）才会动。
 *
 * 字段参考 Tarou：
 *   after_current_node_id                走完之后所在的格子
 *   action_scenario_list[].action_type   5 传送（warp_node_id）/ 7 清掉格子 / 11 出现特殊事件
 *   is_delete_node                       finish_node_event：当前格子用掉了
 *   special_incident_appearance_info     finish_node_event：新出现的特殊事件
 *   miasma_info / miasma_info.shrink_node_ids
 *                                        这一步之后的瘴气状态、这一步被瘴气吞掉的格子
 *                                        （真实抓包：carryover_spacebook_status 的响应里就有）
 *
 * @returns {{ state: any, changed: boolean }}
 */
export function applyDungeonActions(prev, response) {
  if (!prev?.node_list?.length || !response || typeof response !== "object") {
    return { state: prev, changed: false };
  }
  let current = prev.current_node_id ?? null;
  /** @type {Map<number, object>} */
  const patches = new Map();
  const patch = (nodeId, fields) => {
    const id = toNodeId(nodeId);
    if (id != null) patches.set(id, { ...(patches.get(id) || {}), ...fields });
  };
  const moveTo = (nodeId) => {
    const id = toNodeId(nodeId);
    if (id != null) current = id;
  };

  moveTo(
    response.after_current_node_id ??
      response.current_node_id ??
      response.option?.dungeon?.current_node_id ??
      response.data?.after_current_node_id ??
      response.data?.option?.dungeon?.current_node_id,
  );

  for (const scenario of listActionScenarios(response)) {
    const type = Number(scenario.action_type ?? scenario.actionType);
    const cleared = Array.isArray(scenario.delete_node_ids) ? scenario.delete_node_ids : [];
    if (type === 5) {
      moveTo(scenario.warp_node_id);
      for (const id of cleared) patch(id, { node_type: NODE_TYPE.EMPTY, special_incident_id: null });
    } else if (type === 7) {
      for (const id of cleared) patch(id, { node_type: NODE_TYPE.EMPTY, special_incident_id: null });
    } else if (type === 11 && scenario.special_incident_id) {
      patch(scenario.node_id, {
        node_type: NODE_TYPE.SPECIAL,
        special_incident_id: Number(scenario.special_incident_id),
      });
    }
  }

  // finish_node_event：当前格子用掉了；新出现的特殊事件
  if (response.is_delete_node && current != null) {
    patch(current, { node_type: NODE_TYPE.EMPTY, special_incident_id: null });
  }
  const appearance = response.special_incident_appearance_info;
  if (appearance && typeof appearance === "object") {
    for (const group of Object.values(appearance)) {
      for (const item of Array.isArray(group?.appearance_list) ? group.appearance_list : []) {
        if (!item?.special_incident_id) continue;
        patch(item.node_id, {
          node_type: NODE_TYPE.SPECIAL,
          special_incident_id: Number(item.special_incident_id),
        });
      }
    }
  }

  // 这一步被瘴气吞掉的格子
  const miasma = response.miasma_info ?? response.data?.miasma_info;
  const shrinkIds = Array.isArray(miasma?.shrink_node_ids) ? miasma.shrink_node_ids : [];
  for (const id of shrinkIds) patch(id, { is_shrinking: true });

  // 站上去的格子算走过
  if (current != null) patch(current, { is_visited: true });

  let changed = Number(current) !== Number(prev.current_node_id);
  const nodeList = prev.node_list.map((node) => {
    const fields = patches.get(Number(node.node_id));
    if (!fields) return node;
    const differs = Object.keys(fields).some((key) => node[key] !== fields[key]);
    if (!differs) return node;
    changed = true;
    return { ...node, ...fields };
  });

  // 响应里顺带的数值（有就用）：回合数、币
  const next = { ...prev, current_node_id: current, node_list: nodeList };
  // 瘴气状态（圆心、是否在蔓延）：有就换成最新的
  if (miasma && typeof miasma === "object" && (miasma.after || miasma.before)) {
    // shrink_node_ids 只是这一步的变化，不存进状态
    const { shrink_node_ids: _shrunk, ...miasmaState } = miasma;
    const nextMiasma = { ...(prev.miasma_info || {}), ...miasmaState };
    if (JSON.stringify(nextMiasma) !== JSON.stringify(prev.miasma_info ?? null)) {
      next.miasma_info = nextMiasma;
      changed = true;
    }
  }
  for (const key of ["total_turn", "possession_arcarum3_dungeon_point"]) {
    const value = response[key] ?? response.dungeon?.[key];
    if (value == null || value === "" || !Number.isFinite(Number(value))) continue;
    if (Number(value) !== Number(prev[key])) {
      next[key] = Number(value);
      changed = true;
    }
  }
  if (!changed) return { state: prev, changed: false };
  return { state: withMiasmaTrack(next), changed: true };
}

function normalizeNode(n) {
  return {
    node_id: Number(n.node_id),
    position_x: Number(n.position_x),
    position_y: Number(n.position_y),
    node_type: Number(n.node_type),
    adjacent_node_ids: (n.adjacent_node_ids || []).map(Number),
    is_visited: !!n.is_visited,
    is_shrinking: !!n.is_shrinking,
    is_quest_check: !!n.is_quest_check,
    special_incident_id:
      n.special_incident_id == null || n.special_incident_id === ""
        ? null
        : Number(n.special_incident_id),
  };
}

/**
 * @param {number} nodeType
 * @param {number|null|undefined} specialId
 * @param {{ truePortalConfirmed?: boolean }} [opts]
 */
export function iconStemForNode(nodeType, specialId, opts = {}) {
  if (nodeType === 0) return null;
  if (nodeType === 10) {
    const file = resolveSpecialEventIconFile(specialId, opts);
    return file.replace(/\.png$/i, "");
  }
  return String(nodeType);
}

export function typeName(t) {
  return NODE_TYPE_NAMES[t] || `type${t}`;
}

export { isSkyCastleTruePortalConfirmed };

/**
 * 节点锚点 = 游戏 position_x/y（连线端点）。
 * 与 arcarumDungeon 一致：线画在 (x,y)↔(x,y)，图标相对此点做锚点偏移，
 * 不是「图标左上角 + 半宽」。
 */
export function nodeCenter(n) {
  return {
    x: Number(n.position_x),
    y: Number(n.position_y),
  };
}

/**
 * 已消耗回合 total_turn → UI「第几回合」= total_turn + 1（对齐贤者助手）
 * @param {number|null|undefined} totalTurn
 */
export function displayTurnNumber(totalTurn) {
  const t = Number(totalTurn);
  if (!Number.isFinite(t) || t < 0) return 1;
  return Math.floor(t) + 1;
}

/**
 * 一局的开头：第 1 天第 1 回合的整张地图。
 * @param {any} dungeon 整图读取到的 dungeon，或已保存的地图状态
 */
export function isRunStart(dungeon) {
  if (!Array.isArray(dungeon?.node_list) || !dungeon.node_list.length) return false;
  const turn = Number(dungeon.total_turn);
  if (dungeon.total_turn == null || dungeon.total_turn === "" || !Number.isFinite(turn)) return false;
  return displayTurnNumber(turn) === 1 && inferDay(dungeon) === 1;
}

/**
 * 「第几天」：游戏包体通常无 day 字段。
 * 优先用注入/缓存的 day；否则按 hint + total_turn 粗分（与知识库 day1/day2 对照一致的启发式）。
 * @param {any} state
 */
export function inferDay(state) {
  if (!state) return 1;
  const d = Number(state.day);
  if (Number.isFinite(d) && d > 0) return Math.floor(d);

  const turn = Number(state.total_turn);
  const targets = state.hint?.target_node_types;
  // day2 样本：hint 偏向商店 [8]，且 total_turn 较大
  if (Array.isArray(targets) && targets.length === 1 && Number(targets[0]) === 8) {
    return 2;
  }
  if (Number.isFinite(turn) && turn >= 40) return 2;
  // 已出现 Boss 点且回合偏多 → 更像第二阶段
  const hasBoss = (state.node_list || []).some((n) => Number(n.node_type) === 1);
  if (hasBoss && Number.isFinite(turn) && turn >= 20) return 2;
  return 1;
}

/**
 * 瘴气短文案（对齐 formatMiasmaProgressText）
 * @param {any} state
 */
export function formatMiasmaProgressText(state) {
  const nodes = state?.node_list || [];
  const covered = nodes.filter((n) => n.is_shrinking).length;
  const mi = state?.miasma_info;
  let after = null;
  if (mi && typeof mi === "object") {
    after = mi.after && typeof mi.after === "object" ? mi.after : mi;
  }
  const active = Boolean(after?.is_miasmic);
  if (!active) {
    return covered > 0 ? `未蔓延 · 笼罩 ${covered} 格` : "未蔓延";
  }
  const parts = ["蔓延中"];
  if (after?.level != null && after.level !== "") parts.push(`Lv.${after.level}`);
  if (after?.step != null && after.step !== "") parts.push(`阶段 ${after.step}`);
  if (after?.miasma_stop_countdown != null && after.miasma_stop_countdown !== "") {
    parts.push(`停止倒计时 ${after.miasma_stop_countdown}`);
  }
  const cx = Number(after?.center_position_x);
  const cy = Number(after?.center_position_y);
  if (Number.isFinite(cx) && Number.isFinite(cy)) {
    parts.push(`圆心(${Math.round(cx)},${Math.round(cy)})`);
  }
  parts.push(`笼罩 ${covered} 格`);
  const mc = getMiasmaCenter(state);
  if (mc?.radius != null) {
    parts.push(`安全半径 ${Math.round(mc.radius)}`);
  }
  parts.push("寻路偏好留白圈内");
  return parts.join(" · ");
}

/**
 * 攻略进度一行：第 X 天 · 第 Y 回合
 * @param {any} state
 */
export function formatProgressLine(state) {
  const day = inferDay(state);
  const turn = displayTurnNumber(state?.total_turn);
  return `第 ${day} 天 · 第 ${turn} 回合`;
}

export function summarize(state) {
  if (!state?.node_list?.length) {
    return {
      nodes: 0,
      types: {},
      current: null,
      name: null,
      day: inferDay(state),
      turnDisplay: displayTurnNumber(state?.total_turn),
      progressLine: formatProgressLine(state),
      dungeonPoint: state?.possession_arcarum3_dungeon_point ?? null,
      miasmaText: formatMiasmaProgressText(state),
    };
  }
  const types = {};
  for (const n of state.node_list) {
    types[n.node_type] = (types[n.node_type] || 0) + 1;
  }
  return {
    nodes: state.node_list.length,
    types,
    current: state.current_node_id,
    name: state.name,
    boss: state.boss_node_id ?? (state.node_list.find((n) => n.node_type === 1)?.node_id ?? null),
    updatedAt: state.updatedAt,
    day: inferDay(state),
    turnDisplay: displayTurnNumber(state?.total_turn),
    totalTurn: state.total_turn,
    progressLine: formatProgressLine(state),
    dungeonPoint: state.possession_arcarum3_dungeon_point ?? 0,
    miasmaText: formatMiasmaProgressText(state),
  };
}
