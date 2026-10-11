import assert from "node:assert/strict";
import {
  enemyKey,
  enemyVerdict,
  lastKill,
  listEnemies,
  recordKills,
  recordSightings,
} from "./shared/enemyLog.js";

const boss = (pos, name, lv, hp, hpMax = hp) => ({ pos, name, nameEn: "", lv, hp, hpMax, alive: hp > 0 });
const battle = (raidId, turn, bosses, extra = {}) => ({
  raidId: String(raidId),
  isArcarum3: true,
  nodeType: 5,
  turn,
  bosses,
  ...extra,
});

assert.equal(enemyKey({ name: "ゴブリン", lv: "30" }), "ゴブリン|Lv30");
assert.equal(enemyKey({ name: "ゴブリン", lv: "" }), "ゴブリン|Lv?");
assert.equal(enemyKey({ name: "", nameEn: "Goblin", lv: 5 }), "Goblin|Lv5", "没有日文名时用英文名");
assert.equal(enemyKey({}), "");
assert.notEqual(
  enemyKey({ name: "ゴブリン", lv: "30" }),
  enemyKey({ name: "ゴブリン", lv: "60" }),
  "同名不同等级算两个敌人",
);

// —— 事件战斗（格子类型 5）：遇到两个敌人 ——
let log = null;
let start = battle(1, 1, [boss(0, "盗賊", "40", 800000), boss(1, "盗賊の手下", "35", 300000)]);
({ log } = recordSightings(log, start, 100));
assert.equal(Object.keys(log.enemies).length, 2);
assert.deepEqual(
  [log.enemies["盗賊|Lv40"].hpMax, log.enemies["盗賊|Lv40"].seen, log.enemies["盗賊|Lv40"].nodeType],
  [800000, 1, 5],
  "事件里的敌人照样记血量和等级",
);
assert.equal(enemyVerdict(log, start.bosses[0]).status, "seen");
assert.equal(enemyVerdict(log, boss(0, "見知らぬ敵", "1", 1)).status, "new");
assert.equal(enemyVerdict(null, start.bosses[0]).status, "new");

// 第 1 回合：打死手下，盗賊还活着
let after = battle(1, 1, [boss(0, "盗賊", "40", 200000, 800000), boss(1, "盗賊の手下", "35", 0, 300000)]);
let result = recordKills(log, start, after, 110);
assert.deepEqual(result.killed, ["盗賊の手下|Lv35"]);
log = result.log;
assert.deepEqual(
  [log.enemies["盗賊の手下|Lv35"].kills, log.enemies["盗賊の手下|Lv35"].oneTurnKills, log.enemies["盗賊の手下|Lv35"].bestTurns],
  [1, 1, 1],
);
assert.equal(log.enemies["盗賊|Lv40"].kills, 0);

// 第 2 回合：打死盗賊 → 记击杀，但不是一回合
const turn2 = { ...after, turn: 2 };
after = battle(1, 3, [boss(0, "盗賊", "40", 0, 800000), boss(1, "盗賊の手下", "35", 0, 300000)]);
result = recordKills(log, turn2, after, 120);
assert.deepEqual(result.killed, ["盗賊|Lv40"], "已经死了的不重复记");
log = result.log;
assert.deepEqual(
  [log.enemies["盗賊|Lv40"].kills, log.enemies["盗賊|Lv40"].oneTurnKills, log.enemies["盗賊|Lv40"].bestTurns],
  [1, 0, 2],
);

// —— 上次几回合打死（不是一回合的也记） ——
assert.equal(lastKill(log, boss(0, "見知らぬ敵", "1", 1)), null, "没打死过的没有记录");
assert.deepEqual(lastKill(log, boss(0, "盗賊", "40", 800000)), {
  turns: 2,
  hp: 800000,
  oneTurn: false,
  label: "上次 2 回合打死",
});
assert.deepEqual(lastKill(log, boss(0, "盗賊の手下", "35", 300000)), {
  turns: 1,
  hp: 300000,
  oneTurn: true,
  label: "上次 1 回合打死",
});
assert.equal(lastKill(null, boss(0, "盗賊", "40", 1)), null);

