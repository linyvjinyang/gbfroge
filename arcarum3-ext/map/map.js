/**
 * 独立地图窗口：平移/缩放 + 左下图例 + 路径规划
 *
 * 性能：状态变化时烘焙静态层（背景+边+节点），拖拽/缩放只 blit + 叠加动态层。
 * 连线：端点 = 原始 position_x/y（与贤者助手一致）；图标按 0.5/0.83 锚点对齐。
 */
import {
  MSG,
  DECK_STORAGE_KEY,
  BATTLE_STORAGE_KEY,
  OMEN_STORAGE_KEY,
  PARTY_STORAGE_KEY,
  ENEMY_STORAGE_KEY,
  SHOP_STORAGE_KEY,
  CAPTURE_LOG_STORAGE_KEY,
  CDN_BASES,
  NODE_SIZE,
  BASE_ANCHOR_X,
  BASE_ANCHOR_Y,
  BASE_NATIVE_W,
  BASE_NATIVE_H,
} from "../shared/constants.js";
import {
  NODE_TYPE,
  NODE_TYPE_META,
  hasSpecialNodeBg,
  specialNodeBgRel,
  SPECIAL_NODE_BG_OFFSET,
  SPECIAL_NODE_BG_NATIVE,
} from "../shared/nodeTypes.js";
import {
  iconStemForNode,
  nodeCenter,
  typeName,
  summarize,
  isSkyCastleTruePortalConfirmed,
  inferDay,
} from "../shared/map-model.js";
import { getMiasmaCenter } from "../shared/miasma.js";
import { buildNodeDetailView, renderNodeDetail } from "../shared/nodeDetail.js";
import {
  PRESET_LABEL,
  toRouteMap,
  planRouteWithVias,
  isValidTargetRoute,
  summarizeRoute,
} from "../shared/path/weightedRoute.js";
import {
  nextTargetSelection,
  isDuplicateRightClick,
} from "../shared/path/routeInteraction.js";
import {
  findLowestScorePathSticky,
  describeShrink,
  describeExploreScores,
  scoreForType,
  makeSweepBias,
  REPLAN_STICKINESS,
  DOWN_BIAS_WEIGHT,
  EXPLORE_WEIGHTS,
  EXPLORE_SCORE_FIELDS,
} from "../shared/path/exploreScore.js";
import {
  QUICK_TARGETS,
  defaultOpeningTarget,
  hopDistances,
  listSpecialIncidents,
  quickTarget,
} from "../shared/path/quickTargets.js";
import { fitBounds, nearbyBounds } from "../shared/path/nearbyView.js";
import { exportCaptureLog } from "../shared/captureLog.js";
import {
  describeShop,
  mayOfferRemoval,
  shopInfo,
  shopMultiplier,
  shopNodeScores,
} from "../shared/shops.js";
import { getGuidebookDisplayName } from "../shared/guidebookTranslations.js";
import { getShopItemTranslation } from "../shared/shopItems.js";
import { createGuidebookView } from "./guidebookView.js";
import { createBuildView } from "./buildView.js";
import { loadAssetImage, backgroundImageKey, selectBackgroundImage } from "../shared/assetImages.js";

const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d", { alpha: false });
const $ = (id) => document.getElementById(id);

/** @type {any} */
let state = null;
/** 本局各商店的货架记录（后台维护） */
let shopState = null;

function currentCoins() {
  return state?.possession_arcarum3_dungeon_point ?? shopState?.coin ?? null;
}
let activeWindowView = "map";

const EXPLORE_WEIGHTS_STORAGE_KEY = "gbf-explore-score-weights-v1";
let exploreWeights = loadExploreWeights();
const EXPLORE_DOWN_STORAGE_KEY = "gbf-explore-down-v1";

let scale = 0.45;
let ox = 40;
let oy = 40;

let dragging = false;
let dragMoved = false;
let lastX = 0;
let lastY = 0;
let hoverId = null;
let selectedId = null;

/** @type {{ kind: 'current' } | { kind: 'type', displayType: number } | null} */
let highlightFilter = null;
let legendSelectedKey = null;

let routePreset = "short";
/** @type {number|null} */
let routeGoal = null;
/** @type {number[]} */
let routeVias = [];
/** @type {number[]|null} */
let routePath = null;
/** 'target' 右键目标寻路 | 'explore' 无目标收益扫路 */
let routeMode = null;
/** @type {number|null} */
let exploreScore = null;

const showEmpty = $("show-empty");
const showIds = $("show-ids");
const showLegend = $("show-legend");
const autoFit = $("auto-fit");
const autoResearcher = $("auto-researcher");

/** 设置页的勾选项；默认值就是 HTML 里的初始勾选状态 */
const MAP_SETTINGS_STORAGE_KEY = "gbfroge-map-settings-v1";
const MAP_SETTING_INPUTS = { autoFit, showEmpty, showIds, showLegend, autoResearcher };

function loadMapSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(MAP_SETTINGS_STORAGE_KEY) || "{}");
    for (const [key, input] of Object.entries(MAP_SETTING_INPUTS)) {
      if (typeof saved[key] === "boolean") input.checked = saved[key];
    }
  } catch {
    // 读不到就用默认值。
  }
}

function saveMapSettings() {
  try {
    const values = Object.fromEntries(
      Object.entries(MAP_SETTING_INPUTS).map(([key, input]) => [key, input.checked])
    );
    localStorage.setItem(MAP_SETTINGS_STORAGE_KEY, JSON.stringify(values));
  } catch {
    // 存不下也不影响本次会话的设置。
  }
}

loadMapSettings();

/** 玩家手动缩放/平移过之后，不再因为底图加载等原因自动重排视图 */
let userAdjustedView = false;
/** 玩家放弃过的开局目标（研究者）节点，避免清掉路线后又被自动设回 */
let openingDismissedNodeId = null;

/** 底图亮度（百分比，持久化到 localStorage） */
let bgBrightness = (() => {
  const v = Number(localStorage.getItem("map_bg_brightness"));
  return Number.isFinite(v) && v >= 50 && v <= 160 ? v : 100;
})();

const images = new Map();
let cdnBase = CDN_BASES[0];
let mapW = 2680;
let mapH = 1830;

/** 静态世界层（1:1 游戏坐标） */
const staticCanvas = document.createElement("canvas");
const staticCtx = staticCanvas.getContext("2d");
let staticDirty = true;
let staticKey = "";

let needsRedraw = true;
let raf = 0;

const guidebookView = createGuidebookView({
  onRender(summary) {
    if (activeWindowView === "guidebooks") updateGuidebookFooter(summary);
  },
});
const buildView = createBuildView();

/** 最近一份导本数据：商店提示里用它把导本名显示成中文 */
let guidebookCatalogue = {};

/** 商店商品的显示名：导本用导本库里的中文名，其他商品用商品翻译 */
function shopItemName(item) {
  const entry = item.statusId != null ? guidebookCatalogue[String(item.statusId)] : null;
  if (entry) return getGuidebookDisplayName(entry);
  return getShopItemTranslation({ rawName: item.name }).name || item.name || "商品";
}

/** 导本同时驱动导本页和右栏的上限参考 */
function applyGuidebooks(guidebookState) {
  guidebookCatalogue = guidebookState?.catalogue || {};
  guidebookView.render(guidebookState);
  buildView.setGuidebooks(guidebookState);
}

// 图标绘制尺寸（世界坐标）
const iconW = NODE_SIZE;
const iconH = NODE_SIZE * (BASE_NATIVE_H / BASE_NATIVE_W);
const hitR = (NODE_SIZE / 2) * 1.25;

function assetUrl(rel) {
  return `${cdnBase}/${rel}`;
}

function syncBackgroundSize() {
  const background = selectBackgroundImage(images, state?.map_id);
  mapW = background?.naturalWidth || 2680;
  mapH = background?.naturalHeight || 1830;
}

function loadImage(key, url) {
  if (images.has(key)) return images.get(key);
  const img = new Image();
  img.decoding = "async";
  images.set(key, img);
  loadAssetImage(img, url, {
    onLoad: () => {
      if (String(key).startsWith("bg:")) {
        const before = `${mapW}x${mapH}`;
        syncBackgroundSize();
        if (before !== `${mapW}x${mapH}` && autoFit.checked && !userAdjustedView) applyViewMode();
      }
      staticDirty = true;
      scheduleDraw();
    },
    onError: () => {
      images.set(key, null);
      staticDirty = true;
      scheduleDraw();
    },
  });
  return img;
}

function ensureAssets() {
  const preferredKey = backgroundImageKey(state?.map_id);
  loadImage(preferredKey, assetUrl(preferredKey.slice(3)));
  if (preferredKey !== backgroundImageKey(1)) {
    loadImage(backgroundImageKey(1), assetUrl("assets/map_bg/1.jpg"));
  }
  syncBackgroundSize();
  loadImage("base", assetUrl("assets/node_icon/base.png"));
  loadImage("base_cleared", assetUrl("assets/node_icon/base_cleared.png"));
  loadImage("piece", assetUrl("assets/node_icon/piece_1.png"));
  loadImage("pointer", assetUrl("dungeon/pointer_current_node.png"));
  for (let t = 1; t <= 11; t++) {
    if (t === 10) {
      loadImage("icon:10_incident", assetUrl("assets/node_icon/10_incident.png"));
      loadImage("icon:10_research", assetUrl("assets/node_icon/10_research.png"));
      loadImage("icon:10_teleport", assetUrl("assets/node_icon/10_teleport.png"));
      loadImage("icon:10_teleport_glow", assetUrl("assets/node_icon/10_teleport_glow.png"));
      // 可选：官方还有 10_guru / 10_fanatic（本地可能缺失，load 失败无妨）
      loadImage("icon:10_guru", assetUrl("assets/node_icon/10_guru.png"));
      loadImage("icon:10_fanatic", assetUrl("assets/node_icon/10_fanatic.png"));
    } else {
      loadImage(`icon:${t}`, assetUrl(`assets/node_icon/${t}.png`));
    }
  }
  // 地点特殊事件金色底图 scpecial_node_bg/{special_incident_id}.png
  for (const n of state?.node_list || []) {
    if (Number(n.node_type) !== NODE_TYPE.SPECIAL) continue;
    const sid = n.special_incident_id;
    if (!hasSpecialNodeBg(sid)) continue;
    const rel = specialNodeBgRel(sid);
    loadImage(`spbg:${sid}`, assetUrl(rel));
  }
}

