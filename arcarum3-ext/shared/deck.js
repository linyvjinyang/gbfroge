/**
 * 盘子（编成）：每次读到游戏的编成响应就整体刷新。
 * 肉鸽内返回的就是封印生效后的数值，所以不做额外换算，直接展示。
 * 字段路径参考 Tarou 的 handleDeckJson（deck.pc.weapons[1..13] 等）。
 */

export const DECK_STATE_VERSION = 2;
export const WEAPON_SLOTS = 13;

const IMG_BASE = "https://prd-game-a-granbluefantasy.akamaized.net/assets/img/sp";
/** 在响应里找 deck 时最多下钻的层数 */
const DECK_SEARCH_DEPTH = 3;

export function createDeckState() {
  return { version: DECK_STATE_VERSION, deck: null, capturedAt: null, source: "" };
}

function toNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function text(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function weaponRecord(slot, weapon) {
  if (!weapon?.master?.id) return null;
  const skills = [];
  for (const key of ["skill1", "skill2", "skill3"]) {
    const skill = weapon[key];
    if (!skill || typeof skill !== "object") continue;
    skills.push({
      name: text(skill.name),
      description: text(skill.description),
      image: text(skill.image),
    });
  }
  return {
    slot,
    masterId: text(weapon.master.id),
    name: text(weapon.master.name),
    attribute: toNumber(weapon.master.attribute),
    seriesId: toNumber(weapon.master.series_id),
    imageId: text(weapon.param?.image_id) || text(weapon.master.id),
    level: toNumber(weapon.param?.level),
    skills,
  };
}

function summonRecord(slot, summon, isMain) {
  if (!summon?.master?.id) return null;
  return {
    slot,
    isMain,
    masterId: text(summon.master.id),
    name: text(summon.master.name),
    attribute: toNumber(summon.master.attribute),
    imageId: text(summon.param?.image_id) || text(summon.master.id),
    level: toNumber(summon.param?.level),
  };
}

function damageInfo(pc) {
  const after = pc?.after_damage_info;
  const info = after && Object.keys(after).length ? after : pc?.damage_info;
  if (!info || typeof info !== "object") return null;
  const enhance = info.weapon_skill_enhance_param || {};
  return {
    normalDamage: toNumber(info.assumed_normal_damage),
    advantageDamage: toNumber(info.assumed_advantage_damage),
    hp: toNumber(info.hp),
    effects: (Array.isArray(info.effect_value_info) ? info.effect_value_info : []).map((effect) => ({
      icon: text(effect?.icon_img),
      value: text(effect?.value),
      isMax: Boolean(effect?.is_max),
    })),
    enhance: {
      normal: toNumber(enhance.weapon_skill_enhance),
      magna: toNumber(enhance.weapon_skill_enhance_magna),
      ex: toNumber(enhance.weapon_skill_enhance_evil),
    },
  };
}

function hasWeapons(value) {
  const weapons = value?.pc?.weapons;
  return Boolean(weapons && typeof weapons === "object");
}

/** 肉鸽的编成接口路径未必与普通编成一致，所以按结构找：带 pc.weapons 的对象就是 deck */
function findDeck(value, depth = 0) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (hasWeapons(value)) return value;
  if (depth >= DECK_SEARCH_DEPTH) return null;
  for (const key of ["deck", "data", "option", "party"]) {
    const found = findDeck(value[key], depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * @param {any} payload 编成响应
 * @returns {object | null} 没有武器栏时返回 null
 */
export function extractDeck(payload) {
  const deck = findDeck(payload);
  if (!deck) return null;
  const pc = deck.pc;

  const weapons = [];
  for (let slot = 1; slot <= WEAPON_SLOTS; slot++) {
    weapons.push(weaponRecord(slot, pc.weapons[slot]));
  }
  if (!weapons.some(Boolean)) return null;

  const summons = [];
  for (let slot = 1; slot <= 5; slot++) {
    const record = summonRecord(slot, pc.summons?.[slot], slot === 1);
    if (record) summons.push(record);
  }
  for (let slot = 1; slot <= 2; slot++) {
    const record = summonRecord(5 + slot, pc.sub_summons?.[slot], false);
    if (record) summons.push(record);
  }

  const characters = [];
  for (let slot = 1; slot <= 8; slot++) {
    const npc = deck.npc?.[slot];
    if (!npc?.master?.id) continue;
    characters.push({
      slot,
      masterId: text(npc.master.id),
      name: text(npc.master.name),
      attribute: toNumber(npc.master.attribute),
      imageId: text(npc.param?.image_id_3),
    });
  }

  return {
    priority: text(deck.priority),
    name: text(deck.name),
    weapons,
    summons,
    characters,
    damageInfo: damageInfo(pc),
  };
}

function sourceForUrl(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return String(url || "");
  }
}

/**
 * 最新一次读到的盘子直接覆盖旧的。
 * @returns {{ state: object, changed: boolean }}
 */
export function captureDeck(previous, payload, options = {}) {
  const deck = extractDeck(payload);
  if (!deck) return { state: previous || createDeckState(), changed: false };
  return {
    state: {
      version: DECK_STATE_VERSION,
      deck,
      capturedAt: options.now ?? Date.now(),
      source: sourceForUrl(options.url),
    },
    changed: true,
  };
}

export function summarizeDeck(state) {
  const weapons = (state?.deck?.weapons || []).filter(Boolean);
  return { total: weapons.length, summons: state?.deck?.summons?.length || 0 };
}

/** @param {'m' | 'ls'} [size] 主手用竖图 ls，其余用横图 m */
export function weaponImageUrl(weapon, size = "m") {
  return weapon?.imageId ? `${IMG_BASE}/assets/weapon/${size}/${weapon.imageId}.jpg` : "";
}

export function summonImageUrl(summon) {
  return summon?.imageId ? `${IMG_BASE}/assets/summon/m/${summon.imageId}.jpg` : "";
}

/** 效果量一览的标签图（图上自带效果名） */
export function effectLabelUrl(effect) {
  return effect?.icon ? `${IMG_BASE}/ui/icon/weapon_skill_label/${effect.icon}` : "";
}
