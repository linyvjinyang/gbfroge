/**
 * 导本速查：不可重复导本（方块、缩写、有就亮）、金（独有）导本、当前持有的 debuff 导本。
 * 玩家觉得没用的条目可以剔除（存一份隐藏名单），之后不再列出。
 */

import { parseCharacterGuidebook, translateCharacterGuidebook } from "./characterGuidebooks.js";

export const RARITY_UNIQUE = 3;
export const RARITY_CURSED = 99;
/** icon_category 4：诅咒类（含「先减后增」那几条稀有度不是 99 的） */
export const ICON_CATEGORY_CURSED = 4;

/** 不可重复导本的方块缩写；没列到的取显示名的前几个字 */
export const QUICKREF_SHORT_NAMES = {
  31: "弱点攻击",
  32: "必中",
  39: "开场反击",
  41: "开场刻印",
  42: "不死身",
  43: "奥义再发",
  44: "消去防御",
  46: "技能刷新",
  47: "间隔与伤",
  54: "3格增伤",
  59: "全得意",
  60: "全种族",
  66: "稀有率UP",
  75: "奥义减CD",
  77: "奥义槽200",
  80: "有利转换",
  81: "再使用",
  83: "召唤CD1",
  84: "终极新星",
  92: "hit减CD",
  93: "百倍追击",
  96: "复活增伤",
  97: "HP1护盾",
  101: "创世神",
  102: "土风开场",
  103: "敌人弱化",
  105: "开场无敌",
  108: "女帝",
  110: "愚者",
};
const SHORT_NAME_FALLBACK_LENGTH = 5;

const NON_STACKABLE = /重複不可|不可重复|不可重複|can't be stacked/i;
const NON_STACKABLE_SUFFIX = /\s*[（(]\s*(?:重複不可|不可重复|不可重複|can't be stacked)\s*[）)]/gi;

function texts(entry) {
  return [
    entry?.text?.["zh-CN"],
    entry?.text?.ja,
    entry?.text?.en,
    entry?.rawName,
  ].filter((value) => typeof value === "string" && value);
}

export function isNonStackable(entry) {
  return texts(entry).some((value) => NON_STACKABLE.test(value));
}

export function isCursed(entry) {
  return (
    Number(entry?.rarity) === RARITY_CURSED ||
    Number(entry?.iconCategory) === ICON_CATEGORY_CURSED
  );
}

/** 日文原文（用来按文字格式识别角色专属导本） */
function sourceText(entry) {
  return entry?.text?.ja || entry?.rawName || "";
}

/**
 * 显示名：优先中文；没有中文时，角色专属导本用按原文核对过的翻译，再不行才显示原文。
 * 去掉游戏文本的 @@ 标记和「(不可重复)」后缀（用标签单独表示）。
 */
export function quickRefName(entry) {
  const name =
    entry?.text?.["zh-CN"] ||
    translateCharacterGuidebook(sourceText(entry)) ||
    texts(entry)[0] ||
    `导本 #${entry?.statusId ?? "?"}`;
  return name.replace(/@@/g, "").replace(NON_STACKABLE_SUFFIX, "").trim();
}

/**
 * 方块缩写：人工起的优先；角色专属导本用牌名（不需要知道编号）；都没有就取名称前几个字。
 * @param {string} [source] 日文原文
 */
export function quickRefShortName(statusId, name, source = "") {
  return (
    QUICKREF_SHORT_NAMES[Number(statusId)] ||
    parseCharacterGuidebook(source)?.short ||
    [...String(name)].slice(0, SHORT_NAME_FALLBACK_LENGTH).join("")
  );
}

/**
 * @param {{ catalogue?: Record<string, any>, inventory?: Record<string, { num?: number }> } | null} state
 * @param {Iterable<number>} [hiddenIds] 玩家剔除的 status_id
 * @returns {{ cursed: QuickRefItem[], tiles: QuickRefItem[], gold: QuickRefItem[], hiddenCount: number }}
 *   tiles：全部不可重复导本（金的也在内），按编号固定排序，位置不随持有变化；
 *   gold：全部金导本，已持有的排前面。
 * @typedef {{ statusId: number, name: string, short: string, num: number,
 *             rarity: number | null, nonStackable: boolean }} QuickRefItem
 */
export function buildQuickRef(state, hiddenIds = []) {
  const hidden = new Set([...hiddenIds].map(Number));
  const inventory = state?.inventory || {};
  const cursed = [];
  const tiles = [];
  const gold = [];
  let hiddenCount = 0;

  for (const [key, entry] of Object.entries(state?.catalogue || {})) {
    const statusId = Number(entry?.statusId ?? key);
    if (!Number.isFinite(statusId)) continue;
    const num = Math.max(0, Number(inventory[String(statusId)]?.num) || 0);
    const name = quickRefName(entry);
    const item = {
      statusId,
      name,
      short: quickRefShortName(statusId, name, sourceText(entry)),
      num,
      rarity: entry?.rarity ?? null,
      nonStackable: isNonStackable(entry),
    };

    if (isCursed(entry)) {
      // debuff 只在持有时提示，而且不允许剔除：它是警告，不是参考资料
      if (num > 0) cursed.push(item);
      continue;
    }
    const isGold = Number(entry?.rarity) === RARITY_UNIQUE;
    if (!isGold && !item.nonStackable) continue;
    if (hidden.has(statusId)) {
      hiddenCount += 1;
      continue;
    }
    if (item.nonStackable) tiles.push(item);
    if (isGold) gold.push(item);
  }

  const byId = (a, b) => a.statusId - b.statusId;
  return {
    cursed: cursed.sort(byId),
    // 方块位置固定，方便凭位置记忆；金的排在稀有后面
    tiles: tiles.sort((a, b) => (a.rarity ?? 0) - (b.rarity ?? 0) || byId(a, b)),
    gold: gold.sort((a, b) => Number(b.num > 0) - Number(a.num > 0) || byId(a, b)),
    hiddenCount,
  };
}

/** 隐藏名单的增删，返回去重排序后的新数组 */
export function hideQuickRefItem(hiddenIds, statusId) {
  const id = Number(statusId);
  if (!Number.isFinite(id)) return [...hiddenIds];
  return [...new Set([...hiddenIds, id].map(Number))].sort((a, b) => a - b);
}
