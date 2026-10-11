/**
 * 「附近」视图：把当前位置周围几步内的节点放大到铺满窗口。
 */
import { hopDistances } from "./quickTargets.js";

/** 当前位置周围取几步以内的节点 */
export const NEARBY_HOPS = 3;
/** 放大倍率的上下限：再近图标会糊，再远就和全图没区别了 */
export const NEARBY_MIN_SCALE = 0.45;
export const NEARBY_MAX_SCALE = 1.1;

/**
 * 当前位置周围 hops 步以内所有节点的包围盒（游戏坐标）。
 * @returns {{ minX: number, minY: number, maxX: number, maxY: number, nodeIds: number[],
 *             focus: { x: number, y: number } } | null}
 *   focus：当前位置；没有当前位置时返回 null
 */
export function nearbyBounds(state, hops = NEARBY_HOPS) {
  const dist = hopDistances(state);
  if (!dist.size) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const nodeIds = [];
  for (const node of state.node_list || []) {
    const id = Number(node.node_id);
    const d = dist.get(id);
    if (d == null || d > hops) continue;
    const x = Number(node.position_x);
    const y = Number(node.position_y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    nodeIds.push(id);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (!nodeIds.length) return null;
  const current = (state.node_list || []).find(
    (node) => Number(node.node_id) === Number(state.current_node_id),
  );
  return {
    minX,
    minY,
    maxX,
    maxY,
    nodeIds,
    focus: { x: Number(current.position_x), y: Number(current.position_y) },
  };
}

/**
 * 让包围盒居中铺进视口。
 * 包围盒太大、缩到下限也放不下时，改为以 focus（当前位置）为中心，保证自己一定在画面正中。
 * @param {{ minX: number, minY: number, maxX: number, maxY: number, focus?: { x: number, y: number } }} bounds
 * @param {number} viewWidth
 * @param {number} viewHeight
 * @param {{ padding?: number, minScale?: number, maxScale?: number }} [options]
 *   padding：四周留白（屏幕像素），给节点图标和浮动按钮让位
 * @returns {{ scale: number, ox: number, oy: number }}
 */
export function fitBounds(bounds, viewWidth, viewHeight, options = {}) {
  const padding = options.padding ?? 90;
  const minScale = options.minScale ?? NEARBY_MIN_SCALE;
  const maxScale = options.maxScale ?? NEARBY_MAX_SCALE;
  const width = Math.max(1, bounds.maxX - bounds.minX);
  const height = Math.max(1, bounds.maxY - bounds.minY);
  const raw = Math.min(
    Math.max(1, viewWidth - padding * 2) / width,
    Math.max(1, viewHeight - padding * 2) / height,
  );
  const scale = Math.max(minScale, Math.min(maxScale, raw));
  const overflow = raw < minScale && bounds.focus;
  const centerX = overflow ? bounds.focus.x : (bounds.minX + bounds.maxX) / 2;
  const centerY = overflow ? bounds.focus.y : (bounds.minY + bounds.maxY) / 2;
  return {
    scale,
    ox: viewWidth / 2 - centerX * scale,
    oy: viewHeight / 2 - centerY * scale,
  };
}
