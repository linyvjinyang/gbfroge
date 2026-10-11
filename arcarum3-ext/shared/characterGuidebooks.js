/**
 * 角色专属导本：不靠 status_id，靠文字格式识别。
 *
 * 游戏里它们的写法是统一的：
 *   バトル開始時に〈角色〉が「〈牌名〉の正位置」を発動/…　◆〈角色〉がバトルメンバーにいる時のみ発動(重複不可)
 * 所以新角色的导本即使还不知道编号，也能认出是谁的、用牌名当缩写。
 */

const CHARACTER_PATTERN = /バトル開始時に(.+?)が「(.+?)の正位置」を発動/;

/** 牌名（日文 → 中文），用作方块缩写 */
const ARCANA_NAMES = {
  愚者: "愚者",
  魔術師: "魔术师",
  女教皇: "女祭司",
  女帝: "女帝",
  皇帝: "皇帝",
  法王: "教皇",
  教皇: "教皇",
  恋人: "恋人",
  戦車: "战车",
  力: "力量",
  隠者: "隐者",
  運命の輪: "命运之轮",
};

const CHARACTER_NAMES = {
  "マリア・テレサ": "玛丽亚·特蕾莎",
  カイム: "凯姆",
  ニーア: "妮娅",
  エスタリオラ: "艾斯塔里奥拉",
  フラウ: "弗劳",
  ロベリア: "洛贝利亚",
  ガイゼンボーガ: "盖森博格",
  ハーゼリーラ: "哈泽莉拉",
  アラナン: "阿拉南",
  カッツェリーラ: "卡泽莉拉",
};

/**
 * 整句翻译：只收逐字核对过原文的条目。
 * 没列到的角色导本仍然能识别和缩写，只是显示日文原文。
 */
const TEXT_TRANSLATIONS = [
  {
    // 原文（玩家截图）：バトル開始時にニーアが「恋人の正位置」を発動/永久ノ誓イが使用可能になる/
    // 攻撃開始時にニーアと主人公がバトルメンバーにいる時、2人に再攻撃効果　◆ニーアがバトルメンバーにいる時のみ発動(重複不可)
    test: /ニーアが「恋人の正位置」を発動/,
    zh: "战斗开始时，妮娅发动「恋人的正位」/永久之誓变为可使用/攻击开始时，若妮娅与主角都位于前排，赋予两人再攻击效果；仅当妮娅位于前排时发动(不可重复)",
  },
];

/**
 * @returns {{ character: string, characterZh: string, arcana: string, short: string } | null}
 *   short：方块上的缩写（牌名）
 */
export function parseCharacterGuidebook(text) {
  const match = String(text || "").match(CHARACTER_PATTERN);
  if (!match) return null;
  const character = match[1].trim();
  const arcana = match[2].trim();
  return {
    character,
    characterZh: CHARACTER_NAMES[character] || character,
    arcana,
    short: ARCANA_NAMES[arcana] || arcana,
  };
}

/** 有整句翻译时返回中文，否则返回空串 */
export function translateCharacterGuidebook(text) {
  const value = String(text || "");
  return TEXT_TRANSLATIONS.find((rule) => rule.test.test(value))?.zh || "";
}
