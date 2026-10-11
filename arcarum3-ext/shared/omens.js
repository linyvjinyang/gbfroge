/**
 * 预兆（特动的解除条件）：读取战斗响应里的 special_skill_indicate，
 * 按敌人累积成一本「预兆记录」，并标出当前正在生效的那一条。
 *
 * 游戏只给了解除条件的文字（interrupt_display_text），没有「隐藏特动」之类的标记，
 * 所以这里不判断哪条是隐藏的：每个敌人见过的条件都记下来，第一次出现的标成「新」。
 */

export const OMEN_LOG_VERSION = 1;
/** 特别提示的格子类型：Boss(1) 与君临者(4) */
export const OMEN_ALERT_NODE_TYPES = new Set([1, 4]);

const NAME_FIELDS = ["special_skill_name", "skill_name", "name", "title", "comment"];

export function createOmenLog() {
  return { version: OMEN_LOG_VERSION, bosses: {}, updatedAt: null };
}

function cleanText(value) {
  return String(value ?? "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function nameOf(value) {
  if (typeof value === "string") return cleanText(value);
  return cleanText(value?.ja || value?.en || "");
}

/**
 * 当前生效的预兆。开场响应里可能在顶层，也可能在 status 下。
 * @returns {{ name: string, conditions: string[], key: string, fields: string[] }[]}
 */
export function extractOmens(response) {
  const list = response?.status?.special_skill_indicate ?? response?.special_skill_indicate;
  if (!Array.isArray(list)) return [];
  const omens = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const conditions = (Array.isArray(item.interrupt_display_text) ? item.interrupt_display_text : [])
      .map(cleanText)
      .filter(Boolean);
    let name = "";
    for (const field of NAME_FIELDS) {
      name = nameOf(item[field]);
      if (name) break;
    }
    if (!conditions.length && !name) continue;
    omens.push({
      name,
      conditions,
      key: `${name}|${conditions.join("|")}`,
      // 留下字段名，方便以后对照真实响应补充解析
      fields: Object.keys(item).sort(),
    });
  }
  return omens;
}

/**
 * 把这次看到的预兆并入记录。
 * @param {object | null} previous
 * @param {{ bossName: string, nodeType?: number | null, day?: number | null,
 *           omens: ReturnType<typeof extractOmens>, now?: number }} seen
 * @returns {{ log: object, changed: boolean, newKeys: string[] }}
 */
export function recordOmens(previous, seen) {
  const log = previous?.version === OMEN_LOG_VERSION ? previous : createOmenLog();
  const bossName = cleanText(seen?.bossName);
  const omens = seen?.omens || [];
  if (!bossName || !omens.length) return { log, changed: false, newKeys: [] };

  const now = seen.now ?? Date.now();
  const boss = log.bosses[bossName] || { name: bossName, nodeType: null, day: null, omens: {} };
  const nextOmens = { ...boss.omens };
  const newKeys = [];
  let changed = false;

  for (const omen of omens) {
    const known = nextOmens[omen.key];
    if (!known) {
      newKeys.push(omen.key);
      changed = true;
      nextOmens[omen.key] = {
        // omen：预兆的解除条件；status：Boss 身上的规则类状态
        kind: omen.kind || "omen",
        name: omen.name,
        conditions: omen.conditions,
        fields: omen.fields,
        firstSeenAt: now,
        lastSeenAt: now,
      };
    } else if (known.lastSeenAt !== now) {
      nextOmens[omen.key] = { ...known, lastSeenAt: now };
    }
  }

  const nodeType = seen.nodeType ?? boss.nodeType ?? null;
  const day = seen.day ?? boss.day ?? null;
  if (nodeType !== boss.nodeType || day !== boss.day) changed = true;
  if (!changed) return { log, changed: false, newKeys };

  return {
    log: {
      version: OMEN_LOG_VERSION,
      bosses: { ...log.bosses, [bossName]: { name: bossName, nodeType, day, omens: nextOmens } },
      updatedAt: now,
    },
    changed: true,
    newKeys,
  };
}

/**
 * 记录按「需要特别提示的敌人优先、再按天数」排序，供界面列出。
 * @returns {{ name: string, nodeType: number | null, day: number | null, alert: boolean,
 *             omens: { kind: string, name: string, conditions: string[], firstSeenAt: number }[] }[]}
 */
export function listOmenLog(log) {
  return Object.values(log?.bosses || {})
    .map((boss) => ({
      name: boss.name,
      nodeType: boss.nodeType ?? null,
      day: boss.day ?? null,
      alert: OMEN_ALERT_NODE_TYPES.has(Number(boss.nodeType)),
      omens: Object.values(boss.omens || {})
        .map((omen) => ({ ...omen, kind: omen.kind || "omen" }))
        .sort((a, b) => a.firstSeenAt - b.firstSeenAt),
    }))
    .sort(
      (a, b) =>
        Number(b.alert) - Number(a.alert) ||
        (b.day || 0) - (a.day || 0) ||
        a.name.localeCompare(b.name),
    );
}

/** 某个敌人已记录的预兆数 */
export function knownOmenCount(log, bossName) {
  return Object.keys(log?.bosses?.[cleanText(bossName)]?.omens || {}).length;
}
