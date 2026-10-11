/**
 * 战斗状态：敌人血量、敌我状态、最近一次行动的实测伤害。
 * 字段路径参考 Tarou 的 useBattleLog（start.json / *_result.json 的 scenario）。
 */

import { enemyCategory } from "./enemyCategory.js";
import { extractOmens } from "./omens.js";

export const BATTLE_STATE_VERSION = 2;


const STATUS_ICON_BASE =
  "https://prd-game-a-granbluefantasy.akamaized.net/assets/img/sp/ui/icon/status/x64";

const RESULT_KINDS = [
  [/normal_attack_result\.json/i, "attack"],
  [/ability_result\.json/i, "ability"],
  [/group_gauge_action_result\.json/i, "ability"],
  [/summon_result\.json/i, "summon"],
  [/fatal_chain_result\.json/i, "chain"],
  [/temporary_item_result\.json/i, "item"],
  [/user_recovery\.json/i, "item"],
];

export const ACTION_LABEL = {
  start: "开场",
  attack: "攻击",
  ability: "技能",
  summon: "召唤",
  chain: "FC",
  item: "道具",
};

/** @returns {'start' | 'attack' | 'ability' | 'summon' | 'chain' | 'item' | null} */
export function battleKindForUrl(url) {
  const value = String(url || "");
  if (!/\/rest\/(?:raid|multiraid)\//i.test(value)) return null;
  if (/\/start\.json/i.test(value)) return "start";
  for (const [pattern, kind] of RESULT_KINDS) {
    if (pattern.test(value)) return kind;
  }
  return null;
}

function toNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nameOf(value) {
  if (typeof value === "string") return value;
  return value?.ja || value?.en || "";
}

function conditionList(condition) {
  const seen = new Set();
  const out = [];
  for (const [list, isDebuff] of [[condition?.buff, false], [condition?.debuff, true]]) {
    for (const item of Array.isArray(list) ? list : []) {
      const status = item?.status == null ? "" : String(item.status);
      if (!status || seen.has(status)) continue;
      seen.add(status);
      out.push({
        status,
        detail: typeof item.detail === "string" ? item.detail : "",
        remain: toNumber(item.remain),
        isDebuff,
      });
    }
  }
  return out;
}

function emptyTally() {
  return { hits: 0, total: 0, max: 0 };
}

function addHit(tally, rawValue) {
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value <= 0) return;
  tally.hits += 1;
  tally.total += value;
  if (value > tally.max) tally.max = value;
}

/** scenario 里的 damage 既可能是数组也可能是以序号为键的对象 */
function eachGroup(value) {
  if (Array.isArray(value)) return value;
  return value && typeof value === "object" ? Object.values(value) : [];
}

/**
 * 统计一次行动里打在敌人身上的伤害。
 * 通常攻击 / 奥义 / 其他（技能、追击类 damage、召唤）分开计。
 */
export function tallyScenarioDamage(scenario) {
  const attack = emptyTally();
  const special = emptyTally();
  const other = emptyTally();

  for (const action of Array.isArray(scenario) ? scenario : []) {
    const cmd = action?.cmd;
    if (cmd === "attack" && action.from === "player") {
      for (const group of eachGroup(action.damage)) {
        for (const hit of eachGroup(group)) addHit(attack, hit?.value);
      }
    } else if (cmd === "special" || cmd === "special_npc") {
      for (const item of eachGroup(action.list)) {
        for (const hit of eachGroup(item?.damage)) addHit(special, hit?.value);
      }
    } else if (cmd === "damage" && action.to === "boss") {
      for (const hit of eachGroup(action.list)) addHit(other, hit?.value);
    } else if (cmd === "loop_damage" && action.to === "boss") {
      for (const group of eachGroup(action.list)) {
        for (const hit of eachGroup(group)) addHit(other, hit?.value);
      }
    } else if (cmd === "summon") {
      for (const item of eachGroup(action.list)) {
        for (const hit of eachGroup(item?.damage)) addHit(other, hit?.value);
      }
    }
  }

  return { attack, special, other, total: attack.total + special.total + other.total };
}