function portalOpts() {
  return {
    truePortalConfirmed: isSkyCastleTruePortalConfirmed(state?.node_list || []),
  };
}

function imgReady(key) {
  const im = images.get(key);
  return im && im.complete && im.naturalWidth > 0 ? im : null;
}

/** 图标左上角（使锚点落在 position） */
function iconTopLeft(px, py) {
  return {
    x: px - iconW * BASE_ANCHOR_X,
    y: py - iconH * BASE_ANCHOR_Y,
  };
}

function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width * dpr));
  const h = Math.max(1, Math.floor(rect.height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  scheduleDraw();
}

function worldToScreen(x, y) {
  return { x: x * scale + ox, y: y * scale + oy };
}

function screenToWorld(sx, sy) {
  return { x: (sx - ox) / scale, y: (sy - oy) / scale };
}

function scheduleDraw() {
  needsRedraw = true;
  if (!raf) {
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (needsRedraw) paint();
    });
  }
}

function setZoomLabels() {
  $("zoom-label-float").textContent = `${Math.round(scale * 100)}%`;
}

function nodeMatchesFilter(n, current) {
  if (!highlightFilter) return true;
  if (highlightFilter.kind === "current") return n.node_id === current;
  if (highlightFilter.kind === "type") return n.node_type === highlightFilter.displayType;
  return true;
}

function computeStaticKey() {
  return [
    state?.updatedAt || 0,
    state?.current_node_id,
    showEmpty.checked ? 1 : 0,
    showIds.checked ? 1 : 0,
    legendSelectedKey || "",
    mapW,
    mapH,
    portalOpts().truePortalConfirmed ? 1 : 0,
    bgBrightness,
  ].join("|");
}

/**
 * 烘焙背景 + 边 + 节点到 staticCanvas（世界 1:1）
 * 筛选压暗也烤进去，避免每帧重画图标
 */
function rebuildStaticLayer() {
  const key = computeStaticKey();
  if (!staticDirty && key === staticKey && staticCanvas.width === mapW) return;
  staticDirty = false;
  staticKey = key;

  if (staticCanvas.width !== mapW || staticCanvas.height !== mapH) {
    staticCanvas.width = mapW;
    staticCanvas.height = mapH;
  }
  const sctx = staticCtx;
  sctx.setTransform(1, 0, 0, 1, 0, 0);
  sctx.fillStyle = "#0b0f14";
  sctx.fillRect(0, 0, mapW, mapH);

  const bg = selectBackgroundImage(images, state?.map_id);
  if (bg) {
    // 全不透明绘制，亮度由滑杆控制（旧版 0.5 半透明叠黑底导致整图过暗）
    sctx.filter = `brightness(${bgBrightness / 100}) saturate(1.06)`;
    sctx.drawImage(bg, 0, 0, mapW, mapH);
    sctx.filter = "none";
  }

  const nodes = state?.node_list || [];
  if (!nodes.length) return;

  const byId = new Map(nodes.map((n) => [n.node_id, n]));
  const current =
    state.current_node_id != null ? Number(state.current_node_id) : null;
  const filtering = Boolean(highlightFilter);

  // —— 连线：端点 = 原始 position_x/y（与贤者助手 mapRenderer 一致）——
  // 先收集去重后的边，再分两层画：深色描边打底 + 亮色虚线，
  // 保证普通通路在亮/暗底图上都清晰（旧版 #4b5c70 在暗底图上几乎不可见，看起来像“连线丢失”）。
  const edges = [];
  const drawn = new Set();
  for (const n of nodes) {
    for (const adj of n.adjacent_node_ids || []) {
      const a = Number(adj);
      if (!byId.has(a)) continue;
      const lo = Math.min(n.node_id, a);
      const hi = Math.max(n.node_id, a);
      const ek = `${lo}-${hi}`;
      if (drawn.has(ek)) continue;
      drawn.add(ek);
      const A = byId.get(lo);
      const B = byId.get(hi);
      edges.push({ A, B, miasma: Boolean(A.is_shrinking || B.is_shrinking) });
    }
  }

  const strokeEdges = (list) => {
    sctx.beginPath();
    for (const e of list) {
      sctx.moveTo(e.A.position_x, e.A.position_y);
      sctx.lineTo(e.B.position_x, e.B.position_y);
    }
    sctx.stroke();
  };
  const normalEdges = edges.filter((e) => !e.miasma);
  const miasmaEdges = edges.filter((e) => e.miasma);

  sctx.lineCap = "round";
  sctx.globalAlpha = filtering ? 0.22 : 1;

  // 1) 深色描边打底
  sctx.setLineDash([]);
  sctx.strokeStyle = "rgba(6, 10, 14, 0.5)";
  sctx.lineWidth = 11;
  strokeEdges(edges);

  // 2) 普通通路：亮色圆点链（贴近游戏原版风格）
  sctx.strokeStyle = "#f5f2df";
  sctx.lineWidth = 6.5;
  sctx.setLineDash([0.5, 13]);
  strokeEdges(normalEdges);

  // 3) 毒圈覆盖的边：瘴气紫虚线
  sctx.strokeStyle = "#c084fc";
  sctx.lineWidth = 8;
  sctx.setLineDash([12, 8]);
  strokeEdges(miasmaEdges);

  sctx.setLineDash([]);
  sctx.globalAlpha = 1;

  // —— 节点 ——
  const opts = portalOpts();
  for (const n of nodes) {
    if (n.node_type === 0 && !showEmpty.checked) continue;

    const match = nodeMatchesFilter(n, current);
    const alpha = filtering ? (match ? 1 : 0.22) : 1;
    sctx.globalAlpha = alpha;

    const px = n.position_x;
    const py = n.position_y;
    const tl = iconTopLeft(px, py);

    if (filtering && match) {
      sctx.shadowColor = "rgba(251,191,36,0.9)";
      sctx.shadowBlur = 10;
    } else {
      sctx.shadowBlur = 0;
    }

    // 地点特殊事件：金色区域底图（对齐官方 specialNodeBg，620² 锚点偏移）
    if (
      Number(n.node_type) === NODE_TYPE.SPECIAL &&
      hasSpecialNodeBg(n.special_incident_id)
    ) {
      const bg = imgReady(`spbg:${n.special_incident_id}`);
      if (bg) {
        const bx = px - SPECIAL_NODE_BG_OFFSET.x;
        const by = py - SPECIAL_NODE_BG_OFFSET.y;
        sctx.drawImage(
          bg,
          bx,
          by,
          SPECIAL_NODE_BG_NATIVE,
          SPECIAL_NODE_BG_NATIVE
        );
      }
    }

    const baseKey = n.is_visited ? "base_cleared" : "base";
    const base = imgReady(baseKey) || imgReady("base");
    if (base) {
      sctx.drawImage(base, tl.x, tl.y, iconW, iconH);
    } else {
      sctx.fillStyle = "#555";
      sctx.beginPath();
      sctx.arc(px, py, NODE_SIZE * 0.35, 0, Math.PI * 2);
      sctx.fill();
    }

    const stem = iconStemForNode(n.node_type, n.special_incident_id, opts);
    if (stem) {
      const ic = imgReady(`icon:${stem}`) || imgReady("icon:10_incident");
      if (ic) sctx.drawImage(ic, tl.x, tl.y, iconW, iconH);
    }

    if (n.node_id === current) {
      const piece = imgReady("piece");
      if (piece) sctx.drawImage(piece, tl.x, tl.y, iconW, iconH);
      sctx.shadowBlur = 0;
      sctx.strokeStyle = "#fbbf24";
      sctx.lineWidth = 3;
      sctx.beginPath();
      sctx.arc(px, py, hitR * 0.85, 0, Math.PI * 2);
      sctx.stroke();
    }

    if (showIds.checked) {
      sctx.shadowBlur = 0;
      sctx.font = "bold 14px sans-serif";
      sctx.textAlign = "center";
      const ty = py + iconH * (1 - BASE_ANCHOR_Y) + 14;
      sctx.strokeStyle = "rgba(0, 0, 0, 0.75)";
      sctx.lineWidth = 3;
      sctx.strokeText(String(n.node_id), px, ty);
      sctx.fillStyle = "#fff59a";
      sctx.fillText(String(n.node_id), px, ty);
    }

    sctx.shadowBlur = 0;
  }
  sctx.globalAlpha = 1;
}

