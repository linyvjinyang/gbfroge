/**
 * 导本效果 → 伤害相关倍率。
 *
 * 只收录数值写死、无触发条件的词条；按「同词条多份加算、同类词条加算」汇总。
 * 这是沿用本体规则的假设（上限提升在本体确为加算），导本本身尚无公开实测。
 */

/**
 * @typedef {object} EffectMods
 * @property {number} atk          攻击力UP
 * @property {number} elementAtk   自属性攻击UP
 * @property {number} enhance      自属性加护强化（方阵/神石/属性）
 * @property {number} capAll       伤害上限UP（通用）
 * @property {number} capSkill     技能伤害上限UP
 * @property {number} capSpecial   奥义伤害上限UP
 * @property {number} capChain     连锁伤害上限UP
 * @property {number} capSpecialHard 奥义伤害特殊上限UP
 * @property {number} skillDamage  技能伤害UP
 * @property {number} specialDamage 奥义伤害UP
 * @property {number} chainDamage  连锁伤害UP
 * @property {number} ampAll       与ダメージUP（全部）
 * @property {number} ampAttack    通常攻击与ダメージUP
 * @property {number} ampSkill     技能与ダメージUP
 * @property {number} ampSpecial   奥义与ダメージUP
 * @property {number} ampChain     连锁与ダメージUP
 */

/** @returns {EffectMods} */
export function emptyEffectMods() {
  return {
    atk: 0,
    elementAtk: 0,
    enhance: 0,
    capAll: 0,
    capSkill: 0,
    capSpecial: 0,
    capChain: 0,
    capSpecialHard: 0,
    skillDamage: 0,
    specialDamage: 0,
    chainDamage: 0,
    ampAll: 0,
    ampAttack: 0,
    ampSkill: 0,
    ampSpecial: 0,
    ampChain: 0,
  };
}

/** 无条件词条：status_id → 每份的倍率 */
export const GUIDEBOOK_FIXED_EFFECTS = {
  1: { atk: 0.2 },
  3: { skillDamage: 0.2, capSkill: 0.1 },
  4: { specialDamage: 0.2, capSpecial: 0.1 },
  5: { chainDamage: 0.5, capChain: 0.3 },
  6: { capSpecialHard: 0.1 },
  7: { capAll: 0.1 },
  8: { elementAtk: 0.2 },
  20: { ampAttack: 0.3 },
  21: { ampSkill: 0.3 },
  22: { ampSpecial: 0.3 },
  23: { ampChain: 1 },
  24: { enhance: 0.6 },
  // 攻击可能落空，但数值本身无条件
  62: { atk: 1, capAll: 0.5 },
  72: { ampAll: 0.5 },
  76: { capSpecialHard: 1 },
  79: { enhance: 1.8 },
};

/** 成长型词条：当前值写在词条文本里，如「与ダメージUP(81%/最大100%)」 */
export const GUIDEBOOK_PROGRESS_EFFECTS = {
  85: "ampAll",
  86: "ampAll",
  96: "ampAll",
};

/** 有触发条件、暂不计入的伤害类词条（只用于提示） */
export const GUIDEBOOK_CONDITIONAL_IDS = new Set([
  34, 38, 47, 49, 54, 63, 64, 65, 90, 98, 99, 100, 126,
]);

/** 从词条文本读「当前值%/最大」里的当前值 */
export function readProgressPercent(text) {
  const match = String(text || "").match(/(\d+(?:\.\d+)?)\s*[%％]\s*[\/／]\s*最[大多]/);
  return match ? Number(match[1]) / 100 : null;
}

/**
 * @param {Record<string, { statusId?: number, num?: number }>} inventory 当前持有
 * @param {Record<string, { rawName?: string, text?: Record<string, string> }>} [catalogue]
 *   用来读成长型词条的当前值
 * @returns {{ mods: EffectMods, counted: number[], conditional: number[], unknownProgress: number[] }}
 */
export function aggregateGuidebookEffects(inventory, catalogue = {}) {
  const mods = emptyEffectMods();
  const counted = [];
  const conditional = [];
  const unknownProgress = [];

  for (const [key, held] of Object.entries(inventory || {})) {
    const statusId = Number(held?.statusId ?? key);
    const num = Math.max(0, Number(held?.num) || 0);
    if (!Number.isFinite(statusId) || num <= 0) continue;

    const fixed = GUIDEBOOK_FIXED_EFFECTS[statusId];
    if (fixed) {
      for (const [field, value] of Object.entries(fixed)) mods[field] += value * num;
      counted.push(statusId);
      continue;
    }

    const progressField = GUIDEBOOK_PROGRESS_EFFECTS[statusId];
    if (progressField) {
      const entry = catalogue[String(statusId)];
      const current = readProgressPercent(entry?.rawName ?? entry?.text?.ja);
      if (current == null) {
        unknownProgress.push(statusId);
      } else {
        mods[progressField] += current;
        counted.push(statusId);
      }
      continue;
    }

    if (GUIDEBOOK_CONDITIONAL_IDS.has(statusId)) conditional.push(statusId);
  }

  return { mods, counted, conditional, unknownProgress };
}