/**
 * 按一次攻击后的命中统计，口径照 Tarou 的 handleNormalAttackJson：
 *  - hit：打在敌人身上的伤害次数（通常攻击、奥义、技能 / 追加伤害都算）
 *  - chain：这一回合放了几个奥义
 *  - special / ability：奥义伤害、技能与追加伤害
 *  - total：以上合计
 * 只统计到敌方行动之前，敌人回合里的反击之类不算进来。
 *
 * @returns {{ hit: number, chain: number, attack: number, special: number, ability: number, total: number }}
 */
export function tallyAttackInfo(scenario) {
  const info = { hit: 0, chain: 0, attack: 0, special: 0, ability: 0, total: 0 };
  const add = (field, rawValue) => {
    const value = Number(rawValue);
    if (!Number.isFinite(value) || value <= 0) return false;
    info[field] += value;
    info.total += value;
    return true;
  };

  for (const action of Array.isArray(scenario) ? scenario : []) {
    const cmd = action?.cmd;
    if (cmd === "turn" && action.mode === "boss") break;

    if (cmd === "attack" && action.from === "player") {
      for (const group of eachGroup(action.damage)) {
        for (const hit of eachGroup(group)) {
          if (add("attack", hit?.value)) info.hit += 1;
        }
      }
    } else if ((cmd === "special" || cmd === "special_npc") && action.list) {
      info.chain += 1;
      let entries = 0;
      for (const item of eachGroup(action.list)) {
        for (const hit of eachGroup(item?.damage)) {
          if (add("special", hit?.value)) entries += 1;
        }
      }
      // 奥义的命中数以游戏给的 total（画面上跳出的数字个数）为准；没有就按伤害条目数
      const shown = Array.isArray(action.total)
        ? action.total.filter((item) => String(item?.split?.[0] ?? "") !== "0").length
        : null;
      info.hit += shown ?? entries;
    } else if (cmd === "damage" && action.to === "boss") {
      for (const hit of eachGroup(action.list)) {
        if (add("ability", hit?.value)) info.hit += 1;
      }
    } else if (cmd === "loop_damage" && action.to === "boss") {
      for (const group of eachGroup(action.list)) {
        for (const hit of eachGroup(group)) {
          if (add("ability", hit?.value)) info.hit += 1;
        }
      }
    }
  }
  return info;
}

/**
 * 游戏里敌人的名字自带等级前缀（如「Lv250 ラスケィド＆ヒューレ」）：
 * 拆成名字和等级，避免显示成两遍等级，也让记录按「名字 + 等级」归类。
 */
export function splitEnemyName(rawName, rawLevel) {
  const text = String(rawName ?? "").trim();
  const match = text.match(/^Lv\.?\s*(\d+)\s+(.+)$/i);
  const level = rawLevel == null || rawLevel === "" ? "" : String(rawLevel);
  return match
    ? { name: match[2].trim(), lv: level || match[1] }
    : { name: text, lv: level };
}

function bossRecord(param, pos) {
  const hp = toNumber(param?.hp) ?? 0;
  const named = splitEnemyName(nameOf(param?.name) || nameOf(param?.monster), param?.Lv);
  const namedEn = splitEnemyName(typeof param?.name === "object" ? param.name?.en : "", param?.Lv);
  return {
    pos,
    name: named.name,
    nameEn: namedEn.name,
    lv: named.lv,
    attr: toNumber(param?.attr),
    hp,
    hpMax: toNumber(param?.hpmax) ?? 0,
    alive: hp > 0,
    conditions: conditionList(param?.condition),
  };
}

function playerRecord(param, pos) {
  const pid = String(param?.pid ?? "").split("_")[0];
  return {
    pos,
    name: nameOf(param?.name),
    // 头像：主角用 leader 目录，其余角色用 npc 目录
    imageId: pid ? `${pid}_01` : "",
    isNpc: String(param?.cjs ?? "").startsWith("npc"),
    attr: toNumber(param?.attr),
    hp: toNumber(param?.hp) ?? 0,
    hpMax: toNumber(param?.hpmax) ?? 0,
    alive: Boolean(Number(param?.alive)),
    conditions: conditionList(param?.condition),
  };
}

const EMPTY_BEST = { attack: 0, special: 0, other: 0 };
/**
 * attackTurn：攻击回合最高伤害
 * oneTurnHp：本局一回合打死过的敌人里最大的血量
 * oneTurnByType：按类别（小怪 / 强敌 / …）各记一只——本局一回合打死过的、血量最大的那只
 */
const EMPTY_RECORD = { attackTurn: 0, at: null, oneTurnHp: 0, oneTurnByType: {} };

