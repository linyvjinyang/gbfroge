/**
 * 队伍血量：地图上用 party_status，战斗中用战斗状态里的我方数据，取较新的一份。
 * party_status 的字段参考 Tarou（party[].hp / max_hp / attribute / image_id）。
 */

const ASSET_BASE = "https://prd-game-a-granbluefantasy.akamaized.net/assets/img/sp/assets";
/** 前排人数 */
const FRONT_ROW_SIZE = 4;

function toNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * @param {any} response party_status 的响应（{ party: [...] } 或数组本体）
 * @returns {{ members: { imageId: string, hp: number, hpMax: number, attribute: number | null }[], updatedAt: number } | null}
 */
export function extractPartyStatus(response, now = Date.now()) {
  const list = Array.isArray(response) ? response : response?.party;
  if (!Array.isArray(list) || !list.length) return null;
  const members = list
    .filter((member) => member && typeof member === "object")
    .map((member) => ({
      imageId: member.image_id == null ? "" : String(member.image_id),
      hp: Math.max(0, toNumber(member.hp) ?? 0),
      hpMax: Math.max(0, toNumber(member.max_hp) ?? 0),
      attribute: toNumber(member.attribute),
    }));
  return members.length ? { members, updatedAt: now } : null;
}

/**
 * 移动、事件、选项的响应里带的队伍血量（action_scenario_list[].after_party_status）。
 * 一次响应可能有好几步，取最后一步的。
 */
export function extractScenarioParty(response, now = Date.now()) {
  const list =
    response?.action_scenario_list ??
    response?.actionScenarioList ??
    response?.data?.action_scenario_list ??
    response?.data?.actionScenarioList;
  if (!Array.isArray(list)) return null;
  for (let index = list.length - 1; index >= 0; index--) {
    const party = extractPartyStatus(list[index]?.after_party_status, now);
    if (party) return party;
  }
  return null;
}

/**
 * 界面用的统一队伍列表。
 * 战斗状态比地图状态新时用战斗里的血量；头像优先用对应来源自己的，
 * 两边人数一致时互相补名字 / 头像。
 *
 * @returns {{ source: 'battle' | 'map' | null,
 *   members: { name: string, hp: number, hpMax: number, alive: boolean, front: boolean,
 *              imageUrl: string, conditions: any[] }[] }}
 *   front：是否在前排。有 formation（前排站位 → 角色序号）时按它，否则取前 4 人。
 *   slot：前排里的站位顺序（后排为 null），界面按它从左到右排。
 */
export function mergePartyView(party, battle) {
  const mapMembers = party?.members || [];
  const players = battle?.players || [];
  const battleNewer = players.length > 0 && (battle.updatedAt || 0) >= (party?.updatedAt || 0);
  const sameSize = mapMembers.length === players.length;

  if (battleNewer) {
    const formation = Array.isArray(battle.formation) ? battle.formation.map(Number) : null;
    const slotOf = (index) => {
      if (!formation) return index < FRONT_ROW_SIZE ? index : null;
      const slot = formation.indexOf(index);
      return slot >= 0 ? slot : null;
    };
    return {
      source: "battle",
      members: players.map((player, index) => ({
        front: slotOf(index) != null,
        slot: slotOf(index),
        name: player.name || "",
        hp: player.hp,
        hpMax: player.hpMax,
        alive: player.alive !== false && player.hp > 0,
        imageUrl: player.imageId
          ? `${ASSET_BASE}/${player.isNpc ? "npc" : "leader"}/s/${player.imageId}.jpg`
          : sameSize
            ? mapImageUrl(mapMembers[index], index)
            : "",
        conditions: player.conditions || [],
      })),
    };
  }
  if (mapMembers.length) {
    return {
      source: "map",
      members: mapMembers.map((member, index) => ({
        front: index < FRONT_ROW_SIZE,
        slot: index < FRONT_ROW_SIZE ? index : null,
        name: sameSize ? players[index].name || "" : "",
        hp: member.hp,
        hpMax: member.hpMax,
        alive: member.hp > 0,
        imageUrl: mapImageUrl(member, index),
        // 状态只在战斗里有意义，地图上不带
        conditions: [],
      })),
    };
  }
  return { source: null, members: [] };
}

function mapImageUrl(member, index) {
  if (!member?.imageId) return "";
  return `${ASSET_BASE}/${index === 0 ? "leader" : "npc"}/raid_normal/${member.imageId}.jpg`;
}

/**
 * 拆成前排 / 后排两行。前排按站位顺序；后排保持队伍顺序。
 * @param {ReturnType<typeof mergePartyView>["members"]} members
 */
export function splitPartyRows(members) {
  const tagged = (members || []).map((member, index) => ({ ...member, index }));
  return {
    front: tagged.filter((member) => member.front).sort((a, b) => a.slot - b.slot),
    back: tagged.filter((member) => !member.front),
  };
}