// —— 标记 ——
let verdict = enemyVerdict(log, boss(0, "盗賊の手下", "35", 300000));
assert.equal(verdict.status, "one-turn", "以前一回合打死过 → 绿色标记");
assert.equal(verdict.label, "一回合击杀过");
verdict = enemyVerdict(log, boss(0, "盗賊", "40", 800000));
assert.equal(verdict.status, "killed");
assert.equal(verdict.label, "最快 2 回合击杀");

// —— 下一次遇到盗賊：第 1 回合打死，升级成一回合击杀 ——
start = battle(2, 1, [boss(0, "盗賊", "40", 850000)], { nodeType: 2 });
({ log } = recordSightings(log, start, 200));
assert.equal(log.enemies["盗賊|Lv40"].seen, 2);
assert.equal(log.enemies["盗賊|Lv40"].hpMax, 850000, "血量以最近一次为准");
assert.equal(log.enemies["盗賊|Lv40"].hpMaxSeen, 850000);
assert.equal(log.enemies["盗賊|Lv40"].nodeType, 2);
({ log } = recordKills(log, start, battle(2, 1, [boss(0, "盗賊", "40", 0, 850000)], { nodeType: 2 }), 210));
verdict = enemyVerdict(log, boss(0, "盗賊", "40", 850000));
assert.equal(verdict.status, "one-turn");
assert.deepEqual(
  [log.enemies["盗賊|Lv40"].kills, log.enemies["盗賊|Lv40"].oneTurnKills, log.enemies["盗賊|Lv40"].bestTurns, log.enemies["盗賊|Lv40"].lastKillTurns],
  [2, 1, 1, 1],
);
({ log } = recordSightings(log, start, 300));
({ log } = recordKills(log, start, battle(2, 1, [boss(0, "盗賊", "40", 0)], { nodeType: 2 }), 310));
assert.equal(enemyVerdict(log, boss(0, "盗賊", "40", 1)).label, "一回合击杀过 ×2");

// 「上次」记的是最近一次，不是最快的一次；同时记下那次的血量
const slow = battle(3, 4, [boss(0, "盗賊", "40", 2_000_000)], { nodeType: 3 });
({ log } = recordSightings(log, slow, 400));
({ log } = recordKills(log, slow, battle(3, 5, [boss(0, "盗賊", "40", 0, 2_000_000)], { nodeType: 3 }), 410));
assert.deepEqual(lastKill(log, boss(0, "盗賊", "40", 2_000_000)), {
  turns: 4,
  hp: 2_000_000,
  oneTurn: false,
  label: "上次 4 回合打死",
});
assert.equal(log.enemies["盗賊|Lv40"].bestTurns, 1, "最快记录仍然保留");

// —— 不该记的情况 ——
const normalRaid = { ...start, isArcarum3: false };
assert.equal(recordSightings(log, normalRaid).changed, false, "非肉鸽战斗不记");
assert.equal(recordKills(log, normalRaid, { ...normalRaid, bosses: [boss(0, "盗賊", "40", 0)] }).changed, false);
assert.equal(recordKills(log, null, start).changed, false, "没有行动前的状态时不判定击杀");
assert.equal(
  recordKills(log, battle(8, 1, [boss(0, "盗賊", "40", 5)]), battle(9, 1, [boss(0, "盗賊", "40", 0)])).changed,
  false,
  "换了一场战斗：上一场的状态不能拿来比",
);
assert.equal(recordKills(log, start, start).changed, false, "没人死就不变");

// 没登记过就被打死（比如插件中途才打开）：也补一条
const fresh = recordKills(null, battle(5, 1, [boss(0, "突然の敵", "9", 100)]), battle(5, 1, [boss(0, "突然の敵", "9", 0, 100)]), 1);
assert.equal(fresh.log.enemies["突然の敵|Lv9"].oneTurnKills, 1);

// —— 列表：最近遇到的在前 ——
assert.deepEqual(listEnemies(log).map((entry) => entry.name), ["盗賊", "盗賊の手下"]);
assert.deepEqual(listEnemies(null), []);

console.log("enemy log tests passed");