/** 屏幕合成：静态层变换 + 路线/选中/悬停 */
function paint() {
  needsRedraw = false;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  ctx.fillStyle = "#0b0f14";
  ctx.fillRect(0, 0, cssW, cssH);

  if (staticDirty || computeStaticKey() !== staticKey) {
    rebuildStaticLayer();
  }

  // blit 静态世界
  if (staticCanvas.width > 0) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "medium";
    ctx.drawImage(
      staticCanvas,
      0,
      0,
      mapW,
      mapH,
      ox,
      oy,
      mapW * scale,
      mapH * scale
    );
  }

  const nodes = state?.node_list || [];
  if (!nodes.length) {
    ctx.fillStyle = "#aaa";
    ctx.font = "15px sans-serif";
    ctx.fillText("暂无地图数据。请在游戏中进入沙盒地图。", 24, 40);
    setZoomLabels();
    return;
  }

  const byId = new Map(nodes.map((n) => [n.node_id, n]));
  const routing = Boolean(routePath && routePath.length > 1);
  const onRoute = new Set(routePath || []);

  // 路线折线（目标=蓝，扫路=绿）
  if (routing) {
    const isExplore = routeMode === "explore";
    ctx.save();
    ctx.strokeStyle = isExplore
      ? "rgba(52,211,153,0.95)"
      : "rgba(56,189,248,0.92)";
    ctx.lineWidth = Math.max(3, 10 * scale);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.shadowColor = isExplore
      ? "rgba(52,211,153,0.65)"
      : "rgba(56,189,248,0.65)";
    ctx.shadowBlur = 6;
    ctx.beginPath();
    for (let i = 0; i < routePath.length; i++) {
      const n = byId.get(routePath[i]);
      if (!n) continue;
      const s = worldToScreen(n.position_x, n.position_y);
      if (i === 0) ctx.moveTo(s.x, s.y);
      else ctx.lineTo(s.x, s.y);
    }
    ctx.stroke();
    ctx.restore();
  }

  // 动态高亮：目标 / 途经 / 选中 / 悬停
  const mark = (nid, color, width) => {
    const n = byId.get(nid);
    if (!n) return;
    const s = worldToScreen(n.position_x, n.position_y);
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.arc(s.x, s.y, hitR * scale, 0, Math.PI * 2);
    ctx.stroke();
  };

  if (routeMode === "target" && routeGoal != null) {
    mark(routeGoal, "#fb7185", Math.max(2, 3 * scale));
  }
  if (routeMode === "target") {
    for (const v of routeVias) mark(v, "#a78bfa", Math.max(2, 2.5 * scale));
  }
  // 扫路：在负分格上标小绿点
  if (routeMode === "explore" && routePath) {
    const scOpts = getExploreOpts();
    for (const id of routePath) {
      const n = byId.get(id);
      if (!n) continue;
      const sc = scoreForType(n.node_type, scOpts);
      if (sc >= 0) continue;
      const s = worldToScreen(n.position_x, n.position_y);
      ctx.beginPath();
      ctx.fillStyle = "rgba(52,211,153,0.85)";
      ctx.arc(s.x, s.y, Math.max(3, 5 * scale), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // 商店格右上角的小标：没去过「?」、还剩几件、买空「空」
  ctx.save();
  ctx.font = `bold ${Math.max(10, 13 * Math.min(1, scale * 1.6))}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const n of nodes) {
    if (Number(n.node_type) !== NODE_TYPE.SHOP) continue;
    const info = shopInfo(shopState, n.node_id);
    const label = !info.visited ? "?" : info.remaining.length ? String(info.remainingCount) : "空";
    const s = worldToScreen(n.position_x, n.position_y);
    const cx = s.x + hitR * 0.55 * scale;
    const cy = s.y - iconH * 0.62 * scale;
    const r = Math.max(8, 11 * Math.min(1, scale * 1.6));
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = !info.visited
      ? "rgba(20, 29, 49, 0.92)"
      : info.remaining.length
        ? info.discount
          ? "rgba(37, 121, 78, 0.95)"
          : "rgba(120, 85, 28, 0.95)"
        : "rgba(60, 60, 66, 0.9)";
    ctx.fill();
    ctx.strokeStyle = "rgba(240, 214, 143, 0.9)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = "#fff8e1";
    ctx.fillText(label, cx, cy + 0.5);
  }
  ctx.restore();

  if (selectedId != null) mark(selectedId, "#ffd76a", Math.max(1.5, 2 * scale));
  if (hoverId != null && hoverId !== selectedId) {
    mark(hoverId, "rgba(255,255,255,0.55)", Math.max(1, 1.5 * scale));
  }

  // 路径上节点轻微提亮圈
  if (routing) {
    ctx.strokeStyle =
      routeMode === "explore"
        ? "rgba(52,211,153,0.45)"
        : "rgba(56,189,248,0.45)";
    ctx.lineWidth = Math.max(1, 1.5 * scale);
    for (const id of onRoute) {
      if (routeMode === "target" && (id === routeGoal || routeVias.includes(id))) {
        continue;
      }
      const n = byId.get(id);
      if (!n) continue;
      const s = worldToScreen(n.position_x, n.position_y);
      ctx.beginPath();
      ctx.arc(s.x, s.y, hitR * 0.7 * scale, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // 毒圈：金色安全区（对齐游戏白/金圈）+ 中心标记
  const mc = getMiasmaCenter(state);
  if (mc) {
    const s = worldToScreen(mc.x, mc.y);
    ctx.save();

    // 大圈：半透明金色填充 + 亮金描边（参考游戏安全区观感）
    if (mc.radius != null && mc.radius > 0) {
      const rr = mc.radius * scale;
      const grad = ctx.createRadialGradient(s.x, s.y, rr * 0.55, s.x, s.y, rr);
      grad.addColorStop(0, "rgba(255, 214, 120, 0.05)");
      grad.addColorStop(0.72, "rgba(255, 196, 80, 0.10)");
      grad.addColorStop(0.92, "rgba(255, 210, 110, 0.22)");
      grad.addColorStop(1, "rgba(255, 230, 150, 0.08)");
      ctx.beginPath();
      ctx.arc(s.x, s.y, rr, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();
      // 外环金边
      ctx.strokeStyle = "rgba(255, 214, 120, 0.85)";
      ctx.lineWidth = Math.max(2, 2.5 * scale);
      ctx.setLineDash([]);
      ctx.stroke();
      // 内虚线提示可活动区
      ctx.strokeStyle = "rgba(255, 236, 180, 0.45)";
      ctx.lineWidth = Math.max(1, 1.2 * scale);
      ctx.setLineDash([6 * scale, 8 * scale]);
      ctx.beginPath();
      ctx.arc(s.x, s.y, rr * 0.98, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 中心十字小点
    const r = Math.max(6, 10 * scale);
    ctx.strokeStyle = "rgba(255, 236, 180, 0.95)";
    ctx.fillStyle = "rgba(255, 214, 120, 0.45)";
    ctx.lineWidth = Math.max(1.5, 2 * scale);
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(s.x - r * 1.6, s.y);
    ctx.lineTo(s.x + r * 1.6, s.y);
    ctx.moveTo(s.x, s.y - r * 1.6);
    ctx.lineTo(s.x, s.y + r * 1.6);
    ctx.stroke();
    ctx.fillStyle = "rgba(255, 236, 180, 0.95)";
    ctx.font = `${Math.max(10, 11 * scale)}px sans-serif`;
    ctx.textAlign = "left";
    const cd = mc.countdown != null ? ` 倒计时${mc.countdown}` : "";
    const radTxt = mc.radius != null ? ` r=${Math.round(mc.radius)}` : "";
    ctx.fillText(
      `安全区 Lv${mc.level ?? "?"}${cd}${radTxt}`,
      s.x + r + 4,
      s.y - 4
    );
    ctx.restore();
  }

  setZoomLabels();
  updateNodeTip();
}

function hitTest(sx, sy) {
  const nodes = state?.node_list || [];
  const w = screenToWorld(sx, sy);
  let best = null;
  let bestD = Infinity;
  const r2 = hitR * hitR;
  for (const n of nodes) {
    if (n.node_type === 0 && !showEmpty.checked) continue;
    const dx = w.x - n.position_x;
    const dy = w.y - n.position_y;
    const d = dx * dx + dy * dy;
    if (d <= r2 && d < bestD) {
      bestD = d;
      best = n.node_id;
    }
  }
  return best;
}

/** 选中节点：只画选中圈。详情提示纯粹跟随鼠标悬停，不会因为选中而一直挂着 */
function showDetail(nid) {
  selectedId = nid;
  scheduleDraw();
}

/** 提示里当前渲染的是哪个节点、哪一版地图状态，避免每帧重建 DOM */
let tipRenderedKey = "";
/** 说明文字里夹带的枚举名 / id，如「（RESEARCHER, id=8）」 */
const DEV_PARENTHETICAL = /[（(][A-Za-z0-9_=,.\s-]+[）)]/g;

/**
 * 节点详情浮在鼠标悬停的图标旁边，鼠标移开就收起。
 * 选特殊事件、点快捷目标、右键设目标都不会让它停留；拖动地图时也不显示。
 */
function updateNodeTip() {
  const tip = $("node-tip");
  const id = dragging ? null : hoverId;
  const node = id == null ? null : (state?.node_list || []).find((x) => x.node_id === id);
  if (!node) {
    tip.hidden = true;
    tipRenderedKey = "";
    return;
  }
  const key = `${id}|${state?.updatedAt || 0}|${shopState?.updatedAt || 0}`;
  if (key !== tipRenderedKey) {
    const view = buildNodeDetailView(node, state);
    // 悬浮提示只给玩家看：名称、状态、一句说明。
    // 接口字段、枚举名、图标文件名这类开发资料一律不显示。
    view.tips = [];
    view.legendLine = "";
    view.summary = String(view.summary || "").replace(DEV_PARENTHETICAL, "").trim();
    if (Number(node.node_type) === NODE_TYPE.SHOP) {
      // 商店：这家还剩什么、多少钱；没去过就按本局见过的价格估
      const info = shopInfo(shopState, id);
      const coins = currentCoins();
      const worth = shopMultiplier(shopState, id, coins);
      view.summary =
        `${describeShop(shopState, id)}。` +
        (coins != null ? `现在有 ${coins} 币，寻路权重 ×${worth}。` : "");
      view.tips = info.remaining
        .slice()
        .sort((a, b) => a.price - b.price)
        .slice(0, 8)
        .map((item) => `${item.price} 币${item.stock > 1 ? ` ×${item.stock}` : ""}　${shopItemName(item)}`);
    }
    renderNodeDetail($("detail"), view, { showDebug: false });
    tipRenderedKey = key;
  }
  tip.hidden = false;

  const point = worldToScreen(node.position_x, node.position_y);
  const viewW = canvas.clientWidth;
  const viewH = canvas.clientHeight;
  const width = tip.offsetWidth;
  const height = tip.offsetHeight;
  const gap = hitR * scale + 12;
  const margin = 8;
  // 默认放在图标右侧，放不下就翻到左侧
  let left = point.x + gap;
  if (left + width > viewW - margin) left = point.x - gap - width;
  left = Math.max(margin, Math.min(left, viewW - width - margin));
  const top = Math.max(margin, Math.min(point.y - height / 2, viewH - height - margin));
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
}

function fitView() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w < 10 || h < 10) return;
  userAdjustedView = false;
  const pad = 20;
  scale = Math.min((w - pad * 2) / mapW, (h - pad * 2) / mapH);
  ox = (w - mapW * scale) / 2;
  oy = (h - mapH * scale) / 2;
  scheduleDraw();
}

/** 「附近」：放大到当前位置周围几步；没有当前位置时退回全图 */
function focusNearby() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w < 10 || h < 10) return;
  const bounds = nearbyBounds(state);
  if (!bounds) {
    fitView();
    return;
  }
  userAdjustedView = false;
  ({ scale, ox, oy } = fitBounds(bounds, w, h));
  scheduleDraw();
}

/** 地图视图：full 全图 / near 附近。按钮切换，记住上次的选择 */
const VIEW_MODE_STORAGE_KEY = "gbfroge-view-mode-v1";
let viewMode = (() => {
  try {
    return localStorage.getItem(VIEW_MODE_STORAGE_KEY) === "near" ? "near" : "full";
  } catch {
    return "full";
  }
})();

/** 按当前视图模式重新摆放地图 */
function applyViewMode() {
  if (viewMode === "near") focusNearby();
  else fitView();
}

function setViewMode(mode) {
  viewMode = mode === "near" ? "near" : "full";
  try {
    localStorage.setItem(VIEW_MODE_STORAGE_KEY, viewMode);
  } catch {
    // 存不下就只在本次会话内生效。
  }
  syncViewModeButtons();
  applyViewMode();
}

function syncViewModeButtons() {
  for (const [id, mode] of [["btn-view-full", "full"], ["btn-view-near", "near"]]) {
    const active = viewMode === mode;
    $(id).classList.toggle("is-active", active);
    $(id).setAttribute("aria-pressed", String(active));
  }
}

function centerOnCurrent() {
  const cur = state?.current_node_id;
  const n = (state?.node_list || []).find((x) => x.node_id === cur);
  if (!n) return;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  ox = w / 2 - n.position_x * scale;
  oy = h / 2 - n.position_y * scale;
  scheduleDraw();
}

function zoomBy(factor, sx, sy) {
  userAdjustedView = true;
  const before = screenToWorld(sx, sy);
  scale = Math.min(3, Math.max(0.12, scale * factor));
  ox = sx - before.x * scale;
  oy = sy - before.y * scale;
  scheduleDraw();
}

function markStaticDirty() {
  staticDirty = true;
  scheduleDraw();
}

function buildLegend() {
  const box = $("legend-bar");
  box.innerHTML = "";

  const items = [
    {
      key: "current",
      label: "当前位置",
      src: assetUrl("assets/node_icon/piece_1.png"),
      filter: { kind: "current" },
    },
  ];
  for (const [type, meta] of Object.entries(NODE_TYPE_META)) {
    const displayType = Number(type);
    if (displayType === NODE_TYPE.EMPTY) continue;
    const src =
      displayType === NODE_TYPE.SPECIAL
        ? assetUrl("assets/node_icon/10_incident.png")
        : assetUrl(`assets/node_icon/${displayType}.png`);
    items.push({
      key: `type-${displayType}`,
      label: meta.name,
      src,
      filter: { kind: "type", displayType },
    });
  }

  for (const item of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "legend-item";
    btn.title = item.label;
    btn.setAttribute("aria-label", item.label);
    if (item.key === legendSelectedKey) btn.classList.add("is-active");
    const img = document.createElement("img");
    loadAssetImage(img, item.src);
    img.alt = item.label;
    btn.appendChild(img);
    btn.addEventListener("click", () => {
      if (legendSelectedKey === item.key) {
        legendSelectedKey = null;
        highlightFilter = null;
      } else {
        legendSelectedKey = item.key;
        highlightFilter = item.filter;
      }
      buildLegend();
      markStaticDirty();
      $("status").textContent = highlightFilter
        ? `筛选：${item.label}`
        : "已取消筛选";
    });
    box.appendChild(btn);
  }
}

function getTargetRoutePlan(goal, vias) {
  const start = state?.current_node_id;
  if (goal == null) return { path: null, error: null, map: null };
  if (start == null) {
    return {
      path: null,
      error: `已设目标 #${goal}，但当前地图没有 current_node_id（请重新进图抓包）`,
      map: null,
    };
  }
  if (!state?.node_list?.length) return { path: null, error: "当前地图没有节点", map: null };
  const map = toRouteMap(state);
  const result = planRouteWithVias(map, Number(start), Number(goal), vias, routePreset);
  return { ...result, map };
}