/** 黄色的上限：血量在「本局一回合打死过的最大血量」的这么多倍以内 */
export const TIER_YELLOW_RATIO = 3;

function mergeBest(previous, tally) {
  return {
    attack: Math.max(previous?.attack || 0, tally.attack.max),
    special: Math.max(previous?.special || 0, tally.special.max),
    other: Math.max(previous?.other || 0, tally.other.max),
  };
}

/** 这场战斗的攻击回合是否计入本局记录：肉鸽里的任何战斗都算（事件敌人、强敌、Boss 也在内） */
export function isRecordedBattle(battle) {
  return Boolean(battle?.isArcarum3);
}

/**
 * 本局记录（开新一局清零）：
 *  - attackTurn：按下攻击后这一次行动打出的全部伤害的最高值
 *  - oneTurnHp：第 1 回合内就打死的敌人里，最大的那个血量。
 *    局外加成和难度会让同名敌人的血量变化，所以不认名字，只按血量倍率来比。
 *
 * @param {object} battle 行动前的战斗状态
 * @param {{ bosses: any[] }} after 行动后的敌人
 */
function mergeRecord(previous, tally, kind, battle, after, now) {
  const record = { ...EMPTY_RECORD, ...previous, oneTurnByType: { ...previous?.oneTurnByType } };
  if (!isRecordedBattle(battle)) return record;
  if (kind === "attack" && tally.total > record.attackTurn) {
    record.attackTurn = tally.total;
    record.at = now;
  }
  if (Number(battle.turn) === 1) {
    for (const boss of after.bosses || []) {
      const was = (battle.bosses || []).find((item) => item.pos === boss.pos);
      if (!was?.alive || boss.alive) continue;
      if (boss.hpMax > record.oneTurnHp) record.oneTurnHp = boss.hpMax;
      const key = enemyCategory(battle.nodeType).key;
      if (boss.hpMax > (record.oneTurnByType[key]?.hpMax || 0)) {
        record.oneTurnByType[key] = { lv: String(was.lv ?? ""), hpMax: boss.hpMax, name: was.name || "" };
      }
    }
  }
  return record;
}

/**
 * 敌人的难度档位，用血条颜色表示。只看血量倍率，不认名字。
 *  - green：血量不超过本局一回合打死过的最大血量
 *  - yellow：在它的 3 倍以内
 *  - red：超过 3 倍，差距很大
 *  - unknown：本局还没有一回合打死过任何敌人，没法比
 *
 * @returns {{ tier: 'green' | 'yellow' | 'red' | 'unknown', ratio: number | null, reference: number }}
 */
export function enemyTier(battle, boss) {
  const reference = battle?.isArcarum3 ? battle?.record?.oneTurnHp || 0 : 0;
  const hpMax = Number(boss?.hpMax) || 0;
  if (!reference || !hpMax) return { tier: "unknown", ratio: null, reference };
  const ratio = hpMax / reference;
  const tier = ratio <= 1 ? "green" : ratio <= TIER_YELLOW_RATIO ? "yellow" : "red";
  return { tier, ratio, reference };
}

/**
 * 开场时的前排站位（站位 → 角色序号）。
 * 响应里直接带 formation 就用它；否则从 ability 里取（每个前排角色一项，pos 是角色序号）。
 * 中途重新进入战斗时，倒下的角色已经不在前排，所以不能简单认为前 4 人就是前排。
 */
function startFormation(response) {
  const direct = response?.formation ?? response?.status?.formation;
  const source = Array.isArray(direct)
    ? direct
    : Object.values(response?.ability || {}).map((item) => item?.pos);
  const formation = source.map(toNumber).filter((value) => value != null);
  return formation.length ? formation : null;
}

/** 伤害条目里的 pos 是前排站位；有 formation 时换算成角色序号 */
function playerIndex(pos, formation) {
  const slot = toNumber(pos);
  if (slot == null) return null;
  const mapped = Array.isArray(formation) ? toNumber(formation[slot]) : null;
  return mapped ?? slot;
}

/** 打在我方身上的条目若带剩余血量（hp），就用它更新 */
function applyPlayerHp(players, entry, formation) {
  const hp = toNumber(entry?.hp);
  const index = playerIndex(entry?.pos, formation);
  if (hp == null || index == null || !players[index]) return;
  players[index].hp = Math.max(0, hp);
  players[index].alive = hp > 0;
}

