/**
 * 敌人记录：每个敌人（按名字 + 等级区分）的血量和击杀历史，跨局保留。
 * 再遇到同一个敌人时，就能知道以前是不是一回合打死过。
 * 事件里的敌人、强敌、Boss 都记，只要是肉鸽战斗里出现的敌人。
 */

export const ENEMY_LOG_VERSION = 1;

export function createEnemyLog() {
  return { version: ENEMY_LOG_VERSION, enemies: {}, updatedAt: null };
}

/** 同名敌人在不同等级下血量不同，所以等级也算进标识 */
export function enemyKey(boss) {
  const name = String(boss?.name || boss?.nameEn || "").trim();
  if (!name) return "";
  return `${name}|Lv${String(boss?.lv ?? "").trim() || "?"}`;
}

function baseLog(log) {
  return log?.version === ENEMY_LOG_VERSION ? log : createEnemyLog();
}

/**
 * 进入一场新战斗：登记出现的敌人（血量、等级、所在格子类型）。
 * @returns {{ log: object, changed: boolean }}
 */
export function recordSightings(previousLog, battle, now = Date.now()) {
  const log = baseLog(previousLog);
  if (!battle?.isArcarum3) return { log, changed: false };
  const enemies = { ...log.enemies };
  let changed = false;
  for (const boss of battle.bosses || []) {
    const key = enemyKey(boss);
    if (!key) continue;
    const known = enemies[key];
    enemies[key] = {
      key,
      name: boss.name || boss.nameEn || "",
      nameEn: boss.nameEn || known?.nameEn || "",
      lv: String(boss.lv ?? ""),
      // 同一个敌人血量可能随难度变化：记最近一次的，另外保留见过的最大值
      hpMax: boss.hpMax || known?.hpMax || 0,
      hpMaxSeen: Math.max(known?.hpMaxSeen || 0, boss.hpMax || 0),
      nodeType: battle.nodeType ?? known?.nodeType ?? null,
      seen: (known?.seen || 0) + 1,
      kills: known?.kills || 0,
      oneTurnKills: known?.oneTurnKills || 0,
      bestTurns: known?.bestTurns ?? null,
      lastKillTurns: known?.lastKillTurns ?? null,
      firstSeenAt: known?.firstSeenAt ?? now,
      lastSeenAt: now,
    };
    changed = true;
  }
  return changed ? { log: { ...log, enemies, updatedAt: now }, changed } : { log, changed };
}

/**
 * 一次行动之后：这次行动里被打死的敌人记一次击杀。
 * 击杀回合 = 行动发生时战斗的回合数；第 1 回合内打死就算「一回合击杀」。
 *
 * @param {object | null} before 行动前的战斗状态
 * @param {object | null} after 行动后的战斗状态
 * @returns {{ log: object, changed: boolean, killed: string[] }}
 */
export function recordKills(previousLog, before, after, now = Date.now()) {
  const log = baseLog(previousLog);
  if (!after?.isArcarum3 || !before || before.raidId !== after.raidId) {
    return { log, changed: false, killed: [] };
  }
  const turn = Math.max(1, Number(before.turn) || 1);
  const enemies = { ...log.enemies };
  const killed = [];
  for (const boss of after.bosses || []) {
    const was = (before.bosses || []).find((item) => item.pos === boss.pos);
    if (!was || !was.alive || boss.alive) continue;
    const key = enemyKey(was);
    if (!key) continue;
    const known = enemies[key] || {
      key,
      name: was.name || was.nameEn || "",
      nameEn: was.nameEn || "",
      lv: String(was.lv ?? ""),
      hpMax: was.hpMax || 0,
      hpMaxSeen: was.hpMax || 0,
      nodeType: after.nodeType ?? null,
      seen: 1,
      kills: 0,
      oneTurnKills: 0,
      bestTurns: null,
      lastKillTurns: null,
      firstSeenAt: now,
      lastSeenAt: now,
    };
    enemies[key] = {
      ...known,
      kills: known.kills + 1,
      oneTurnKills: known.oneTurnKills + (turn === 1 ? 1 : 0),
      bestTurns: known.bestTurns == null ? turn : Math.min(known.bestTurns, turn),
      lastKillTurns: turn,
      // 难度和局外加成会改血量：记下那次打死时它有多少血，方便对照
      lastKillHp: was.hpMax || known.hpMax || 0,
      lastSeenAt: now,
    };
    killed.push(key);
  }
  return killed.length
    ? { log: { ...log, enemies, updatedAt: now }, changed: true, killed }
    : { log, changed: false, killed };
}

/**
 * 这个敌人以前的战绩，给界面上的标记用。
 * @returns {{ status: 'one-turn' | 'killed' | 'seen' | 'new', label: string, entry: object | null }}
 *   one-turn：以前一回合打死过（绿色标记）
 */
export function enemyVerdict(log, boss) {
  const entry = log?.enemies?.[enemyKey(boss)] || null;
  if (!entry) return { status: "new", label: "首次遇到", entry: null };
  if (entry.oneTurnKills > 0) {
    return {
      status: "one-turn",
      label: `一回合击杀过${entry.oneTurnKills > 1 ? ` ×${entry.oneTurnKills}` : ""}`,
      entry,
    };
  }
  if (entry.kills > 0) {
    return { status: "killed", label: `最快 ${entry.bestTurns} 回合击杀`, entry };
  }
  return { status: "seen", label: "遇到过，还没打死过", entry };
}

/**
 * 上次打死这个敌人用了几回合（一回合打死的也算），没打死过返回 null。
 * @returns {{ turns: number, hp: number, oneTurn: boolean, label: string } | null}
 */
export function lastKill(log, boss) {
  const entry = log?.enemies?.[enemyKey(boss)];
  if (!entry?.lastKillTurns) return null;
  return {
    turns: entry.lastKillTurns,
    hp: entry.lastKillHp || entry.hpMax || 0,
    oneTurn: entry.lastKillTurns === 1,
    label: `上次 ${entry.lastKillTurns} 回合打死`,
  };
}

/** 列表：最近遇到的排前面 */
export function listEnemies(log) {
  return Object.values(log?.enemies || {}).sort(
    (a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0) || a.key.localeCompare(b.key),
  );
}