function renderTargetRoute(goal, vias, plan) {
  routeMode = "target";
  routeGoal = Number(goal);
  routeVias = vias.map(Number);
  routePath = plan.path;
  const sum = summarizeRoute(plan.map, plan.path);
  updateRouteStats(sum);
  $("route-hint").textContent =
    `预设「${PRESET_LABEL[routePreset]}」· 目标 #${routeGoal}` +
    (routeVias.length ? ` · 途经 ${routeVias.map((v) => "#" + v).join(",")}` : "") +
    " · 右键改目标/加途经";
  setRouteButtonsEnabled(true);
  scheduleDraw();
}

function recomputeRoute() {
  try {
    if (routeGoal == null) {
      routePath = null;
      updateRouteStats(null);
      scheduleDraw();
      return false;
    }
    const plan = getTargetRoutePlan(routeGoal, routeVias);
    if (!plan.path) {
      routePath = null;
      $("route-hint").textContent = plan.error || `无法规划当前路线`;
      updateRouteStats(null);
      setRouteButtonsEnabled(true);
      scheduleDraw();
      return false;
    }
    renderTargetRoute(routeGoal, routeVias, plan);
    return true;
  } catch (err) {
    console.error("[map] recomputeRoute failed", err);
    routePath = null;
    $("route-hint").textContent = `路径计算出错：${err?.message || err}`;
    $("status").textContent = `路径计算出错：${err?.message || err}`;
    scheduleDraw();
    return false;
  }
}

function updateRouteStats(sum) {
  const el = $("route-stats");
  if (!sum) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  el.hidden = false;
  el.innerHTML = `
    <dt>步数</dt><dd class="is-accent">${sum.steps}</dd>
    <dt>惩罚分</dt><dd>${sum.primary ?? "—"}（越小越好）</dd>
    <dt>高价值格</dt><dd>${sum.reward}（战/事/箱，越多越好）</dd>
    <dt>空地</dt><dd>${sum.empty ?? "—"}</dd>
    <dt>危险格</dt><dd>${sum.avoid}（Boss/强敌）</dd>
    <dt>路径</dt><dd>${(routePath || []).join(" → ")}</dd>
  `;
}

function setRouteButtonsEnabled(on) {
  $("btn-route-clear").disabled = !on;
}

/** 玩家主动换了路线或清掉路线：记下当前的研究者节点，之后不再自动设回 */
function dismissOpeningTarget() {
  const target = quickTarget(state, "researcher");
  if (target.nodeId != null) openingDismissedNodeId = target.nodeId;
}

function clearRoute() {
  dismissOpeningTarget();
  routeGoal = null;
  routeVias = [];
  routePath = null;
  routeMode = null;
  exploreScore = null;
  setRouteButtonsEnabled(false);
  $("route-hint").textContent = "右键节点设为目标，再右键其他节点加途经。";
  const eh = $("explore-hint");
  if (eh) {
    eh.textContent = "「生成路径」从当前位置扫一条收益最高的路线。";
  }
  updateRouteStats(null);
  const es = $("explore-stats");
  if (es) {
    es.hidden = true;
    es.innerHTML = "";
  }
  scheduleDraw();
}

/**
 * 直接把某个节点设为目标并规划蓝线。
 * @param {number} nodeId
 * @param {string} [note] 写在提示最前面的来源说明
 * @returns {boolean} 是否规划成功
 */
