/**
 * 快捷寻路目标：浮空城研究者 / Boss / 最近的特殊事件 / 最近的君临者，
 * 以及「本局特殊事件」列表。只负责挑终点，路线仍由 weightedRoute 规划。
 */
import {
  NODE_TYPE,
  SKY_CASTLE_PORTAL_IDS,
  SPECIAL_INCIDENT_META,
} from "../nodeTypes.js";

export const RESEARCHER_INCIDENT_ID = 8;

export const QUICK_TARGETS = [
  { kind: "researcher", label: "研究者", title: "寻路到浮空城研究者" },
  { kind: "boss", label: "Boss", title: "寻路到 Boss（缩圈后才出现）" },
  { kind: "special", label: "最近特殊", title: "寻路到最近的未访问特殊事件" },
  { kind: "ruler", label: "最近君临者", title: "寻路到最近的君临者" },
  {
    kind: "removal",
    label: "消除导本",
    title: "寻路到最近的、还可能买到「消除导本」的商店：没去过的，或者去过但这件还没买的",
  },
];

function nodeId(node) {
  return Number(node.node_id);
}

function specialId(node) {
  if (Number(node.node_type) !== NODE_TYPE.SPECIAL) return null;
  const id = Number(node.special_incident_id);
  return Number.isFinite(id) && id > 0 ? id : null;
}

export function specialIncidentName(id) {
  return SPECIAL_INCIDENT_META[Number(id)]?.name || `特殊事件 ${id}`;
}

/**
 * 本局地图上的特殊事件，研究者排最前，其余按节点号。
 * 多个传送口合并成一项（它们是同一件事的几个入口）。
 * @returns {{ nodeId: number, nodeIds: number[], specialIncidentId: number, name: string, visited: boolean, isResearcher: boolean }[]}
 */
export function listSpecialIncidents(state) {
  const items = [];
  let portals = null;
  for (const node of state?.node_list || []) {
    const id = specialId(node);
    if (id == null) continue;
    if (SKY_CASTLE_PORTAL_IDS.has(id)) {
      if (!portals) {
        portals = {
          nodeId: nodeId(node),
          nodeIds: [],
          specialIncidentId: id,
          name: specialIncidentName(id),
          visited: true,
          isResearcher: false,
        };
        items.push(portals);
      }
      portals.nodeIds.push(nodeId(node));
      portals.visited = portals.visited && Boolean(node.is_visited);
      continue;
    }
    items.push({
      nodeId: nodeId(node),
      nodeIds: [nodeId(node)],
      specialIncidentId: id,
      name: specialIncidentName(id),
      visited: Boolean(node.is_visited),
      isResearcher: id === RESEARCHER_INCIDENT_ID,
    });
  }
  return items.sort(
    (a, b) => Number(b.isResearcher) - Number(a.isResearcher) || a.nodeId - b.nodeId,
  );
}

/**
 * 从当前位置出发的步数（BFS）。Boss 只能当终点，不能穿过。
 * @returns {Map<number, number>}
 */
export function hopDistances(state, startId = state?.current_node_id) {
  const byId = new Map((state?.node_list || []).map((node) => [nodeId(node), node]));
  const start = Number(startId);
  const dist = new Map();
  if (!byId.has(start)) return dist;
  dist.set(start, 0);
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head];
    const node = byId.get(id);
    if (id !== start && Number(node.node_type) === NODE_TYPE.BOSS) continue;
    for (const raw of node.adjacent_node_ids || []) {
      const next = Number(raw);
      if (!byId.has(next) || dist.has(next)) continue;
      dist.set(next, dist.get(id) + 1);
      queue.push(next);
    }
  }
  return dist;
}

/**
 * 满足条件且步数最少的节点（不含当前位置）；步数相同取节点号小的，结果稳定。
 * @returns {{ nodeId: number, hops: number } | null}
 */
export function findNearestNode(state, predicate) {
  const dist = hopDistances(state);
  let best = null;
  for (const node of state?.node_list || []) {
    const id = nodeId(node);
    const hops = dist.get(id);
    if (!hops || !predicate(node)) continue;
    if (!best || hops < best.hops || (hops === best.hops && id < best.nodeId)) {
      best = { nodeId: id, hops };
    }
  }
  return best;
}

const PREDICATES = {
  researcher: (node) => specialId(node) === RESEARCHER_INCIDENT_ID && !node.is_visited,
  boss: (node) => Number(node.node_type) === NODE_TYPE.BOSS,
  // 传送口只是通往浮空城的入口，不算「事件」本身
  special: (node) => {
    const id = specialId(node);
    return id != null && !SKY_CASTLE_PORTAL_IDS.has(id) && !node.is_visited;
  },
  ruler: (node) => Number(node.node_type) === NODE_TYPE.RULER,
  // 商店是否还可能卖「消除导本」由调用方给（要看商店记录）
  removal: (node, context) =>
    Number(node.node_type) === NODE_TYPE.SHOP &&
    (context?.mayOfferRemoval ? context.mayOfferRemoval(Number(node.node_id)) : true),
};

const MISSING = {
  researcher: "本局地图上没有未访问的浮空城研究者",
  boss: "Boss 还没出现（缩圈后才会出现）",
  special: "没有未访问的特殊事件",
  ruler: "地图上没有君临者",
  removal: "没有还能买到「消除导本」的商店",
};

/**
 * @param {'researcher' | 'boss' | 'special' | 'ruler'} kind
 * @returns {{ nodeId: number, hops: number } | { nodeId: null, reason: string }}
 */
export function quickTarget(state, kind, context = {}) {
  const base = PREDICATES[kind];
  if (!base) return { nodeId: null, reason: "未知的快捷目标" };
  if (state?.current_node_id == null) return { nodeId: null, reason: "没有当前位置" };
  const predicate = (node) => base(node, context);
  const exists = (state.node_list || []).some(predicate);
  if (!exists) return { nodeId: null, reason: MISSING[kind] };
  return findNearestNode(state, predicate) || { nodeId: null, reason: "从当前位置走不到" };
}

/**
 * 开局默认目标：研究者还没访问、而且玩家没有主动放弃过它时，返回它的节点号。
 * @param {{ dismissedNodeId?: number | null }} [options]
 * @returns {number | null}
 */
export function defaultOpeningTarget(state, options = {}) {
  const target = quickTarget(state, "researcher");
  if (target.nodeId == null) return null;
  if (Number(options.dismissedNodeId) === target.nodeId) return null;
  return target.nodeId;
}
