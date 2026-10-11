/**
 * Boss 机制：
 *  1. 机制速查（整理自 gbf.wiki「Evoking Solomonis / Allotropic Microcosm」的 Bosses 一节）
 *  2. 从战斗数据里读出 Boss 身上的「规则类」状态文字（如「味方が奥義を発動しなかったターン終了時…」）
 *  3. 最终 Boss 的 3 种「命运」出现时给出解除条件
 *
 * 速查按 Boss 的英文名匹配；状态识别按状态说明文字里的关键词匹配。
 * 日文原文没有逐条核对过，所以识别不到时仍会把原文原样列出来。
 */

/** 状态说明至少这么长才当作「规则类」状态（短的多是普通增益，如「攻撃UP」） */
const RULE_TEXT_MIN_LENGTH = 14;

/**
 * @typedef {{ name: string, cancel: string, note?: string }} OmenGuide
 * @typedef {{ id: string, match: RegExp, title: string, passive: string[], omens: OmenGuide[],
 *             destinies?: { title: string, effect: string, remove: string }[], extra?: string[] }} BossGuide
 */

/** @type {BossGuide[]} */
export const BOSS_GUIDES = [
  {
    id: "banes-gate",
    match: /bane'?s gate/i,
    title: "Bane's Gate（第二天 Boss）",
    passive: [
      "回合结束时，我方这一回合没打出 2 次三连击：Boss 的层数 +1，并削减我方全体奥义槽 200%。",
      "每层：Boss 攻防 +40%（最高 200%）；我方每回合结束失去 2% HP（最高 10%）。",
    ],
    omens: [
      { name: "Overflowing Impurity（75% / 25%）", cancel: "使用 5 次技能" },
      { name: "Wind of Calamity（50%）", cancel: "命中 40 次" },
    ],
  },
  {
    id: "infernobringer",
    match: /infernobringer/i,
    title: "Infernobringer（第二天 Boss）",
    passive: [
      "回合结束时，我方这一回合没人放奥义：Boss 的愤炎层数 +1，并使我方全体技能伤害降低。",
      "每层：Boss 攻防 +40%（最高 200%）、三连率上升；我方每回合结束失去 2% HP（最高 10%）。",
    ],
    omens: [
      { name: "Myriad Disasters（75% / 50% / 25%）", cancel: "打出 3 次单发 300 万以上的命中" },
      { name: "Incineration Triad", cancel: "造成 3000 万伤害" },
      { name: "Roaring Damnation", cancel: "使用 3 次伤害技能" },
    ],
  },
  {
    id: "beast-of-anathema",
    match: /beast of anathema/i,
    title: "Beast of Anathema（第二天 Boss）",
    passive: [
      "我方一回合内用满 4 个技能：Boss 的层数 +1，并给我方全体附加弱体（Heavy）。",
      "每层：Boss 攻防 +40%（最高 200%）、追加伤害上升；我方每回合结束失去 2% HP（最高 10%）。",
    ],
    omens: [
      { name: "Ruin Dragon's Bite", cancel: "付与弱体 10 次" },
      { name: "Ruin Dragon's Thrust", cancel: "技能命中 20 次" },
      { name: "Ruin Dragon's Roar（50%）", cancel: "打出 5 次单发 200 万以上的命中" },
    ],
  },
  {
    id: "raskeid-hewle",
    match: /raskeid|hewle/i,
    title: "Raskeid & Hewle（最终 Boss）",
    passive: [
      "开场：全体 4 万无属性伤害。",
      "预兆（60% / 20% 触发）的解除条件由「命运齿轮」等级决定，开场随机，每次解除预兆或回合结束时无人攻击就 +1（4 级后回到 1 级）。",
      "同时 Holloxion +1（最高 5）：攻防与三连率上升，普攻后附加弱体，弱体无视抗性且无法消除。",
    ],
    omens: [
      { name: "命运齿轮：猛击", cancel: "打出 8 次单发 1000 万以上的命中" },
      { name: "命运齿轮：策略", cancel: "使用 8 次技能" },
      { name: "命运齿轮：连打", cancel: "命中 200 次" },
      { name: "命运齿轮：弱化", cancel: "付与弱体 20 次" },
    ],
    destinies: [
      {
        title: "毁灭命运",
        effect: "回合结束时造成我方最大 HP 50% 的无属性伤害",
        remove: "攻击 5 次",
      },
      {
        // 游戏内原文：ターン終了時、この効果を消費して味方全体のアビリティの使用間隔を3ターン延長する状態
        // (消去不可/1ターンに強化効果を無効化する効果を3回与えると解除)
        title: "衰弱命运",
        effect: "回合结束时我方全体技能使用间隔延长 3 回合",
        remove: "1 回合内使用 3 次消除强化效果（驱散）",
      },
      {
        title: "回归命运",
        effect: "回合结束时 Boss 回复 10% HP",
        remove: "造成 300 万无属性伤害（白字）",
      },
    ],
    extra: ["三种「命运」在回合结束时有概率出现（Holloxion 越高越容易），下一个回合结束时生效，要在生效前解除。"],
  },
];