function routeToNode(nodeId, note = "") {
  const goal = Number(nodeId);
  if (Number(state?.current_node_id) === goal) {
    $("status").textContent = `已经在 #${goal}`;
    return false;
  }
  const plan = getTargetRoutePlan(goal, []);
  if (!plan.path || plan.path.length < 2) {
    const message = plan.error || `无法规划到 #${goal}`;
    $("route-hint").textContent = message;
    $("status").textContent = message;
    return false;
  }
  exploreScore = null;
  const es = $("explore-stats");
  es.hidden = true;
  es.innerHTML = "";
  renderTargetRoute(goal, [], plan);
  if (note) {
    $("route-hint").textContent = `${note} · ${$("route-hint").textContent}`;
    $("status").textContent = `${note}：#${goal}，${plan.path.length - 1} 步`;
  }
  return true;
}

function renderQuickTargets() {
  const box = $("quick-targets");
  box.replaceChildren();
  for (const item of QUICK_TARGETS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn ghost btn-quick";
    button.dataset.quick = item.kind;
    button.textContent = item.label;
    button.title = item.title;
    box.append(button);
  }
  box.addEventListener("click", (event) => {
    const button = event.target.closest?.("button[data-quick]");
    if (!button) return;
    const target = quickTarget(state, button.dataset.quick, {
      mayOfferRemoval: (nodeId) => mayOfferRemoval(shopState, nodeId),
    });
    if (target.nodeId == null) {
      $("status").textContent = target.reason;
      $("route-hint").textContent = target.reason;
      return;
    }
    // 点了别的快捷目标，就不再自动回到研究者
    if (button.dataset.quick !== "researcher") dismissOpeningTarget();
    if (routeToNode(target.nodeId, button.textContent)) showDetail(target.nodeId);
  });
}

/** 顶部「本局特殊事件」：点一下寻路过去 */
function renderSpecialBar() {
  const list = $("special-list");
  const items = listSpecialIncidents(state);
  $("special-empty").hidden = items.length > 0;
  $("special-empty").textContent = state?.node_list?.length ? "本局没有特殊事件" : "进图后显示";
  list.replaceChildren();
  const dist = items.length ? hopDistances(state) : new Map();
  for (const item of items) {
    // 传送口有多个入口：取最近的那个
    const nearest = item.nodeIds
      .filter((id) => dist.has(id))
      .sort((a, b) => dist.get(a) - dist.get(b))[0] ?? item.nodeId;
    const hops = dist.get(nearest);
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className =
      "special-chip" +
      (item.visited ? " is-visited" : "") +
      (item.isResearcher ? " is-researcher" : "");
    chip.dataset.nodeId = String(nearest);
    chip.textContent =
      item.name + (item.nodeIds.length > 1 ? ` ×${item.nodeIds.length}` : "") +
      (hops ? ` · ${hops}步` : "");
    chip.title = `${item.name} #${item.nodeIds.join(" / #")}${item.visited ? "（已访问）" : ""}，点击寻路`;
    list.append(chip);
  }
}

/** 开局默认目标：没有路线、研究者还没去过时，自动把它设为目标 */
function maybeRouteToOpeningTarget() {
  if (!autoResearcher.checked || routeMode != null) return;
  const nodeId = defaultOpeningTarget(state, { dismissedNodeId: openingDismissedNodeId });
  if (nodeId == null) return;
  // 每个研究者节点只自动设一次；规划失败也不反复重试
  openingDismissedNodeId = nodeId;
  routeToNode(nodeId, "开局优先：浮空城研究者");
}

function getExploreOpts() {
  return {
    day: inferDay(state),
    weights: exploreWeights,
    miasmaCenter: getMiasmaCenter(state),
    // 商店的分数按手里的币和剩余库存逐个算：钱多更值得去，买空了按空地算
    nodeScores: shopNodeScores(state, shopState, exploreWeights),
  };
}

function loadExploreWeights() {
  try {
    const saved = JSON.parse(localStorage.getItem(EXPLORE_WEIGHTS_STORAGE_KEY) || "{}");
    return Object.fromEntries(
      EXPLORE_SCORE_FIELDS.map(({ key }) => {
        const value = Number(saved[key]);
        return [key, Number.isFinite(value) ? value : EXPLORE_WEIGHTS[key]];
      })
    );
  } catch {
    return Object.fromEntries(
      EXPLORE_SCORE_FIELDS.map(({ key }) => [key, EXPLORE_WEIGHTS[key]])
    );
  }
}

function saveExploreWeights() {
  try {
    localStorage.setItem(EXPLORE_WEIGHTS_STORAGE_KEY, JSON.stringify(exploreWeights));
  } catch {
    // 页面仍可使用当前会话内的评分。
  }
}

function renderExploreScoreControls() {
  const root = $("explore-score-controls");
  if (!root) return;
  root.replaceChildren();
  for (const { key, label } of EXPLORE_SCORE_FIELDS) {
    const row = document.createElement("div");
    row.className = "explore-score-row";
    row.innerHTML = `
      <label for="explore-score-${key}">${label}</label>
      <input id="explore-score-${key}" type="range" min="-50" max="50" step="1" value="${exploreWeights[key]}" data-score-key="${key}" />
      <input type="number" min="-50" max="50" step="1" value="${exploreWeights[key]}" data-score-number="${key}" aria-label="${label}评分" />
    `;
    root.append(row);
  }

  const update = (key, rawValue) => {
    const value = Math.max(-50, Math.min(50, Number(rawValue)));
    if (!Number.isFinite(value)) return;
    exploreWeights[key] = value;
    const range = root.querySelector(`[data-score-key="${key}"]`);
    const number = root.querySelector(`[data-score-number="${key}"]`);
    if (range) range.value = String(value);
    if (number) number.value = String(value);
    saveExploreWeights();
    refreshExploreLegend();
  };
  root.addEventListener("input", (event) => {
    const key = event.target?.dataset?.scoreKey;
    if (key) update(key, event.target.value);
  });
  root.addEventListener("change", (event) => {
    const key = event.target?.dataset?.scoreNumber;
    if (key) update(key, event.target.value);
  });
}

function refreshExploreLegend() {
  const el = $("explore-score-legend");
  if (!el) return;
  const opts = getExploreOpts();
  const mc = opts.miasmaCenter;
  const miasmaNote = mc
    ? (() => {
        const shrink = describeShrink(toRouteMap(state));
        return shrink?.speed
          ? ` · 缩圈中：圈每回合约缩 ${Math.round(shrink.speed)}（看最近 ${shrink.samples} 回合），路线避开到时会被吞的格子`
          : " · 缩圈中：先进圈；多走几回合学到缩圈速度后，会避开到时会被吞的格子";
      })()
    : "";
  const coins = currentCoins();
  const shopNote =
    exploreWeights.SHOP < 0
      ? ` · 商店按币数和剩余库存加权（${coins != null ? `现有 ${coins} 币` : "币数未知，按 1 倍"}，最多 ×2.5，买空按空地）`
      : "";
  el.textContent = `计分：${describeExploreScores(opts)}${shopNote}${miasmaNote}`;
}

function loadExploreDown() {
  const fallback = { enabled: true, upAfterEdge: true, weight: DOWN_BIAS_WEIGHT };
  try {
    const saved = JSON.parse(localStorage.getItem(EXPLORE_DOWN_STORAGE_KEY) || "{}");
    const weight = Number(saved.weight);
    return {
      enabled: saved.enabled !== false,
      upAfterEdge: saved.upAfterEdge !== false,
      weight: Number.isFinite(weight) && weight >= 0 && weight <= 50 ? weight : DOWN_BIAS_WEIGHT,
    };
  } catch {
    return fallback;
  }
}

function readExploreDown() {
  const weight = Number($("explore-down-weight").value);
  return {
    enabled: $("explore-down").checked,
    upAfterEdge: $("explore-up").checked,
    weight: Number.isFinite(weight) ? Math.max(0, Math.min(50, weight)) : DOWN_BIAS_WEIGHT,
  };
}

function initExploreDownControls() {
  const saved = loadExploreDown();
  $("explore-down").checked = saved.enabled;
  $("explore-up").checked = saved.upAfterEdge;
  $("explore-down-weight").value = String(saved.weight);
  const persist = () => {
    try {
      localStorage.setItem(EXPLORE_DOWN_STORAGE_KEY, JSON.stringify(readExploreDown()));
    } catch {
      // 存不下也不影响本次会话的设置。
    }
  };
  $("explore-down").addEventListener("change", persist);
  $("explore-up").addEventListener("change", persist);
  $("explore-down-weight").addEventListener("change", persist);
}

function updateExplorePointsLabel() {
  const sl = $("explore-points");
  const lab = $("explore-points-val");
  if (sl && lab) lab.textContent = String(sl.value);
}

