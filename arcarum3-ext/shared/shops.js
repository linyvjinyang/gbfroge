/**
 * 商店：记下本局每个商店格里卖什么、多少钱、还剩几件，
 * 并据此给寻路提供「这个商店现在值不值得去」。
 *
 * 价格受本局的局外加成影响（例如誓约会涨价），所以只用本局看到的价格；
 * 同类商品的价格基本固定，看过一家就能估其他家。还没进过任何商店时用默认价。
 */

export const SHOP_STATE_VERSION = 1;

/** 商品类型（游戏的 DUNGEON_SHOP_ITEM_TYPE） */
export const SHOP_ITEM_TYPE = {
  RELEASE_WEAPON: 1,
  RELEASE_SUMMON: 2,
  JOIN_CHARACTER: 3,
  BOOK_EFFECT: 4,
  ITEM: 5,
  REMOVE_BOOK_EFFECT: 6,
};

/** 本局还没见过任何价格时的估计价（进过一次商店后就不再用它） */
export const DEFAULT_SHOP_PRICE = 150;
/** 商店权重最多放大到几倍：钱再多、再便宜，也不值得绕太远 */
export const SHOP_MAX_MULTIPLIER = 2.5;
/** 比同类正常价便宜到这个比例以下算打折 */
export const SHOP_DISCOUNT_RATIO = 0.8;
/** 打折商店额外加的倍数（仍受上限约束） */
export const SHOP_DISCOUNT_BONUS = 0.5;

const NON_STACKABLE = /重複不可|不可重复|can't be stacked/i;

export function createShopState() {
  return { version: SHOP_STATE_VERSION, shops: {}, coin: null, updatedAt: null };
}

function toNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function cleanText(value) {
  return String(value ?? "").replace(/@@/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/** 同类商品的归类键：导本按稀有度分，其余按商品类型分 */
export function shopItemCategory(item) {
  const type = Number(item?.itemType);
  if (type === SHOP_ITEM_TYPE.BOOK_EFFECT || (!type && item?.statusId != null)) {
    return `book:${item?.rarity ?? "?"}`;
  }
  return `type:${type || "?"}`;
}

function itemRecord(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = cleanText(raw.item_name || raw.name || raw.comment);
  const comment = cleanText(raw.item_comment || raw.comment);
  const statusId = toNumber(raw.status_id);
  let itemType = toNumber(raw.item_type);
  // 没给类型时按内容补：有 status_id 的是导本，名字是「導本効果削除」的是消除导本
  if (!itemType) {
    itemType = statusId ? SHOP_ITEM_TYPE.BOOK_EFFECT : /導本効果削除/.test(name) ? SHOP_ITEM_TYPE.REMOVE_BOOK_EFFECT : null;
  }
  const item = {
    lineupId: toNumber(raw.lineup_id),
    itemType,
    statusId: statusId && statusId > 0 ? statusId : null,
    name,
    price: toNumber(raw.price) ?? 0,
    stock: Math.max(0, toNumber(raw.stock_num) ?? (raw.can_purchase ? 1 : 0)),
    rarity: toNumber(raw.rarity),
    nonStackable: NON_STACKABLE.test(`${name} ${comment}`),
  };
  if (item.lineupId == null && !item.name) return null;
  return { ...item, category: shopItemCategory(item) };
}

/**
 * 进了商店：记下这一页的货架。
 * @param {{ nodeId: number, tabId?: number | null, response: any, now?: number }} seen
 * @returns {{ state: object, changed: boolean }}
 */
export function recordShopLineup(previous, seen) {
  const state = previous?.version === SHOP_STATE_VERSION ? previous : createShopState();
  const nodeId = toNumber(seen?.nodeId);
  const list = seen?.response?.item_list ?? seen?.response?.data?.item_list;
  if (nodeId == null || !Array.isArray(list)) return { state, changed: false };

  const now = seen.now ?? Date.now();
  const tabKey = String(seen.tabId ?? 0);
  const known = state.shops[nodeId];
  const coin = toNumber(seen.response?.coin_amount ?? seen.response?.data?.coin_amount);
  return {
    state: {
      ...state,
      coin: coin ?? state.coin,
      updatedAt: now,
      shops: {
        ...state.shops,
        [nodeId]: {
          nodeId,
          tabs: { ...known?.tabs, [tabKey]: list.map(itemRecord).filter(Boolean) },
          firstSeenAt: known?.firstSeenAt ?? now,
          updatedAt: now,
        },
      },
    },
    changed: true,
  };
}

/**
 * 买了一件：对应商品的库存 -1。优先在指定的商店里找，找不到再全局按 lineup_id 找。
 * @returns {{ state: object, changed: boolean }}
 */
export function recordShopPurchase(previous, { nodeId, lineupId, now = Date.now() } = {}) {
  const state = previous?.version === SHOP_STATE_VERSION ? previous : createShopState();
  const target = toNumber(lineupId);
  if (target == null) return { state, changed: false };
  const order = [toNumber(nodeId), ...Object.keys(state.shops).map(Number)].filter((id) => id != null);
  for (const id of new Set(order)) {
    const shop = state.shops[id];
    if (!shop) continue;
    for (const [tabKey, items] of Object.entries(shop.tabs)) {
      const index = items.findIndex((item) => item.lineupId === target && item.stock > 0);
      if (index < 0) continue;
      const nextItems = items.map((item, i) => (i === index ? { ...item, stock: item.stock - 1 } : item));
      return {
        state: {
          ...state,
          updatedAt: now,
          shops: { ...state.shops, [id]: { ...shop, tabs: { ...shop.tabs, [tabKey]: nextItems }, updatedAt: now } },
        },
        changed: true,
      };
    }
  }
  return { state, changed: false };
}

/** 本局各类商品的正常价：取见过的最高价（打折商店的低价不会拉低它） */
export function buildPriceBook(state) {
  const book = {};
  for (const shop of Object.values(state?.shops || {})) {
    for (const items of Object.values(shop.tabs || {})) {
      for (const item of items) {
        if (item.price > 0) book[item.category] = Math.max(book[item.category] || 0, item.price);
      }
    }
  }
  return book;
}

/** 还没去过的商店里，最便宜的东西大概多少钱 */
export function referencePrice(state) {
  const prices = Object.values(buildPriceBook(state)).filter((price) => price > 0);
  return prices.length ? Math.min(...prices) : DEFAULT_SHOP_PRICE;
}

/**
 * 某个商店格的情况。
 * @returns {{
 *   visited: boolean, items: object[], remaining: object[], remainingCount: number,
 *   cheapest: number | null, discount: boolean,
 *   removal: 'available' | 'gone' | 'none' | 'unknown',
 * }}
 *   removal：消除导本这件商品——available 还能买 / gone 买过了 / none 这家不卖 / unknown 还没看到货架
 */
export function shopInfo(state, nodeId) {
  const shop = state?.shops?.[Number(nodeId)];
  if (!shop) {
    return { visited: false, items: [], remaining: [], remainingCount: 0, cheapest: null, discount: false, removal: "unknown" };
  }
  const items = Object.values(shop.tabs || {}).flat();
  const remaining = items.filter((item) => item.stock > 0);
  const book = buildPriceBook(state);
  const removalItems = items.filter((item) => item.itemType === SHOP_ITEM_TYPE.REMOVE_BOOK_EFFECT);
  return {
    visited: true,
    items,
    remaining,
    remainingCount: remaining.reduce((sum, item) => sum + item.stock, 0),
    cheapest: remaining.length ? Math.min(...remaining.map((item) => item.price)) : null,
    discount: remaining.some(
      (item) => item.price > 0 && book[item.category] && item.price <= book[item.category] * SHOP_DISCOUNT_RATIO,
    ),
    removal: !removalItems.length ? "none" : removalItems.some((item) => item.stock > 0) ? "available" : "gone",
  };
}

/**
 * 商店的权重倍数：按手里的钱够买几件来算，封顶 SHOP_MAX_MULTIPLIER。
 *  - 没去过：用本局见过的最低正常价（没见过就用默认价）估
 *  - 去过：只看还剩的东西；卖空了返回 0
 *  - 去过且有打折货：再加一点
 *  - 不知道有多少钱：按 1 倍（和没有这个功能时一样）
 */
export function shopMultiplier(state, nodeId, coins) {
  const info = shopInfo(state, nodeId);
  if (info.visited && !info.remaining.length) return 0;
  const money = toNumber(coins);
  if (money == null) return 1;
  const price = info.visited ? info.cheapest : referencePrice(state);
  const affordable = price > 0 ? money / price : SHOP_MAX_MULTIPLIER;
  const bonus = info.discount ? SHOP_DISCOUNT_BONUS : 0;
  return Math.round(Math.max(0, Math.min(SHOP_MAX_MULTIPLIER, affordable + bonus)) * 10) / 10;
}

/**
 * 给扫路用的逐格分数：每个商店格按上面的倍数放大「商店」权重；
 * 卖空了或者一件都买不起的商店按空地算。
 *
 * @param {{ node_list?: any[], possession_arcarum3_dungeon_point?: number }} mapState
 * @param {{ SHOP: number, EMPTY: number }} weights
 * @returns {Map<number, number>}
 */
export function shopNodeScores(mapState, shopState, weights) {
  const scores = new Map();
  const shopWeight = Number(weights?.SHOP);
  // 玩家把商店设成不鼓励（非负分）时，不去改它
  if (!Number.isFinite(shopWeight) || shopWeight >= 0) return scores;
  const coins = mapState?.possession_arcarum3_dungeon_point ?? shopState?.coin ?? null;
  for (const node of mapState?.node_list || []) {
    if (Number(node.node_type) !== 8) continue;
    const multiplier = shopMultiplier(shopState, node.node_id, coins);
    scores.set(Number(node.node_id), multiplier > 0 ? shopWeight * multiplier : Number(weights.EMPTY) || 0);
  }
  return scores;
}

/** 「消除导本」还可能买得到的商店：没去过的，或者去过、这件还没买的 */
export function mayOfferRemoval(state, nodeId) {
  const removal = shopInfo(state, nodeId).removal;
  return removal === "unknown" || removal === "available";
}

/** 一句话概括，给地图上的标记和悬浮提示用 */
export function describeShop(state, nodeId) {
  const info = shopInfo(state, nodeId);
  if (!info.visited) return "还没去过";
  if (!info.remaining.length) return "已经买空";
  const removal =
    info.removal === "available" ? " · 可消除导本" : info.removal === "gone" ? " · 消除导本已买" : "";
  return `还剩 ${info.remainingCount} 件 · 最便宜 ${info.cheapest} 币${info.discount ? " · 有打折" : ""}${removal}`;
}