/** 用说明文字里的关键词认出最终 Boss 的三种命运；顺序即优先级 */
const DESTINY_PATTERNS = [
  {
    index: 2,
    test: /(無属性|plain).{0,24}(3,?000,?000|300万)|(3,?000,?000|300万).{0,24}(無属性|plain)/i,
  },
  {
    index: 1,
    test: /(強化効果.{0,12}(無効|消去|解除).{0,16}3回|ディスペル.{0,12}3回|buff-?removing.{0,24}3)/i,
  },
  {
    index: 0,
    test: /(攻撃行動.{0,8}5回|5回.{0,6}攻撃|attack(s)? 5 times)/i,
  },
];

/** 说明里写了解除方式的状态：就算认不出是哪一种，也值得提醒 */
const REMOVABLE = /解除|removed? (by|when|upon)|to remove/i;

function cleanText(value) {
  return String(value ?? "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** @returns {BossGuide | null} */
export function findBossGuide(boss) {
  const names = [boss?.nameEn, boss?.name].filter(Boolean).join(" | ");
  if (!names) return null;
  return BOSS_GUIDES.find((guide) => guide.match.test(names)) || null;
}

/**
 * 从一组状态里挑出规则类状态。
 * @param {any[]} conditions
 * @param {BossGuide | null} guide 当前战斗里认出的 Boss（用来给「命运」起中文名）
 * @param {{ alertsOnly?: boolean }} [options] alertsOnly：只要需要提示的（用于我方身上的状态）
 */
function collectNotes(conditions, guide, options = {}) {
  const notes = [];
  for (const condition of conditions || []) {
    const text = cleanText(condition.detail);
    if (!text) continue;

    const destiny = guide?.destinies
      ? DESTINY_PATTERNS.find((pattern) => pattern.test.test(text))
      : null;
    const removable = REMOVABLE.test(text);
    const alert = Boolean(destiny) || removable;
    // 不需要提示的普通状态：只收 Boss 身上的长段增益说明（我们打上去的弱体不算）
    if (!alert && (options.alertsOnly || condition.isDebuff || [...text].length < RULE_TEXT_MIN_LENGTH)) {
      continue;
    }

    const info = destiny ? guide.destinies[destiny.index] : null;
    notes.push({
      key: `status|${text}`,
      text,
      alert,
      title: info ? info.title : "",
      hint: info ? `${info.effect}。解除：${info.remove}` : "",
    });
  }
  return notes;
}

function dedupe(notes) {
  const seen = new Set();
  return notes.filter((note) => !seen.has(note.key) && seen.add(note.key));
}

/**
 * 某个敌人身上的规则类状态。
 * @returns {{ key: string, text: string, alert: boolean, title: string, hint: string }[]}
 *   alert：需要特别提示（最终 Boss 的命运，或说明里带解除方式的状态）
 *   title / hint：认出来时给出的中文名称与解除条件
 */
export function bossStatusNotes(boss) {
  return dedupe(collectNotes(boss?.conditions, findBossGuide(boss)));
}

/**
 * 整场战斗里要显示的规则类状态：存活敌人身上的全部，
 * 加上我方身上带解除方式的（有的机制是挂在我方身上的）。
 */
export function battleStatusNotes(battle) {
  const bosses = (battle?.bosses || []).filter((boss) => boss.alive !== false);
  const guide = bosses.map(findBossGuide).find(Boolean) || null;
  return dedupe([
    ...bosses.flatMap((boss) => collectNotes(boss.conditions, findBossGuide(boss) || guide)),
    ...(battle?.players || []).flatMap((player) =>
      collectNotes(player.conditions, guide, { alertsOnly: true })),
  ]);
}

/** 写入预兆记录用的条目（与预兆同一种结构，kind 区分） */
export function statusLogEntries(battle) {
  return battleStatusNotes(battle).map((note) => ({
    kind: "status",
    name: note.title,
    conditions: [note.text],
    key: note.key,
    fields: [],
  }));
}
