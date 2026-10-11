import assert from "node:assert/strict";
import {
  DEFAULT_SHOP_PRICE,
  SHOP_MAX_MULTIPLIER,
  buildPriceBook,
  describeShop,
  mayOfferRemoval,
  recordShopLineup,
  recordShopPurchase,
  referencePrice,
  shopInfo,
  shopMultiplier,
  shopNodeScores,
} from "./shared/shops.js";
import { findLowestScorePath, scoreExplorePath } from "./shared/path/exploreScore.js";
import { toRouteMap } from "./shared/path/weightedRoute.js";
import { quickTarget } from "./shared/path/quickTargets.js";

const book = (lineupId, statusId, rarity, price, stock = 1, name = "攻撃力UP(20%)") => ({
  lineup_id: lineupId,
  item_type: 4,
  status_id: statusId,
  name,
  rarity,
  price,
  stock_num: stock,
  can_purchase: stock > 0,
});
const removal = (lineupId, price, stock = 1) => ({
  lineup_id: lineupId,
  item_type: 6,
  item_name: "導本効果削除",
  price,
  stock_num: stock,
  can_purchase: stock > 0,
});

// —— 没有任何商店数据：用默认价 ——
assert.equal(referencePrice(null), DEFAULT_SHOP_PRICE);
assert.equal(shopInfo(null, 5).visited, false);
assert.equal(shopInfo(null, 5).removal, "unknown");
assert.equal(describeShop(null, 5), "还没去过");
assert.equal(shopMultiplier(null, 5, null), 1, "不知道有多少钱：和原来一样按 1 倍");
assert.equal(shopMultiplier(null, 5, 0), 0, "没钱：不值得去");
assert.equal(shopMultiplier(null, 5, DEFAULT_SHOP_PRICE), 1, "刚好买得起一件");
assert.equal(shopMultiplier(null, 5, DEFAULT_SHOP_PRICE * 2), 2);
assert.equal(shopMultiplier(null, 5, 999999), SHOP_MAX_MULTIPLIER, "钱再多也封顶");

// —— 进商店：记货架 ——
let state = null;
({ state } = recordShopLineup(state, {
  nodeId: 8,
  tabId: 1,
  response: {
    coin_amount: 420,
    item_list: [book(1, 1, 1, 200, 1), book(2, 72, 3, 600, 1, "与ダメージUP(50%)"), book(3, 32, 2, 300, 1, "必中(重複不可)")],
  },
  now: 10,
}));
({ state } = recordShopLineup(state, { nodeId: 8, tabId: 2, response: { item_list: [removal(9, 250)] }, now: 11 }));
assert.equal(state.coin, 420);
let info = shopInfo(state, 8);
assert.equal(info.visited, true);
assert.equal(info.items.length, 4, "两页货架合在一起");
assert.equal(info.remainingCount, 4);
assert.equal(info.cheapest, 200);
assert.equal(info.removal, "available");
assert.equal(info.discount, false);
assert.ok(info.items.find((item) => item.statusId === 32).nonStackable);
assert.equal(describeShop(state, 8), "还剩 4 件 · 最便宜 200 币 · 可消除导本");
assert.deepEqual(buildPriceBook(state), { "book:1": 200, "book:3": 600, "book:2": 300, "type:6": 250 });
assert.equal(referencePrice(state), 200, "看过一家之后，用本局见过的最低正常价估其他家");
assert.equal(shopMultiplier(state, 99, 400), 2, "没去过的商店按这个价估：400 币够买 2 件");
assert.equal(recordShopLineup(state, { nodeId: null, response: { item_list: [] } }).changed, false);
assert.equal(recordShopLineup(state, { nodeId: 8, response: {} }).changed, false);

// —— 买东西：扣库存 ——
({ state } = recordShopPurchase(state, { nodeId: 8, lineupId: "1" }));
info = shopInfo(state, 8);
assert.equal(info.remainingCount, 3);
assert.equal(info.cheapest, 250, "最便宜的那件买走了");
assert.equal(recordShopPurchase(state, { nodeId: 8, lineupId: 1 }).changed, false, "库存 0 的不能再扣");
assert.equal(recordShopPurchase(state, { nodeId: 8, lineupId: 777 }).changed, false);
({ state } = recordShopPurchase(state, { nodeId: 8, lineupId: 9 }));
assert.equal(shopInfo(state, 8).removal, "gone", "消除导本买过了");
assert.equal(mayOfferRemoval(state, 8), false);
assert.equal(mayOfferRemoval(state, 99), true, "没去过的商店还可能有");
// 当前位置没传对时，按 lineup_id 全局找
({ state } = recordShopPurchase(state, { nodeId: 12345, lineupId: 2 }));
assert.equal(shopInfo(state, 8).remainingCount, 1);

// —— 第二家：打折店（同类商品更便宜），而且不卖消除导本 ——
({ state } = recordShopLineup(state, {
  nodeId: 16,
  tabId: 1,
  response: { item_list: [book(21, 60, 2, 150, 1, "全種族(重複不可)"), book(22, 7, 1, 200, 2)] },
  now: 20,
}));
info = shopInfo(state, 16);
assert.equal(info.discount, true, "稀有导本正常 300、这里 150 → 打折");
assert.equal(info.removal, "none");
assert.equal(mayOfferRemoval(state, 16), false);
assert.equal(buildPriceBook(state)["book:2"], 300, "打折价不会拉低正常价");
assert.equal(describeShop(state, 16), "还剩 3 件 · 最便宜 150 币 · 有打折");
assert.equal(shopMultiplier(state, 16, 150), 1.5, "买得起 1 件 + 打折加成");
assert.equal(shopMultiplier(state, 16, 99999), SHOP_MAX_MULTIPLIER, "再便宜也封顶，不值得绕太远");
assert.equal(shopMultiplier(state, 8, 150), 0.5, "那家只剩 300 的：150 币只够一半");