function runExploreGenerate() {
  try {
    const start = state?.current_node_id;
    if (start == null || !state?.node_list?.length) {
      $("explore-hint").textContent =
        "没有当前位置：请先在游戏进图，让扩展抓到 content/index。";
      return;
    }
    const n = Number($("explore-points")?.value || 20);
    const opts = getExploreOpts();
    refreshExploreLegend();
    $("explore-hint").textContent =
      `正在枚举 ≤${n} 点最低分路径（第 ${opts.day} 天）…`;
    $("status").textContent = `收益扫路计算中（D${opts.day} · ≤${n} 点）…`;
    requestAnimationFrame(() => {
      const t0 = performance.now();
      const map = toRouteMap(state);
      // 缩圈位置未知时的扫图方向：先向下到边缘，到过之后掉头往上、往中间走；
      // 缩圈出现后不再偏向任何方向（由「留在圈内」的规则接管）
      const downSetting = readExploreDown();
      const miasmaActive = Boolean(getMiasmaCenter(state));
      const sweepEnabled = (downSetting.enabled || downSetting.upAfterEdge) && downSetting.weight > 0;
      const downBias = sweepEnabled
        ? makeSweepBias(map, Number(start), {
            weight: downSetting.weight,
            downFirst: downSetting.enabled,
            upAfterEdge: downSetting.upAfterEdge,
            visitedIds: (state.node_list || [])
              .filter((node) => node.is_visited)
              .map((node) => Number(node.node_id)),
            miasmaActive,
          })
        : null;
      const downNote = !sweepEnabled
        ? ""
        : downBias?.phase === "down"
          ? " · 先向下到边缘"
          : downBias?.phase === "up"
            ? " · 向上并靠中间"
            : miasmaActive
              ? " · 缩圈已出现，不再偏向"
              : " · 已到边缘";
      // 计划粘性：当前位置还在旧路线开头时，旧路线剩余段作为候选，
      // 新方案好不过 REPLAN_STICKINESS 分就沿用，避免每走一步路线大变
      const previousPath =
        routeMode === "explore" &&
        Array.isArray(routePath) &&
        routePath[0] === Number(start)
          ? routePath
          : null;
      const result = findLowestScorePathSticky(map, Number(start), n, {
        ...opts,
        downBias,
        previousPath,
      });
      const ms = Math.round(performance.now() - t0);
      if (!result) {
        $("explore-hint").textContent =
          `未找到 ≤${n} 点的简单路径（图连通/点数不足）。`;
        $("status").textContent = "扫路失败";
        return;
      }
      dismissOpeningTarget();
      routeMode = "explore";
      routeGoal = null;
      routeVias = [];
      routePath = result.path;
      exploreScore = result.score;
      setRouteButtonsEnabled(true);

      const keptNote = result.keptPrevious
        ? " · 沿用旧路线（未明显更好）"
        : " · 已换新路线";
      const maxN = result.maxPoints ?? n;
      const es = $("explore-stats");
      if (es) {
        es.hidden = false;
        es.innerHTML = `
          <dt>日程</dt><dd>第 ${result.day} 天</dd>
          <dt>点数</dt><dd class="is-accent">${result.numPoints} / ≤${maxN}</dd>
          <dt>累计分</dt><dd class="is-accent">${result.score.toFixed(1)}（越低越好）</dd>
          <dt>负分格</dt><dd>${result.rewardCount}</dd>
          <dt>正分格</dt><dd>${result.penaltyCount}</dd>
          <dt>回复计分</dt><dd>${result.weights?.HEAL ?? exploreWeights.HEAL}</dd>
          <dt>换路</dt><dd>${result.keptPrevious ? `沿用旧路（阈值 ${REPLAN_STICKINESS}）` : "采用新规划"}</dd>
          <dt>自由重算分</dt><dd>${Number(result.freshScore).toFixed(1)}</dd>
          <dt>耗时</dt><dd>${ms} ms · 展开 ${result.nodesVisited}</dd>
          <dt>路径</dt><dd>${result.path.join(" → ")}</dd>
        `;
      }
      const mc = getMiasmaCenter(state);
      const miasmaTag = mc ? " · 已偏好留白圈内" : "";
      $("explore-hint").textContent =
        `D${result.day} · ${result.numPoints}/≤${maxN} 点 · 分 ${result.score.toFixed(1)} · 负分格 ${result.rewardCount} · 绿线${downNote}${miasmaTag}${keptNote}`;
      $("status").textContent =
        `扫路完成：D${result.day} · ${result.numPoints}/≤${maxN} · 分 ${result.score.toFixed(1)}${result.keptPrevious ? " · 沿用旧路线" : " · 新路线"}${downNote}${miasmaTag}`;
      updateRouteStats(null);
      $("route-hint").textContent =
        "当前显示为「收益扫路」（绿线）。右键目标寻路会切换为蓝线。";
      scheduleDraw();
    });
  } catch (err) {
    console.error("[map] explore generate failed", err);
    $("explore-hint").textContent = `扫路出错：${err?.message || err}`;
    $("status").textContent = `扫路出错：${err?.message || err}`;
  }
}

function onRouteRightClick(nid) {
  if (nid == null) return;
  try {
    const clickedNode = state?.node_list?.find(
      (node) => Number(node.node_id) === Number(nid)
    );
    const clickedBoss = Number(clickedNode?.node_type) === NODE_TYPE.BOSS;
    const candidate = nextTargetSelection({
      currentId: state?.current_node_id,
      clickedId: nid,
      clickedIsBoss: clickedBoss,
      routeGoal,
      routeVias,
    });
    if (candidate.action === "ignore") {
      showDetail(nid);
      return;
    }

    const plan = getTargetRoutePlan(candidate.goal, candidate.vias);
    if (!plan.path) {
      // Planning is transactional: a failed candidate must not erase the
      // last valid target, vias, or blue route.
      $("route-hint").textContent = plan.error || "无法规划该右键路线，已保留原路线";
      scheduleDraw();
      showDetail(nid);
      return;
    }

    dismissOpeningTarget();
    exploreScore = null;
    const es = $("explore-stats");
    if (es) {
      es.hidden = true;
      es.innerHTML = "";
    }
    renderTargetRoute(candidate.goal, candidate.vias, plan);
    showDetail(nid);
  } catch (err) {
    console.error("[map] onRouteRightClick failed", err);
    $("status").textContent = `右键处理失败：${err?.message || err}`;
  }
}

/**
 * 走一步后自动裁剪扫路已走部分：当前位置在绿线中段时，
 * 把已走的前缀截掉，路线其余部分保持不变（视觉稳定，不重新规划）。
 *
 * 注意：≤N 预算下重算仍有地平线效应（走一步再开 ≤N 窗口 ≈ 总行程变长）。
 * 因此默认：移动只裁剪；用户点「生成路径」才重算（带粘性）。
 */
function trimExploreRouteToCurrent() {
  if (routeMode !== "explore" || !Array.isArray(routePath) || routePath.length < 2) {
    return;
  }
  const cur = state?.current_node_id != null ? Number(state.current_node_id) : null;
  if (cur == null) return;
  const idx = routePath.indexOf(cur);
  if (idx === 0) return; // 还没动
  const eh = $("explore-hint");
  if (idx < 0) {
    if (eh) eh.textContent = "已偏离扫路路线；点「生成路径」重新规划。";
    return;
  }
  routePath = routePath.slice(idx);
  if (routePath.length < 2) {
    routePath = null;
    routeMode = null;
    exploreScore = null;
    setRouteButtonsEnabled(false);
    if (eh) eh.textContent = "扫路已走完，可重新「生成路径」。";
    return;
  }
  if (eh) {
    eh.textContent =
      `沿扫路前进：剩余 ${routePath.length - 1} 步（${routePath.join(" → ")}）；` +
      "点「生成路径」按当前位置重算（差距不足阈值则沿用旧路线）。";
  }
}

/**
 * 目标寻路：若仍在蓝线路径上，只裁剪已走前缀，保持剩余折线稳定。
 * 偏离路径 / 终点不一致时返回 false，由调用方全量 recompute。
 * @returns {boolean} 是否已成功裁剪（无需重算）
 */
function trimTargetRouteToCurrent() {
  if (routeMode !== "target" || routeGoal == null) return false;
  const cur = state?.current_node_id != null ? Number(state.current_node_id) : null;
  if (cur == null) return false;

  const goal = Number(routeGoal);
  if (cur === goal) {
    // Completion is a state transition, not a one-node route. Clear the old
    // target so the next ordinary right-click starts a new route.
    routeGoal = null;
    routeVias = [];
    routePath = null;
    routeMode = null;
    exploreScore = null;
    updateRouteStats(null);
    setRouteButtonsEnabled(false);
    $("route-hint").textContent = `已到达目标 #${goal}。右键可设新目标。`;
    return true;
  }

  const map = toRouteMap(state);
  const byId = new Map(map.nodes.map((node) => [Number(node.id), node]));
  routeVias = routeVias.filter((viaId) => {
    const id = Number(viaId);
    const node = byId.get(id);
    return (
      node != null &&
      id !== cur &&
      id !== goal &&
      node.displayType !== NODE_TYPE.BOSS
    );
  });

  if (!Array.isArray(routePath) || routePath.length < 2) return false;

  const idx = routePath.indexOf(cur);
  if (idx < 0) return false;
  if (Number(routePath[routePath.length - 1]) !== goal) return false;

  const candidatePath = routePath.slice(idx);
  if (!isValidTargetRoute(map, candidatePath, goal, routePreset)) return false;
  routePath = candidatePath;
  // 途经点若已走过则丢掉
  if (routeVias.length) {
    const remain = new Set(routePath);
    routeVias = routeVias.filter((v) => remain.has(Number(v)) && Number(v) !== cur);
  }
  updateRouteStats(summarizeRoute(map, routePath));
  $("route-hint").textContent =
    `沿路线前进 · 预设「${PRESET_LABEL[routePreset]}」· 目标 #${goal}` +
    (routeVias.length ? ` · 途经 ${routeVias.map((v) => "#" + v).join(",")}` : "") +
    " · 剩余 " +
    (routePath.length - 1) +
    " 步";
  return true;
}

function updateProgressUI(sum) {
  const line = $("progress-line");
  line.textContent = sum?.progressLine || "第 — 天 · 第 — 回合";
  // 瘴气说明较长，收进悬停提示
  line.title = sum?.miasmaText ? `瘴气：${sum.miasmaText}` : "";
  const hasPoint = sum?.dungeonPoint != null && sum.dungeonPoint !== "";
  $("progress-point").textContent = `币 ${hasPoint ? sum.dungeonPoint : "—"}`;
}