function applyScenario(state, scenario, formation = state.formation) {
  const bosses = state.bosses.map((boss) => ({ ...boss }));
  const players = state.players.map((player) => ({ ...player }));

  for (const action of Array.isArray(scenario) ? scenario : []) {
    const pos = toNumber(action?.pos);
    if (action?.cmd === "boss_gauge" && pos != null && bosses[pos]) {
      const hp = toNumber(action.hp);
      if (hp != null) {
        bosses[pos].hp = hp;
        bosses[pos].alive = hp > 0;
      }
      const hpMax = toNumber(action.hpmax);
      if (hpMax) bosses[pos].hpMax = hpMax;
      if (action.name) {
        const named = splitEnemyName(nameOf(action.name), bosses[pos].lv);
        if (named.name) bosses[pos].name = named.name;
        if (typeof action.name === "object" && action.name.en) {
          bosses[pos].nameEn = splitEnemyName(action.name.en, bosses[pos].lv).name;
        }
      }
    } else if (action?.cmd === "die" && action.to === "boss" && pos != null && bosses[pos]) {
      bosses[pos].hp = 0;
      bosses[pos].alive = false;
    } else if (action?.cmd === "condition" && pos != null) {
      if (action.to === "boss" && bosses[pos]) {
        bosses[pos].conditions = conditionList(action.condition);
      } else if (action.to === "player" && players[pos]) {
        players[pos].conditions = conditionList(action.condition);
      }
    } else if (action?.cmd === "attack" && action.from === "boss") {
      for (const group of eachGroup(action.damage)) {
        for (const hit of eachGroup(group)) applyPlayerHp(players, hit, formation);
      }
    } else if (
      (action?.cmd === "damage" || action?.cmd === "heal" || action?.cmd === "loop_damage") &&
      action.to === "player"
    ) {
      for (const item of eachGroup(action.list)) {
        if (Array.isArray(item)) item.forEach((hit) => applyPlayerHp(players, hit, formation));
        else applyPlayerHp(players, item, formation);
      }
    }
  }

  return { bosses, players };
}

/**
 * @param {object | null} previous
 * @param {any} response
 * @param {{ url?: string, now?: number, nodeType?: number | null }} [options]
 * @returns {{ state: object | null, changed: boolean }}
 */
