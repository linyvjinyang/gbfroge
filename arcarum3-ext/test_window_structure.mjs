import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [sidepanelHtml, sidepanelScript, mapHtml, mapScript, guidebookScript, mapCss] =
  await Promise.all([
    readFile(new URL("./sidepanel/index.html", import.meta.url), "utf8"),
    readFile(new URL("./sidepanel/sidepanel.js", import.meta.url), "utf8"),
    readFile(new URL("./map/map.html", import.meta.url), "utf8"),
    readFile(new URL("./map/map.js", import.meta.url), "utf8"),
    readFile(new URL("./map/guidebookView.js", import.meta.url), "utf8"),
    readFile(new URL("./map/map.css", import.meta.url), "utf8"),
  ]);

function assertUniqueIds(html, label) {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, `${label} 的 HTML id 必须唯一`);
  return ids;
}

function assertReferencedIdsExist(htmlIds, scripts) {
  const referencedIds = scripts.flatMap((script) =>
    [...script.matchAll(/\$\("([^"]+)"\)/g)].map((match) => match[1]),
  );
  for (const id of new Set(referencedIds)) {
    assert.ok(htmlIds.includes(id), `脚本引用了不存在的 #${id}`);
  }
}

const sidepanelIds = assertUniqueIds(sidepanelHtml, "侧边栏");
assertReferencedIdsExist(sidepanelIds, [sidepanelScript]);
assert.doesNotMatch(sidepanelHtml, /page-guidebooks|guidebook-list|data-page=/);
assert.doesNotMatch(sidepanelScript, /guidebook|GET_GUIDEBOOKS/i);
assert.match(sidepanelHtml, /id="btn-open"/);

const mapIds = assertUniqueIds(mapHtml, "地图窗口");
const buildScript = await readFile(new URL("./map/buildView.js", import.meta.url), "utf8");
assertReferencedIdsExist(mapIds, [mapScript, guidebookScript, buildScript]);
assert.equal((mapHtml.match(/data-window-view=/g) || []).length, 3, "地图 / 导本·盘子 / 设置");
assert.match(mapHtml, /id="settings-view"[\s\S]*id="show-legend"/, "显示选项收进设置页");
assert.doesNotMatch(mapHtml, /id="show-legend"[^>]*checked/, "图例默认隐藏");
assert.match(mapHtml, /id="auto-fit"[^>]*checked/, "自适应窗口默认开启");
assert.match(mapHtml, /id="auto-researcher"[^>]*checked/, "默认优先寻路到研究者");
assert.match(mapHtml, /id="explore-down"[^>]*checked[\s\S]*id="explore-up"[^>]*checked/, "先向下、之后向上靠中间，两段默认都开");
assert.match(mapHtml, /id="guidebook-view"[\s\S]*id="build-grid"/, "盘子与导本在同一页");
assert.match(mapHtml, /id="map-column"[\s\S]*id="btn-explore-gen"[\s\S]*id="quick-targets"[\s\S]*id="btn-center"[\s\S]*<aside id="panel">/, "寻路按钮和定位自己放在地图上");
assert.equal((mapHtml.match(/data-book-view=/g) || []).length, 2);
assert.equal((mapHtml.match(/class="rarity-filter"/g) || []).length, 4);
assert.match(mapHtml, /id="guidebook-view"/);
assert.match(mapHtml, /class="guidebook-layout"/);
assert.match(mapHtml, /id="guidebook-live-panel"/);
assert.match(mapHtml, /id="book-live-summary"/);
assert.match(mapHtml, /id="book-live-description"/);
assert.match(mapHtml, /id="book-live-captured"/);
assert.match(mapHtml, /id="btn-clear-book-selection"/);
assert.match(mapHtml, /id="guidebook-live-empty"/);
assert.match(mapHtml, /id="guidebook-live-list"/);
assert.match(mapHtml, /id="book-live-notes"/);
assert.match(mapHtml, /id="book-live-notes-text"/);
assert.match(mapHtml, /id="guidebook-catalogue-panel"/);
assert.match(mapHtml, /id="guidebook-list"/);
assert.match(mapHtml, /id="book-search"/);
assert.match(mapHtml, /id="btn-export-books"/);
assert.ok(
  mapHtml.indexOf('id="btn-explore-gen"') <
    mapHtml.indexOf('class="explore-score-settings"'),
  "生成路径按钮应位于评分设置上方",
);
assert.match(mapScript, /createGuidebookView/);
assert.match(mapHtml, /id="map-column"[\s\S]*id="node-tip"[\s\S]*id="detail"[\s\S]*<aside id="panel">/, "节点详情浮在地图上");
assert.doesNotMatch(mapHtml, /detail-fold/, "右栏不再有节点详情面板");
assert.match(mapCss, /\.node-tip\s*\{[^}]*pointer-events:\s*none/s, "悬浮提示不能挡住鼠标");
const columnHtml = (name) => {
  const start = mapHtml.indexOf(`data-col="${name}"`);
  assert.ok(start > 0, `右栏要有 ${name} 列`);
  const next = mapHtml.indexOf('<section class="panel-col"', start);
  return mapHtml.slice(start, next > 0 ? next : mapHtml.indexOf("</aside>"));
};
assert.ok(
  mapHtml.indexOf('data-col="battle"') < mapHtml.indexOf('data-col="guide"'),
  "战斗列在左，导本列在右",
);
assert.match(
  columnHtml("battle"),
  /panel-col-toggle[\s\S]*id="omen-alert"[\s\S]*id="damage-enemies"[\s\S]*id="boss-notes"[\s\S]*id="boss-guide"[\s\S]*id="party-hp"[\s\S]*id="party-status"[\s\S]*id="damage-table"/,
  "战斗列：预兆 → 敌人（血量、状态、机制）→ 队伍 → 伤害",
);
assert.match(mapCss, /\.enemy-row\.is-tier-green \.enemy-bar-fill/, "血条颜色表示难度档位");
assert.match(mapCss, /\.enemy-row\.is-tier-yellow \.enemy-bar-fill/);
assert.match(mapCss, /\.enemy-row\.is-tier-red \.enemy-bar-fill/);
assert.match(buildScript, /\["前排", rows\.front\], \["后排", rows\.back\]/, "队伍分前排、后排两行，前排在上");
assert.match(buildScript, /if \(backRow\) backRow\.append\(attackInfo\);/, "按攻击后的 hit 数放在后排右边");
assert.match(buildScript, /formatCompact\(info\.special\), formatNumber\(info\.special\)/, "hit 统计用万 / 亿显示，完整数值放悬浮提示");
assert.match(buildScript, /function numberEl\(/);
assert.match(mapScript, /setInterval\(resync, RESYNC_INTERVAL_MS\)/, "除了推送，每 10 秒兜底同步一次");
assert.match(mapScript, /const RESYNC_INTERVAL_MS = 10_000;/);
assert.doesNotMatch(mapHtml, /reread-on-start/, "没有主动补读的开关：插件只听不发");
assert.match(mapHtml, /id="btn-export-captures"/, "设置页可以导出排查用的抓包记录");
assert.match(mapScript, /chrome\.storage\.session\.get\(CAPTURE_LOG_STORAGE_KEY\)/, "抓包记录只从内存里读");
assert.doesNotMatch(mapScript, /fetch\(["'`]https?:\/\/game\.granbluefantasy/, "兜底同步只读本地存储，不向游戏发请求");
assert.match(mapCss, /\.party-row\.is-back\s*\{[^}]*grid-template-columns:\s*auto auto minmax\(0, 1fr\)/s);
assert.match(mapCss, /\.party-row-tiles\s*\{[^}]*repeat\(4,/s, "一行放得下 4 人，前排不换行");
assert.match(
  columnHtml("guide"),
  /panel-col-toggle[\s\S]*id="damage-mods"[\s\S]*id="quickref-cursed"[\s\S]*id="quickref-tiles"[\s\S]*id="quickref-gold"/,
  "导本列：导本累计 → debuff → 不可重复 → 金导本",
);
assert.match(
  mapHtml,
  /data-fold="guide-total"[\s\S]*id="damage-mods"[\s\S]*id="quickref-cursed"[\s\S]*<\/details>[\s\S]*data-fold="quickref-tiles"/,
  "debuff 导本在「导本累计」面板里、加成合计的下面",
);
assert.doesNotMatch(columnHtml("battle"), /id="damage-mods"|quickref-/, "导本相关内容都在导本列");
assert.match(mapCss, /\.panel-col\.is-collapsed\s*\{[^}]*width:\s*38px/s, "列可以收成竖条");
assert.match(mapCss, /\.panel-col\.is-collapsed \.panel-col-title\s*\{[^}]*writing-mode:\s*vertical-rl/s);
assert.match(mapScript, /initPanelColumns\(\);/);
assert.match(
  mapHtml,
  /id="omen-alert"[\s\S]*id="omen-alert-omens"[\s\S]*id="omen-alert-list"[\s\S]*id="omen-alert-statuses"[\s\S]*id="omen-alert-status"/,
  "预兆与特殊状态各占一段，可以同时显示",
);
assert.match(buildScript, /is-double/, "两者同时出现时要有专门的提示样式");
const panelHtml = mapHtml.slice(mapHtml.indexOf('<aside id="panel">'), mapHtml.indexOf("</aside>"));
for (const fold of ["party-status", "battle", "guide-total", "quickref-tiles", "quickref-gold"]) {
  assert.match(panelHtml, new RegExp(`<details[^>]*data-fold="${fold}"`), `${fold} 可以折叠`);
}
assert.doesNotMatch(panelHtml, /btn-quickref-restore/, "恢复已剔除的入口不在主页面");
assert.doesNotMatch(panelHtml, /id="route-hint"|id="route-stats"|id="omen-log"/, "路线详情和预兆记录不在主页面");
assert.match(
  mapHtml,
  /id="settings-view"[\s\S]*id="route-hint"[\s\S]*id="explore-stats"[\s\S]*id="omen-log"/,
  "路线详情和预兆记录在设置页",
);
assert.match(mapScript, /MutationObserver/, "路线提示要同步到主页面底部的状态栏");
assert.match(
  mapHtml,
  /class="map-zoom-controls"[\s\S]*id="btn-view-full"[\s\S]*id="btn-view-near"/,
  "右下角是 全图 / 附近 切换",
);
assert.doesNotMatch(mapHtml, /id="btn-fit"|id="btn-zoom-in"|id="btn-zoom-out"/, "旧的适应 / 加减按钮已移除");
assert.match(mapScript, /function applyViewMode\(\)/);
assert.match(mapScript, /nodeScores: shopNodeScores\(state, shopState, exploreWeights\)/, "扫路时商店按币数和库存加权");
assert.match(mapScript, /mayOfferRemoval: \(nodeId\) => mayOfferRemoval\(shopState, nodeId\)/, "消除导本快捷目标要看商店记录");
assert.match(mapHtml, /id="settings-view"[\s\S]*id="enemy-log-table"[\s\S]*id="enemy-log-rows"/, "敌人记录表在设置页");
assert.match(mapCss, /\.enemy-badge\.is-one-turn\s*\{/, "一回合击杀过的敌人有专门的绿色标记");
assert.match(mapHtml, /id="settings-view"[\s\S]*id="btn-quickref-restore"/, "恢复已剔除的入口在设置页");
// 主页面不出现接口字段名这类开发说明
assert.doesNotMatch(panelHtml, /total_turn|stock_num|shop_index|content\/index|node_type/);
assert.match(mapScript, /view\.tips = \[\]/, "悬浮提示不带开发用的 tips");
assert.match(mapScript, /const id = dragging \? null : hoverId;/, "详情提示只跟随悬停");
assert.doesNotMatch(mapScript, /hoverId \?\? selectedId/, "选中节点不能让提示一直挂着");
assert.match(guidebookScript, /CLEAR_GUIDEBOOK_SELECTION/);
assert.match(guidebookScript, /activeIncident/);
assert.match(guidebookScript, /activeShop/);
assert.match(guidebookScript, /event-choice-item/);
assert.match(guidebookScript, /shop-item/);
assert.match(guidebookScript, /incidentEntry\?\.notes\?\.\["zh-CN"\]/);
assert.match(mapCss, /\[hidden\]\s*\{\s*display:\s*none\s*!important;/);
assert.doesNotMatch(guidebookScript, /toISOString\(\)\.slice\(0,\s*10\)/);
assert.match(
  guidebookScript,
  /toISOString\(\)\.replace\(\/\[:\.\]\/g,\s*"-"\)/,
);
assert.match(
  mapCss,
  /grid-template-columns:\s*minmax\(0,\s*40fr\)\s+minmax\(0,\s*60fr\)/,
  "导本页应始终使用 40 / 60 分栏",
);
assert.match(
  mapCss,
  /\.guidebook-column\s*\{[^}]*overflow-y:\s*auto/s,
  "左右导本列应独立纵向滚动",
);

console.log("window structure: all assertions passed");