function updateMapFooter(sum = summarize(state)) {
  if (sum.nodes) {
    $("status").textContent =
      `${sum.progressLine} · 更新 ${sum.updatedAt ? new Date(sum.updatedAt).toLocaleTimeString() : "—"} · ` +
      `Boss=${sum.boss ?? "无"}`;
  } else {
    $("status").textContent = "等待 content/index 捕获…";
  }
}

function updateGuidebookFooter(summary = guidebookView.getSummary()) {
  $("status").textContent = summary.catalogueTotal
    ? `导本 · 当前 ${summary.heldKinds} 种 / ${summary.heldTotal} 本 · 累计收录 ${summary.catalogueTotal} 种`
    : "导本 · 尚未捕获数据";
}

function switchWindowView(view) {
  activeWindowView = view;
  document.querySelectorAll("[data-window-view]").forEach((button) => {
    const active = button.dataset.windowView === view;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  });
  $("main").hidden = view !== "map";
  $("special-bar").hidden = view !== "map";
  $("guidebook-view").hidden = view !== "guidebooks";
  $("settings-view").hidden = view !== "settings";

  if (view === "map") {
    updateMapFooter();
    document.title = `${summarize(state).name || "地图"} — ${summarize(state).progressLine}`;
    requestAnimationFrame(() => {
      resizeCanvas();
      // 在别的页签时画布尺寸为 0，切回来要重新铺一次
      if (autoFit.checked && !userAdjustedView) applyViewMode();
      scheduleDraw();
    });
  } else if (view === "guidebooks") {
    updateGuidebookFooter();
    document.title = "导本 · 盘子 — gbfroge";
  } else {
    $("status").textContent = "设置会自动保存";
    document.title = "设置 — gbfroge";
  }
}

function applyState(s) {
  // 回合数变小说明开了新一局：上一局放弃过的开局目标不再作数
  const previousTurn = Number(state?.total_turn);
  const nextTurn = Number(s?.total_turn);
  if (Number.isFinite(previousTurn) && Number.isFinite(nextTurn) && nextTurn < previousTurn) {
    openingDismissedNodeId = null;
  }
  const previousNodeId = state?.current_node_id;
  const hadNodes = Boolean(state?.node_list?.length);
  state = s;
  // 附近模式跟随当前位置：走了一步、或者第一次拿到地图时重新对准
  if (
    viewMode === "near" &&
    state?.node_list?.length &&
    (!hadNodes || Number(previousNodeId) !== Number(state.current_node_id))
  ) {
    focusNearby();
  }
  ensureAssets();
  markStaticDirty();
  const sum = summarize(state);
  updateProgressUI(sum);
  refreshExploreLegend();
  if (sum.nodes) {
    $("badge").textContent = `${sum.nodes} 节点 · #${sum.current ?? "?"}`;
    $("badge").className = "badge ok";
    $("title").textContent = sum.name || "转世沙盒地图";
    if (activeWindowView === "map") {
      document.title = `${sum.name || "地图"} — ${sum.progressLine}`;
    }
  } else {
    $("badge").textContent = "无数据";
    $("badge").className = "badge";
  }
  if (activeWindowView === "map") updateMapFooter(sum);
  buildLegend();

  // 移动后优先裁剪已有路线（保持「下一步」稳定）；只有偏离/无路线才全量重算。
  // 收益预设下全量重算会因访问后 type→0 与词典序收益重排而改道——那是状态变化，不是算错。
  if (routeMode === "explore") {
    trimExploreRouteToCurrent();
    scheduleDraw();
  } else if (routeMode === "target" && routeGoal != null) {
    if (!trimTargetRouteToCurrent()) {
      recomputeRoute();
    } else {
      scheduleDraw();
    }
  } else {
    scheduleDraw();
  }
  maybeRouteToOpeningTarget();
  renderSpecialBar();
}

// —— 交互：仅左键拖拽/点选；右键设路线（避免 capture 吞掉右键）——
/** @type {number|null} */
let activePointerId = null;
/** 防止 pointerup(button=2) 与 contextmenu 双触发（支持任意事件顺序） */
let lastRightClickGesture = null;

function handleRightClickGesture(id, source, x, y) {
  const now = Date.now();
  const current = {
    nodeId: id == null ? null : Number(id),
    source,
    x,
    y,
    time: now,
  };
  if (isDuplicateRightClick(lastRightClickGesture, current)) {
    // Consume the paired browser event. A fast second right-click must start
    // a new gesture instead of being mistaken for this one's companion.
    lastRightClickGesture = null;
    return;
  }
  // Record before routing so the companion browser event is suppressed even
  // when route planning throws or updates the DOM synchronously.
  lastRightClickGesture = current;
  if (id != null) onRouteRightClick(id);
}

function endPointerDrag(e) {
  if (activePointerId != null && e && e.pointerId !== activePointerId) {
    return false;
  }
  const wasDragging = dragging;
  const wasMoved = dragMoved;
  dragging = false;
  dragMoved = false;
  canvas.classList.remove("dragging");
  if (activePointerId != null) {
    try {
      canvas.releasePointerCapture(activePointerId);
    } catch (_) {}
    activePointerId = null;
  }
  return wasDragging && !wasMoved;
}

canvas.addEventListener("pointerdown", (e) => {
  // 只响应主按钮；中键/右键绝不 setPointerCapture
  if (e.button !== 0) return;
  activePointerId = e.pointerId;
  dragging = true;
  dragMoved = false;
  lastX = e.clientX;
  lastY = e.clientY;
  canvas.classList.add("dragging");
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch (_) {}
});

canvas.addEventListener("pointermove", (e) => {
  if (dragging && activePointerId === e.pointerId) {
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    if (Math.abs(dx) + Math.abs(dy) > 2) {
      dragMoved = true;
      userAdjustedView = true;
    }
    ox += dx;
    oy += dy;
    lastX = e.clientX;
    lastY = e.clientY;
    scheduleDraw();
    return;
  }

  // 未拖拽时做 hover（不强制每帧，仅 id 变化时重绘）
  if (dragging) return;
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  const id = hitTest(sx, sy);
  if (id !== hoverId) {
    hoverId = id;
    if (id != null && state?.node_list) {
      const n = state.node_list.find((x) => x.node_id === id);
      if (n) {
        const meta = NODE_TYPE_META[n.node_type];
        $("status").textContent =
          `#${id} ${meta?.name || typeName(n.node_type)}  邻接=${JSON.stringify(n.adjacent_node_ids)}`;
      }
      canvas.style.cursor = "pointer";
    } else {
      canvas.style.cursor = "grab";
    }
    scheduleDraw();
  }
});

canvas.addEventListener("pointerup", (e) => {
  // 右键：设路线目标/途经（部分环境 contextmenu 不可靠）
  if (e.button === 2) {
    endPointerDrag(e);
    const rect = canvas.getBoundingClientRect();
    const id = hitTest(e.clientX - rect.left, e.clientY - rect.top);
    handleRightClickGesture(id, "pointerup", e.clientX, e.clientY);
    return;
  }

  if (e.button !== 0) {
    endPointerDrag(e);
    return;
  }

  const isClick = endPointerDrag(e);
  if (isClick) {
    const rect = canvas.getBoundingClientRect();
    // 点到节点：选中；点空白处：取消选中
    showDetail(hitTest(e.clientX - rect.left, e.clientY - rect.top));
  }
});

canvas.addEventListener("pointercancel", (e) => {
  endPointerDrag(e);
});

canvas.addEventListener("pointerleave", () => {
  if (hoverId == null) return;
  hoverId = null;
  scheduleDraw();
});

canvas.addEventListener("lostpointercapture", () => {
  dragging = false;
  dragMoved = false;
  activePointerId = null;
  canvas.classList.remove("dragging");
});

canvas.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  e.stopPropagation();
  const rect = canvas.getBoundingClientRect();
  const id = hitTest(e.clientX - rect.left, e.clientY - rect.top);
  handleRightClickGesture(id, "contextmenu", e.clientX, e.clientY);
});

canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - rect.left, e.clientY - rect.top);
  },
  { passive: false }
);

// 双击：回到当前视图模式的默认摆放（手动拖动或缩放之后用）
canvas.addEventListener("dblclick", () => applyViewMode());

$("btn-view-full").addEventListener("click", () => setViewMode("full"));
$("btn-view-near").addEventListener("click", () => setViewMode("near"));
syncViewModeButtons();
$("btn-center").addEventListener("click", () => {
  userAdjustedView = true;
  centerOnCurrent();
});

function applyLegendVisibility() {
  $("legend-dock").hidden = !showLegend.checked;
}

showEmpty.addEventListener("change", markStaticDirty);
showIds.addEventListener("change", markStaticDirty);
showLegend.addEventListener("change", applyLegendVisibility);
autoFit.addEventListener("change", () => {
  if (autoFit.checked) applyViewMode();
});
autoResearcher.addEventListener("change", maybeRouteToOpeningTarget);
for (const input of Object.values(MAP_SETTING_INPUTS)) {
  input.addEventListener("change", saveMapSettings);
}
applyLegendVisibility();

// 底图亮度滑杆
const bgBrightSlider = $("bg-bright");
const bgBrightVal = $("bg-bright-val");
function syncBgBrightUI() {
  if (bgBrightSlider) bgBrightSlider.value = String(bgBrightness);
  if (bgBrightVal) bgBrightVal.textContent = `${bgBrightness}%`;
}
if (bgBrightSlider) {
  syncBgBrightUI();
  bgBrightSlider.addEventListener("input", () => {
    bgBrightness = Number(bgBrightSlider.value) || 100;
    localStorage.setItem("map_bg_brightness", String(bgBrightness));
    syncBgBrightUI();
    markStaticDirty();
  });
}
$("btn-legend-collapse").addEventListener("click", () => {
  $("legend-dock").classList.toggle("is-collapsed");
});

