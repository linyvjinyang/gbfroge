/**
 * 敌人归类：按遇到它的格子类型分成 小怪 / 强敌 / 超强敌 / 特殊怪 / 事件怪 / 君临者 / Boss。
 * 同一类里再按等级看，就能回答「这类敌人我一回合打死过多少级的、现在这只比它多多少血」。
 */

/** 显示顺序即难度顺序 */
export const ENEMY_CATEGORIES = [
  { nodeType: 2, key: "normal", name: "小怪" },
  { nodeType: 5, key: "event", name: "事件怪" },
  { nodeType: 3, key: "strong", name: "强敌" },
  { nodeType: 11, key: "terrifying", name: "超强敌" },
  { nodeType: 10, key: "special", name: "特殊怪" },
  { nodeType: 4, key: "ruler", name: "君临者" },
  { nodeType: 1, key: "boss", name: "Boss" },
];

const UNKNOWN = { nodeType: null, key: "unknown", name: "未归类" };

/** @returns {{ nodeType: number | null, key: string, name: string }} */
export function enemyCategory(nodeType) {
  if (nodeType == null || nodeType === "") return UNKNOWN;
  return ENEMY_CATEGORIES.find((category) => category.nodeType === Number(nodeType)) || UNKNOWN;
}

function levelNumber(lv) {
  const value = Number(lv);
  return Number.isFinite(value) ? value : -1;
}

/**
 * 拿当前敌人去比「本局一回合打死过的同类敌人」。
 *
 * @param {object} battle 战斗状态（record.oneTurnByType 是本局各类里一回合打死过的最大血量那只）
 * @param {{ lv?: string, hpMax?: number }} boss
 * @returns {{
 *   category: string, lv: string,
 *   reference: { lv: string, hpMax: number, name: string, sameCategory: boolean, category: string } | null,
 *   ratio: number | null,
 * }}
 *   reference：优先同类；同类还没有一回合打死过时，用其他类里血量最大的那只
 *   ratio：当前敌人血量 / 参照敌人血量
 */
export function compareWithOneTurnKills(battle, boss) {
  const category = enemyCategory(battle?.nodeType);
  const result = { category: category.name, lv: String(boss?.lv ?? ""), reference: null, ratio: null };
  if (!battle?.isArcarum3) return result;

  const byType = battle.record?.oneTurnByType || {};
  const own = byType[category.key];
  let reference = own ? { ...own, sameCategory: true, category: category.name } : null;
  if (!reference) {
    for (const [key, entry] of Object.entries(byType)) {
      if (!entry?.hpMax || (reference && entry.hpMax <= reference.hpMax)) continue;
      const name = ENEMY_CATEGORIES.find((item) => item.key === key)?.name || UNKNOWN.name;
      reference = { ...entry, sameCategory: false, category: name };
    }
  }
  if (!reference?.hpMax) return result;

  const hpMax = Number(boss?.hpMax) || 0;
  return { ...result, reference, ratio: hpMax ? hpMax / reference.hpMax : null };
}

/**
 * 敌人记录按类别分组，组内按等级从低到高（同级按血量）。
 * @param {object[]} entries listEnemies() 的结果
 * @returns {{ key: string, name: string, enemies: object[] }[]}
 */
export function groupEnemiesByCategory(entries) {
  const groups = new Map();
  for (const entry of entries || []) {
    const category = enemyCategory(entry.nodeType);
    if (!groups.has(category.key)) groups.set(category.key, { key: category.key, name: category.name, enemies: [] });
    groups.get(category.key).enemies.push(entry);
  }
  const order = [...ENEMY_CATEGORIES.map((category) => category.key), UNKNOWN.key];
  return [...groups.values()]
    .sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key))
    .map((group) => ({
      ...group,
      enemies: group.enemies.sort(
        (a, b) => levelNumber(a.lv) - levelNumber(b.lv) || (a.hpMax || 0) - (b.hpMax || 0),
      ),
    }));
}