export function updateBattleState(previous, response, options = {}) {
  const kind = battleKindForUrl(options.url);
  const now = options.now ?? Date.now();
  if (!kind || !response || typeof response !== "object") {
    return { state: previous || null, changed: false };
  }

  if (kind === "start") {
    const bossParams = response.boss?.param;
    if (!Array.isArray(bossParams) || !bossParams.length) {
      return { state: previous || null, changed: false };
    }
    const raidId = response.raid_id == null ? "" : String(response.raid_id);
    const sameRaid = previous && previous.raidId === raidId;
    let state = {
      version: BATTLE_STATE_VERSION,
      raidId,
      questId: response.quest_id == null ? "" : String(response.quest_id),
      isArcarum3: Boolean(response.is_arcarum3),
      // 进入战斗时所在格子的类型（由后台从地图状态带入），用于显示和敌人记录
      nodeType: sameRaid && options.nodeType == null ? previous.nodeType ?? null : options.nodeType ?? null,
      turn: toNumber(response.turn) ?? 1,
      // 当前生效的预兆（特动解除条件）；newOmenKeys 由后台对照预兆记录后填入
      omens: extractOmens(response),
      newOmenKeys: sameRaid ? previous.newOmenKeys || [] : [],
      bosses: bossParams.map(bossRecord),
      players: (Array.isArray(response.player?.param) ? response.player.param : []).map(playerRecord),
      formation: startFormation(response),
      // 刷新页面会重新收到同一场战斗的 start，保留已有的实测记录
      lastAction: sameRaid ? previous.lastAction : null,
      lastAttack: sameRaid ? previous.lastAttack ?? null : null,
      best: sameRaid
        ? {
            attack: previous.best?.attack || 0,
            special: previous.best?.special || 0,
            other: previous.best?.other || 0,
          }
        : { ...EMPTY_BEST },
      // 本局记录跨战斗保留，用来在新战斗一开始就估算能否击杀
      record: {
        attackTurn: previous?.record?.attackTurn || 0,
        at: previous?.record?.at ?? null,
        oneTurnHp: previous?.record?.oneTurnHp || 0,
        oneTurnByType: { ...previous?.record?.oneTurnByType },
      },
      startedAt: sameRaid ? previous.startedAt : now,
      updatedAt: now,
    };
    if (Array.isArray(response.scenario) && response.scenario.length) {
      const tally = tallyScenarioDamage(response.scenario);
      state = { ...state, ...applyScenario(state, response.scenario) };
      if (tally.total > 0) {
        state.lastAction = { kind: "start", at: now, turn: state.turn, ...tally };
        state.best = mergeBest(state.best, tally);
      }
    }
    return { state, changed: true };
  }

  if (!previous || !Array.isArray(response.scenario)) {
    return { state: previous || null, changed: false };
  }

  const tally = tallyScenarioDamage(response.scenario);
  const formation = Array.isArray(response.status?.formation)
    ? response.status.formation.map(Number)
    : previous.formation || null;
  const state = {
    ...previous,
    ...applyScenario(previous, response.scenario, previous.formation || null),
    formation,
    turn: toNumber(response.status?.turn) ?? previous.turn,
    // 响应带 status 时以它为准（没有预兆就是空）；不带 status 的响应保持原样
    omens: response.status ? extractOmens(response) : previous.omens || [],
    updatedAt: now,
  };
  if (tally.total > 0) {
    state.lastAction = { kind, at: now, turn: previous.turn, ...tally };
    state.best = mergeBest(previous.best, tally);
  }
  // 按了攻击：记下这一下的 hit 数和各类伤害
  if (kind === "attack") {
    state.lastAttack = { ...tallyAttackInfo(response.scenario), turn: previous.turn, at: now };
  }
  // 击杀可能来自没有伤害数字的行动（比如只带 die 事件），所以每次都更新记录
  state.record = mergeRecord(previous.record, tally, kind, previous, state, now);
  return { state, changed: true };
}

/** 清零本局的攻击回合记录（开新一局或手动清零） */
export function resetBattleRecord(previous) {
  if (!previous) return { state: null, changed: false };
  return {
    state: { ...previous, record: { ...EMPTY_RECORD, oneTurnByType: {} } },
    changed: Boolean(previous.record?.attackTurn || previous.record?.oneTurnHp),
  };
}

/**
 * 拿本局攻击回合记录去比每个敌人当前的血量：一回合能打掉多少、能不能打死。
 * 只在战斗的第 1 回合给预测——预测的目的是判断「能不能一回合解决」，
 * 过了第 1 回合这场已经不是一回合战斗，再估血量和伤害没有意义。
 *
 * @returns {{
 *   active: boolean,
 *   reference: number,
 *   enemies: { pos: number, name: string, hp: number, hpMax: number,
 *              damage: number, hpAfter: number, kill: boolean, turns: number | null }[],
 *   totalHp: number,
 *   totalTurns: number | null,
 * }}
 *   active：是否还在给预测（第 1 回合、且有记录可比）
 *   damage：这一回合能从该敌人身上打掉的血量（不超过它的剩余血量）
 */
export function predictKill(battle) {
  const firstTurn = (Number(battle?.turn) || 1) <= 1;
  const record = battle?.isArcarum3 ? battle?.record?.attackTurn || 0 : 0;
  const reference = firstTurn ? record : 0;
  const alive = (battle?.bosses || []).filter((boss) => boss.alive && boss.hp > 0);
  const turnsFor = (hp) => (reference > 0 ? Math.ceil(hp / reference) : null);
  const totalHp = alive.reduce((sum, boss) => sum + boss.hp, 0);
  return {
    active: reference > 0,
    reference,
    enemies: alive.map((boss) => {
      const damage = Math.min(reference, boss.hp);
      return {
        pos: boss.pos,
        name: boss.name,
        hp: boss.hp,
        hpMax: boss.hpMax,
        damage,
        hpAfter: boss.hp - damage,
        kill: reference > 0 && reference >= boss.hp,
        turns: turnsFor(boss.hp),
      };
    }),
    totalHp,
    totalTurns: alive.length ? turnsFor(totalHp) : null,
  };
}

export function statusIconUrl(status) {
  return status ? `${STATUS_ICON_BASE}/status_${status}.png` : "";
}