document.querySelectorAll(".btn-preset").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".btn-preset").forEach((b) => b.classList.remove("is-active"));
    btn.classList.add("is-active");
    routePreset = btn.dataset.preset || "short";
    if (routeGoal != null) recomputeRoute();
  });
});
$("btn-route-clear").addEventListener("click", clearRoute);

// 收益扫路
const exploreSlider = $("explore-points");
if (exploreSlider) {
  exploreSlider.addEventListener("input", updateExplorePointsLabel);
  updateExplorePointsLabel();
}
renderExploreScoreControls();
initExploreDownControls();
$("btn-explore-gen")?.addEventListener("click", runExploreGenerate);
renderQuickTargets();
$("special-list").addEventListener("click", (event) => {
  const chip = event.target.closest?.("button[data-node-id]");
  if (!chip) return;
  const nodeId = Number(chip.dataset.nodeId);
  dismissOpeningTarget();
  routeToNode(nodeId, "特殊事件");
  showDetail(nodeId);
});
refreshExploreLegend();

document.querySelectorAll("[data-window-view]").forEach((button) => {
  button.addEventListener("click", () => switchWindowView(button.dataset.windowView));
});

window.addEventListener("resize", () => {
  if (activeWindowView !== "map") return;
  resizeCanvas();
  if (autoFit.checked) applyViewMode();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === MSG.STATE_UPDATED) applyState(msg.state);
  if (msg?.type === MSG.GUIDEBOOKS_UPDATED) applyGuidebooks(msg.state);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.arcarum3MapState) {
    applyState(changes.arcarum3MapState.newValue || null);
  }
  if (changes.arcarum3Guidebooks) {
    applyGuidebooks(changes.arcarum3Guidebooks.newValue || null);
  }
  if (changes[DECK_STORAGE_KEY]) buildView.setDeck(changes[DECK_STORAGE_KEY].newValue || null);
  if (changes[BATTLE_STORAGE_KEY]) {
    buildView.setBattle(changes[BATTLE_STORAGE_KEY].newValue || null);
  }
  if (changes[OMEN_STORAGE_KEY]) buildView.setOmens(changes[OMEN_STORAGE_KEY].newValue || null);
  if (changes[PARTY_STORAGE_KEY]) buildView.setParty(changes[PARTY_STORAGE_KEY].newValue || null);
  if (changes[ENEMY_STORAGE_KEY]) buildView.setEnemies(changes[ENEMY_STORAGE_KEY].newValue || null);
  if (changes[SHOP_STORAGE_KEY]) applyShops(changes[SHOP_STORAGE_KEY].newValue || null);
});

function applyShops(next) {
  shopState = next;
  refreshExploreLegend();
  scheduleDraw();
}

/**
 * 两种刷新：
 *   1. 推送 —— 玩家在游戏里每做一步，后台写入存储，上面的监听立刻更新；
 *   2. 兜底 —— 每 10 秒、以及窗口切回前台时，直接读一遍存储，和手里的不一样才重画。
 * 兜底只读本地存储，不会向游戏服务器发任何请求。
 */
const RESYNC_INTERVAL_MS = 10_000;
/** 各份数据上次兜底同步时的内容：没变就不重画（重画会打断悬浮提示） */
const resyncSeen = new Map();
const RESYNC_TARGETS = [
  ["arcarum3MapState", (value) => applyState(value)],
  ["arcarum3Guidebooks", (value) => applyGuidebooks(value)],
  [DECK_STORAGE_KEY, (value) => buildView.setDeck(value)],
  [OMEN_STORAGE_KEY, (value) => buildView.setOmens(value)],
  [PARTY_STORAGE_KEY, (value) => buildView.setParty(value)],
  [ENEMY_STORAGE_KEY, (value) => buildView.setEnemies(value)],
  [SHOP_STORAGE_KEY, (value) => applyShops(value)],
  [BATTLE_STORAGE_KEY, (value) => buildView.setBattle(value)],
];

async function resync() {
  if (document.hidden) return;
  let bag;
  try {
    bag = await chrome.storage.local.get(RESYNC_TARGETS.map(([key]) => key));
  } catch {
    return;
  }
  for (const [key, apply] of RESYNC_TARGETS) {
    // 存储里没有这一项时不动：清空由推送负责
    if (!bag || !(key in bag)) continue;
    const signature = JSON.stringify(bag[key] ?? null);
    const seen = resyncSeen.get(key);
    resyncSeen.set(key, signature);
    // 第一次只记下内容（刚打开窗口时已经读过一遍）
    if (seen === undefined || seen === signature) continue;
    apply(bag[key] ?? null);
  }
}

/** 设置页「排查」：导出 / 清空内存里的抓包记录 */
async function readCaptureLog() {
  try {
    return (await chrome.storage.session.get(CAPTURE_LOG_STORAGE_KEY))?.[CAPTURE_LOG_STORAGE_KEY] || null;
  } catch {
    return null;
  }
}

async function refreshCaptureCount() {
  const count = (await readCaptureLog())?.entries?.length || 0;
  $("capture-log-count").textContent = count ? `已记录 ${count} 条` : "还没有记录";
  $("btn-export-captures").disabled = !count;
  $("btn-clear-captures").disabled = !count;
}

$("btn-export-captures").addEventListener("click", async () => {
  const log = await readCaptureLog();
  if (!log?.entries?.length) return;
  const payload = exportCaptureLog(log, { version: chrome.runtime.getManifest?.().version || "" });
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `gbfroge-captures-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

$("btn-clear-captures").addEventListener("click", async () => {
  try {
    await chrome.storage.session.remove(CAPTURE_LOG_STORAGE_KEY);
  } catch {
    /* 没有就算了 */
  }
  refreshCaptureCount();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes[CAPTURE_LOG_STORAGE_KEY]) refreshCaptureCount();
});
refreshCaptureCount();

setInterval(resync, RESYNC_INTERVAL_MS);
document.addEventListener("visibilitychange", resync);
window.addEventListener("focus", resync);

/** 右栏各折叠面板的开合状态，下次打开窗口时保持 */
const FOLD_STORAGE_KEY = "gbfroge-panel-folds-v1";
function initPanelFolds() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(FOLD_STORAGE_KEY) || "{}") || {};
  } catch {
    saved = {};
  }
  const folds = [...document.querySelectorAll("details[data-fold]")];
  for (const fold of folds) {
    if (typeof saved[fold.dataset.fold] === "boolean") fold.open = saved[fold.dataset.fold];
    fold.addEventListener("toggle", () => {
      try {
        localStorage.setItem(
          FOLD_STORAGE_KEY,
          JSON.stringify(Object.fromEntries(folds.map((item) => [item.dataset.fold, item.open])))
        );
      } catch {
        // 存不下就只在本次会话内生效。
      }
    });
  }
}
initPanelFolds();

/** 战斗 / 导本两列各自可以收成竖条；收起后地图变宽，要重新铺一次 */
const COLUMN_STORAGE_KEY = "gbfroge-panel-columns-v1";
function initPanelColumns() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(COLUMN_STORAGE_KEY) || "{}") || {};
  } catch {
    saved = {};
  }
  const columns = [...document.querySelectorAll(".panel-col[data-col]")];
  const apply = (column, collapsed) => {
    column.classList.toggle("is-collapsed", collapsed);
    const toggle = column.querySelector(".panel-col-toggle");
    toggle.setAttribute("aria-expanded", String(!collapsed));
  };
  for (const column of columns) {
    apply(column, saved[column.dataset.col] === true);
    column.querySelector(".panel-col-toggle").addEventListener("click", () => {
      apply(column, !column.classList.contains("is-collapsed"));
      try {
        localStorage.setItem(
          COLUMN_STORAGE_KEY,
          JSON.stringify(
            Object.fromEntries(columns.map((item) => [item.dataset.col, item.classList.contains("is-collapsed")]))
          )
        );
      } catch {
        // 存不下就只在本次会话内生效。
      }
      requestAnimationFrame(() => {
        resizeCanvas();
        if (autoFit.checked) applyViewMode();
      });
    });
  }
}
initPanelColumns();

// 路线详情放在设置页；主页面只在底部状态栏显示一句，免得规划失败时没有任何反馈
for (const id of ["route-hint", "explore-hint"]) {
  const source = $(id);
  new MutationObserver(() => {
    if (activeWindowView === "map" && source.textContent.trim()) {
      $("status").textContent = source.textContent.trim();
    }
  }).observe(source, { childList: true, characterData: true, subtree: true });
}

async function init() {
  resizeCanvas();
  const [mapResponse, guidebookResponse, buildResponse] = await Promise.all([
    chrome.runtime.sendMessage({ type: MSG.GET_STATE }),
    chrome.runtime.sendMessage({ type: MSG.GET_GUIDEBOOKS }),
    chrome.runtime.sendMessage({ type: MSG.GET_BUILD }),
  ]);
  applyState(mapResponse?.state || null);
  applyGuidebooks(guidebookResponse?.state || null);
  buildView.setDeck(buildResponse?.deck || null);
  buildView.setOmens(buildResponse?.omens || null);
  buildView.setParty(buildResponse?.party || null);
  buildView.setEnemies(buildResponse?.enemies || null);
  applyShops(buildResponse?.shops || null);
  buildView.setBattle(buildResponse?.battle || null);
  switchWindowView("map");
  setTimeout(() => applyViewMode(), 80);
  // 记下刚读到的内容，之后的兜底同步只在有变化时重画
  resync();
}

init();