// 买空的商店不值得去
({ state } = recordShopPurchase(state, { nodeId: 8, lineupId: 3 }));
assert.equal(shopInfo(state, 8).remaining.length, 0);
assert.equal(shopMultiplier(state, 8, 99999), 0);
assert.equal(describeShop(state, 8), "已经买空");

// —— 寻路里的效果 ——
/** 1 起点；2 空地 → 8 商店 A（去过，买空）；4 空地 → 5 商店 B（没去过）；6 一场普通战斗 */
const mapState = (coins) => ({
  current_node_id: 1,
  possession_arcarum3_dungeon_point: coins,
  node_list: [
    { node_id: 1, node_type: 0, position_x: 100, position_y: 100, adjacent_node_ids: [2, 4, 6] },
    { node_id: 6, node_type: 2, position_x: 0, position_y: 100, adjacent_node_ids: [1] },
    { node_id: 2, node_type: 0, position_x: 200, position_y: 100, adjacent_node_ids: [1, 8] },
    { node_id: 8, node_type: 8, position_x: 300, position_y: 100, adjacent_node_ids: [2] },
    { node_id: 4, node_type: 0, position_x: 100, position_y: 200, adjacent_node_ids: [1, 5] },
    { node_id: 5, node_type: 8, position_x: 100, position_y: 300, adjacent_node_ids: [4] },
  ],
});
const weights = { SHOP: -10, EMPTY: 10 };
{
  let scores = shopNodeScores(mapState(400), state, weights);
  assert.equal(scores.get(8), 10, "买空的商店按空地算");
  assert.equal(scores.get(5), -20, "没去过的：400 币 / 最低正常价 200 = 2 倍");
  assert.equal(scores.size, 2, "只给商店格算");

  scores = shopNodeScores(mapState(0), state, weights);
  assert.equal(scores.get(5), 10, "一分钱没有：商店按空地算");
  assert.equal(shopNodeScores(mapState(400), state, { SHOP: 5, EMPTY: 10 }).size, 0, "玩家把商店设成不鼓励时不去改");

  // 钱多（500 币 → 2.5 倍，−25）：穿过一格空地去商店（+10 −25 = −15）比旁边那场战斗（−10）更值
  const map = toRouteMap(mapState(500));
  const richScores = shopNodeScores(mapState(500), state, weights);
  assert.equal(richScores.get(5), -25);
  const rich = findLowestScorePath(map, 1, 4, { day: 1, nodeScores: richScores });
  assert.deepEqual(rich.path, [1, 4, 5]);
  assert.equal(rich.score, -15);
  assert.equal(scoreExplorePath(map, rich.path, { day: 1, nodeScores: richScores }).score, -15, "复评分口径一致");
  // 钱少（100 币只够半件，−5）：+10 −5 不如直接去打那场战斗
  const poor = findLowestScorePath(map, 1, 4, { day: 1, nodeScores: shopNodeScores(mapState(100), state, weights) });
  assert.deepEqual(poor.path, [1, 6], `钱不够时不该为商店绕路：${poor.path.join("→")}`);
  // 不传逐格分数：行为和原来完全一样（商店固定 −10，和战斗打平时取更短的）
  const plain = findLowestScorePath(map, 1, 4, { day: 1 });
  assert.deepEqual(plain.path, [1, 6]);
  assert.equal(scoreExplorePath(map, [1, 4, 5], { day: 1 }).score, 0, "原来的口径：空地 +10、商店 −10");
}

// —— 快捷目标「消除导本」 ——
{
  const context = { mayOfferRemoval: (nodeId) => mayOfferRemoval(state, nodeId) };
  assert.deepEqual(quickTarget(mapState(0), "removal", context), { nodeId: 5, hops: 2 }, "去过且买过的 8 号不算，去没去过的 5 号");
  assert.equal(quickTarget(mapState(0), "boss").nodeId, null, "其他快捷目标不受影响");
  // 5 号也去过、而且不卖消除导本
  const visited = recordShopLineup(state, { nodeId: 5, tabId: 1, response: { item_list: [book(31, 1, 1, 200)] } }).state;
  const none = quickTarget(mapState(0), "removal", { mayOfferRemoval: (nodeId) => mayOfferRemoval(visited, nodeId) });
  assert.equal(none.nodeId, null);
  assert.match(none.reason, /消除导本/);
  // 去过但还没买的也算
  const unbought = recordShopLineup(state, { nodeId: 5, tabId: 2, response: { item_list: [removal(41, 250)] } }).state;
  assert.equal(quickTarget(mapState(0), "removal", { mayOfferRemoval: (id) => mayOfferRemoval(unbought, id) }).nodeId, 5);
  // 没有商店记录（比如刚开局）：所有商店都还可能有
  assert.equal(quickTarget(mapState(0), "removal").nodeId, 5, "两家一样近时取节点号小的");
}

console.log("shop tests passed");
