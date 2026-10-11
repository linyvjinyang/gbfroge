/**
 * 地图窗口里与「打得动打不动」有关的部分：
 * 盘子（导本页）、当前伤害、预兆提示与记录、导本速查。
 */
import { MSG } from "../shared/constants.js";
import {
  effectLabelUrl,
  summarizeDeck,
  summonImageUrl,
  weaponImageUrl,
} from "../shared/deck.js";
import {
  ACTION_LABEL,
  TIER_YELLOW_RATIO,
  enemyTier,
  isRecordedBattle,
  predictKill,
  statusIconUrl,
} from "../shared/battle.js";
import { battleStatusNotes, findBossGuide } from "../shared/bossMechanics.js";
import { CAP_TABLES, displayedCap } from "../shared/damageCap.js";
import { compareWithOneTurnKills, groupEnemiesByCategory } from "../shared/enemyCategory.js";
import { formatCompact } from "../shared/format.js";
import { lastKill, listEnemies } from "../shared/enemyLog.js";
import { aggregateGuidebookEffects } from "../shared/guidebookEffects.js";
import { buildQuickRef, hideQuickRefItem } from "../shared/guidebookQuickRef.js";
import { NODE_TYPE_META } from "../shared/nodeTypes.js";
import { OMEN_ALERT_NODE_TYPES, knownOmenCount, listOmenLog } from "../shared/omens.js";
import { mergePartyView, splitPartyRows } from "../shared/party.js";

const $ = (id) => document.getElementById(id);

const numberFormat = new Intl.NumberFormat("zh-CN");
const formatNumber = (value) => numberFormat.format(Math.round(Number(value) || 0));
const formatPercent = (value) => `${Math.round(Number(value) * 1000) / 10}%`;

/** 实测值达到上限参考的这个比例就视为顶到上限 */
const CAP_REACHED_RATIO = 0.97;
const QUICKREF_HIDDEN_STORAGE_KEY = "gbfroge-quickref-hidden-v1";

const MOD_LABELS = [
  ["atk", "攻击力"],
  ["elementAtk", "自属性攻击"],
  ["enhance", "加护强化"],
  ["capAll", "伤害上限"],
  ["capSkill", "技能上限"],
  ["capSpecial", "奥义上限"],
  ["capChain", "连锁上限"],
  ["capSpecialHard", "奥义特殊上限"],
  ["ampAll", "造成伤害"],
  ["ampAttack", "通常攻击造成伤害"],
  ["ampSkill", "技能造成伤害"],
  ["ampSpecial", "奥义造成伤害"],
  ["ampChain", "连锁造成伤害"],
  ["skillDamage", "技能伤害"],
  ["specialDamage", "奥义伤害"],
  ["chainDamage", "连锁伤害"],
];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * 伤害、血量这类大数字：格子里用「万 / 亿」的紧凑写法，完整数值放在悬浮提示里。
 * @param {string} [prefix] 悬浮提示里数值前面的说明
 */
function numberEl(tag, className, value, prefix = "") {
  const node = el(tag, className, formatCompact(value));
  node.title = `${prefix}${formatNumber(value)}`;
  return node;
}

function nodeTypeName(nodeType) {
  return NODE_TYPE_META[Number(nodeType)]?.name || "";
}

function weaponTooltip(weapon) {
  const lines = [`${weapon.name || "武器"}${weapon.level ? ` Lv${weapon.level}` : ""}`];
  for (const skill of weapon.skills || []) {
    lines.push(`· ${skill.name}${skill.description ? `：${skill.description}` : ""}`);
  }
  return lines.join("\n");
}

/** 游戏内排布：主手竖放在左，2–10 为 3×3，11–13 为右侧追加列 */
function weaponGridArea(slot) {
  if (slot === 1) return { column: "1", row: "1 / span 3" };
  if (slot <= 10) {
    return {
      column: String(((slot - 2) % 3) + 2),
      row: String(Math.floor((slot - 2) / 3) + 1),
    };
  }
  return { column: "5", row: String(slot - 10) };
}

/** 图片加载失败时退回文字，避免留下破图 */
function imageOrText(url, alt, fallbackText) {
  const holder = el("span", "thumb");
  const image = el("img");
  image.alt = alt;
  image.loading = "lazy";
  image.addEventListener("error", () => {
    holder.replaceChildren(el("span", "thumb-text", fallbackText));
  });
  image.src = url;
  holder.append(image);
  return holder;
}

function loadHiddenQuickRef() {
  try {
    const saved = JSON.parse(localStorage.getItem(QUICKREF_HIDDEN_STORAGE_KEY) || "[]");
    return Array.isArray(saved) ? saved.map(Number).filter(Number.isFinite) : [];
  } catch {
    return [];
  }
}

export function createBuildView() {
  let deckState = null;
  let battle = null;
  let guidebooks = null;
  let omenLog = null;
  let party = null;
  let enemyLog = null;
  let hiddenQuickRef = loadHiddenQuickRef();

  // ———————————————— 盘子 ————————————————

  function renderDeck() {
    const deck = deckState?.deck || null;
    const summary = summarizeDeck(deckState);
    const time = deckState?.capturedAt
      ? new Date(deckState.capturedAt).toLocaleTimeString()
      : "";
    $("build-count").textContent = deck ? `${summary.total} 把 · 读取于 ${time}` : "未读取";
    $("build-empty").hidden = Boolean(deck);

    const grid = $("build-grid");
    const summonRow = $("build-summons");
    const effects = $("build-effects");
    grid.replaceChildren();
    summonRow.replaceChildren();
    effects.replaceChildren();
    grid.hidden = !deck;
    summonRow.hidden = !deck || !deck.summons.length;
    effects.hidden = true;
    if (!deck) return;

    deck.weapons.forEach((weapon, index) => {
      const slot = index + 1;
      const area = weaponGridArea(slot);
      const cell = el("div", `weapon-cell${slot === 1 ? " is-main" : ""}${weapon ? "" : " is-blank"}`);
      cell.style.gridColumn = area.column;
      cell.style.gridRow = area.row;
      if (weapon) {
        cell.title = weaponTooltip(weapon);
        cell.append(
          imageOrText(
            weaponImageUrl(weapon, slot === 1 ? "ls" : "m"),
            weapon.name || `武器 ${slot}`,
            weapon.name || `#${slot}`,
          ),
        );
      }
      grid.append(cell);
    });

    for (const summon of deck.summons) {
      const cell = el("div", `summon-cell${summon.isMain ? " is-main" : ""}`);
      cell.title = `${summon.name || "召唤石"}${summon.level ? ` Lv${summon.level}` : ""}`;
      cell.append(imageOrText(summonImageUrl(summon), summon.name || "召唤石", summon.name || "石"));
      summonRow.append(cell);
    }

    const list = deck.damageInfo?.effects || [];
    for (const effect of list) {
      const item = el("div", `effect-item${effect.isMax ? " is-max" : ""}`);
      if (effect.isMax) item.title = "已达上限";
      item.append(
        imageOrText(effectLabelUrl(effect), "", effect.icon.replace(/\.\w+$/, "")),
        el("span", "effect-value", effect.value),
      );
      effects.append(item);
    }
    effects.hidden = !list.length;
  }

  // ———————————————— 当前伤害 ————————————————

  function renderEstimate() {
    const info = deckState?.deck?.damageInfo || null;
    const list = $("damage-estimate");
    list.replaceChildren();
    const rows = [
      ["面板预估", info?.normalDamage],
      ["克制预估", info?.advantageDamage],
      ["HP", info?.hp],
    ].filter(([, value]) => value != null);
    for (const [label, value] of rows) {
      list.append(el("dt", "", label), numberEl("dd", "", value));
    }
    const enhance = info?.enhance;
    if (enhance && [enhance.normal, enhance.magna, enhance.ex].some((value) => value != null)) {
      list.append(
        el("dt", "", "加护强化"),
        el(
          "dd",
          "",
          `通常 ${enhance.normal ?? 0}% · 方阵 ${enhance.magna ?? 0}% · EX ${enhance.ex ?? 0}%`,
        ),
      );
    }
    list.hidden = !list.children.length;
  }

  function conditionStrip(conditions) {
    const strip = el("div", "condition-strip");
    for (const condition of conditions.slice(0, 24)) {
      const icon = el("img", condition.isDebuff ? "is-debuff" : "");
      const label = condition.detail || `状态 ${condition.status}`;
      icon.alt = label;
      icon.title = label + (condition.remain != null ? `（剩余 ${condition.remain}）` : "");
      icon.loading = "lazy";
      icon.addEventListener("error", () => icon.remove());
      icon.src = statusIconUrl(condition.status);
      strip.append(icon);
    }
    return strip;
  }

  /**
   * 敌人血条：实色是当前血量；末端的高亮段是按攻击回合记录这一回合能打掉的部分。
   */
  function renderEnemies() {
    const box = $("damage-enemies");
    box.replaceChildren();
    const prediction = predictKill(battle);
    const hitByPos = new Map(prediction.enemies.map((enemy) => [enemy.pos, enemy]));

    for (const boss of battle?.bosses || []) {
      const max = boss.hpMax > 0 ? boss.hpMax : 0;
      const ratio = max ? Math.max(0, Math.min(1, boss.hp / max)) : 0;
      const hit = prediction.reference > 0 ? hitByPos.get(boss.pos) : null;
      const hitRatio = hit && max ? Math.max(0, Math.min(ratio, hit.damage / max)) : 0;

      // 难度档位：拿血量去比本局一回合打死过的最大血量，用血条颜色表示
      const tier = enemyTier(battle, boss);
      const row = el(
        "div",
        `enemy-row is-tier-${tier.tier}${boss.alive ? "" : " is-dead"}${hit?.kill ? " is-kill" : ""}`,
      );
      const head = el("div", "enemy-head");
      const name = el("span", "enemy-name", `${boss.name || "敌人"}${boss.lv ? ` Lv${boss.lv}` : ""}`);
      // 档位标记单独放在血条下面：名字很长时不会把它挤没
      let badge = null;
      if (tier.tier !== "unknown") {
        const label =
          tier.tier === "green"
            ? "一回合打得死"
            : `血量是一回合记录的 ${tier.ratio < 10 ? tier.ratio.toFixed(1) : Math.round(tier.ratio)} 倍`;
        badge = el("span", `enemy-badge is-tier-${tier.tier}`, label);
        badge.title = `本局一回合打死过的最大血量：${formatNumber(tier.reference)}`;
      }
      head.append(
        name,
        (() => {
          const hp = el(
            "span",
            "enemy-hp",
            `${formatCompact(boss.hp)} / ${formatCompact(boss.hpMax)}（${formatPercent(ratio)}）`,
          );
          hp.title = `${formatNumber(boss.hp)} / ${formatNumber(boss.hpMax)}`;
          return hp;
        })(),
      );

      const bar = el("div", "enemy-bar");
      bar.setAttribute("role", "progressbar");
      bar.setAttribute("aria-label", `${boss.name || "敌人"} 血量`);
      bar.setAttribute("aria-valuemin", "0");
      bar.setAttribute("aria-valuemax", "100");
      bar.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
      // 打完之后还剩的部分
      const fill = el("div", "enemy-bar-fill");
      fill.style.width = `${(ratio - hitRatio) * 100}%`;
      bar.append(fill);
      if (hitRatio > 0) {
        // 这一回合能打掉的部分，紧接在剩余血量后面
        const chunk = el("div", "enemy-bar-hit");
        chunk.style.left = `${(ratio - hitRatio) * 100}%`;
        chunk.style.width = `${hitRatio * 100}%`;
        bar.append(chunk);
      }
      row.append(head, bar);

      // 归类：这是哪一类敌人、多少级；本局同类里一回合打死过多少级的、血量差多少
      const compare = battle?.isArcarum3 ? compareWithOneTurnKills(battle, boss) : null;
      if (compare) {
        const parts = [`${compare.category}${compare.lv ? ` Lv${compare.lv}` : ""}`];
        if (compare.reference) {
          const ref = compare.reference;
          const who = `${ref.sameCategory ? "" : ref.category}${ref.lv ? ` Lv${ref.lv}` : ""}`.trim() || "敌人";
          parts.push(`本局一回合打死过${ref.sameCategory ? "同类" : ""} ${who}（${formatCompact(ref.hpMax)}）`);
          if (compare.ratio != null) {
            parts.push(
              compare.ratio <= 1
                ? "这只血量不超过它"
                : `这只血量是它的 ${compare.ratio < 10 ? compare.ratio.toFixed(1) : Math.round(compare.ratio)} 倍`,
            );
          }
        } else {
          parts.push("本局还没有一回合打死过敌人");
        }
        const categoryLine = el("div", "enemy-category", parts.join(" · "));
        if (compare.reference) {
          categoryLine.title =
            `那只的血量 ${formatNumber(compare.reference.hpMax)}，这只 ${formatNumber(boss.hpMax)}`;
        }
        row.append(categoryLine);
      }

      const meta = el("div", "enemy-meta");
      if (badge) meta.append(badge);
      // 上次打死这个敌人用了几回合（跨局记录）
      const last = battle?.isArcarum3 ? lastKill(enemyLog, boss) : null;
      if (last) {
        const lastBadge = el("span", `enemy-badge is-last${last.oneTurn ? " is-one-turn" : ""}`, last.label);
        lastBadge.title =
          last.hp && last.hp !== boss.hpMax
            ? `那次它的血量是 ${formatNumber(last.hp)}，这次是 ${formatNumber(boss.hpMax)}`
            : "和这次血量相同";
        meta.append(lastBadge);
      }
      if (hit) {
        const text = hit.kill
          ? `一回合可击杀（记录 ${formatCompact(prediction.reference)}）`
          : `一回合 −${formatCompact(hit.damage)}（${formatPercent(hitRatio)}），打完剩 ` +
            formatCompact(hit.hpAfter);
        const hitText = el("span", "enemy-hit-text", text);
        hitText.title = hit.kill
          ? `攻击回合记录 ${formatNumber(prediction.reference)}`
          : `一回合 −${formatNumber(hit.damage)}，打完剩 ${formatNumber(hit.hpAfter)}`;
        meta.append(hitText);
      }
      if (meta.children.length) row.append(meta);
      if (boss.conditions?.length) row.append(conditionStrip(boss.conditions));
      box.append(row);
    }

    // 颜色说明：只在有敌人时出现
    const legend = $("enemy-tier-legend");
    const reference = battle?.isArcarum3 ? battle?.record?.oneTurnHp || 0 : 0;
    legend.hidden = !battle?.bosses?.length || !battle.isArcarum3;
    legend.title = reference ? `本局一回合打死过的最大血量：${formatNumber(reference)}` : "";
    legend.textContent = reference
      ? `血条颜色按血量比本局一回合打死过的最大血量（${formatCompact(reference)}）：` +
        `绿 不超过 · 黄 ${TIER_YELLOW_RATIO} 倍以内 · 红 更高`
      : "本局还没有一回合打死过敌人，血条暂不分颜色。";
  }

  /** 最近一次按攻击后的命中统计：hit / 奥伤(几连锁) / 技伤 / 总伤害 */
  function attackInfoBox() {
    if (!battle?.bosses?.length) return null;
    const info = battle.lastAttack;
    const wrap = el("div", "attack-info");
    wrap.setAttribute("role", "group");
    wrap.setAttribute("aria-label", "按攻击后的命中统计");
    if (!info) {
      wrap.append(el("span", "attack-info-empty", "按攻击后显示 hit 数"));
      return wrap;
    }
    const where = `第 ${info.turn} 回合按攻击后（只算到敌人行动之前）`;
    const tag = (className, label, value, exact) => {
      const item = el("span", `attack-tag ${className}`);
      item.title = `${where}\n${label}：${exact}`;
      item.append(el("span", "attack-tag-label", label), el("strong", "", value));
      return item;
    };
    const special = `奥伤${info.chain ? `(${info.chain}c)` : ""}`;
    wrap.append(
      tag("is-hit", "hit", String(info.hit), `${info.hit} 次`),
      tag("is-special", special, formatCompact(info.special), formatNumber(info.special)),
      tag("is-ability", "技伤", formatCompact(info.ability), formatNumber(info.ability)),
      tag(
        "is-total",
        "总伤害",
        formatCompact(info.total),
        `${formatNumber(info.total)}（其中通常攻击 ${formatNumber(info.attack || 0)}）`,
      ),
    );
    return wrap;
  }

  /** 最上面：队伍血量（横排）；下面可折叠的战斗状态（每人一组图标，也横排） */
  function renderParty() {
    const view = mergePartyView(party, battle);
    const hasMembers = view.members.length > 0;
    $("party-empty").hidden = hasMembers;
    $("party-source").textContent =
      view.source === "battle" ? "战斗中" : view.source === "map" ? "地图" : "";

    const partyTile = (member) => {
      const ratio = member.hpMax > 0 ? Math.max(0, Math.min(1, member.hp / member.hpMax)) : 0;
      const label = member.name || `${member.index + 1} 号位`;
      const tile = el(
        "div",
        `party-tile${member.alive ? "" : " is-dead"}${ratio < 0.25 ? " is-danger" : ""}`,
      );
      tile.title = `${label}：${formatNumber(member.hp)} / ${formatNumber(member.hpMax)}`;
      const portrait = member.imageUrl
        ? imageOrText(member.imageUrl, label, label)
        : el("span", "thumb", "");
      if (!member.imageUrl) portrait.append(el("span", "thumb-text", label));
      const bar = el("div", "party-bar");
      bar.setAttribute("role", "progressbar");
      bar.setAttribute("aria-label", `${label} 血量`);
      bar.setAttribute("aria-valuemin", "0");
      bar.setAttribute("aria-valuemax", "100");
      bar.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
      const fill = el("div", "party-bar-fill");
      fill.style.width = `${ratio * 100}%`;
      bar.append(fill);
      tile.append(portrait, bar, el("span", "party-hp-text", formatNumber(member.hp)));
      return tile;
    };

    // 上面一行前排，下面一行后排
    const box = $("party-hp");
    box.replaceChildren();
    const rows = splitPartyRows(view.members);
    let backRow = null;
    for (const [label, members] of [["前排", rows.front], ["后排", rows.back]]) {
      if (!members.length) continue;
      const row = el("div", `party-row${label === "后排" ? " is-back" : ""}`);
      row.setAttribute("role", "group");
      row.setAttribute("aria-label", label);
      const tiles = el("div", "party-row-tiles");
      tiles.append(...members.map(partyTile));
      row.append(el("span", "party-row-label", label), tiles);
      box.append(row);
      if (label === "后排") backRow = row;
    }

    // 按攻击后的 hit 数（仿 Tarou）：放在后排右边的空位；没有后排时单独占一行
    const attackInfo = attackInfoBox();
    if (attackInfo) {
      if (backRow) backRow.append(attackInfo);
      else box.append(attackInfo);
    }

    // 战斗状态只看前排；后排的状态在换上来之前没有意义
    const withStatus = view.members
      .map((member, index) => ({ ...member, label: member.name || `${index + 1} 号位` }))
      .filter((member) => member.front && member.conditions.length);
    const fold = $("party-status-fold");
    fold.hidden = !withStatus.length;
    const status = $("party-status");
    status.replaceChildren();
    for (const member of withStatus) {
      const group = el("div", "party-status-group");
      group.append(el("span", "party-status-name", member.label), conditionStrip(member.conditions));
      status.append(group);
    }
  }

  /** 攻击回合记录；逐个敌人的对比只在第 1 回合画在各自的血条上 */
  function renderKill() {
    const prediction = predictKill(battle);
    const record = battle?.record?.attackTurn || 0;
    $("damage-record").textContent = record ? formatCompact(record) : "—";
    $("damage-record").title = record ? formatNumber(record) : "";
    $("btn-record-reset").disabled = !record;

    const box = $("damage-kill");
    const text = $("damage-kill-text");
    box.classList.remove("is-kill", "is-far");

    const inBattle = Boolean(battle?.bosses?.length);
    if (inBattle && !isRecordedBattle(battle)) {
      text.textContent = "非肉鸽战斗不计入记录。";
      return;
    }
    if (!record) {
      text.textContent = "按一次攻击后开始记录。";
      return;
    }
    // 预测只在第 1 回合给；之后这一行留空，只保留记录数字
    if (!prediction.active || !prediction.enemies.length) {
      text.textContent = "";
      return;
    }
    const killable = prediction.enemies.filter((enemy) => enemy.kill).length;
    text.textContent =
      prediction.enemies.length === 1
        ? prediction.enemies[0].kill
          ? "第 1 回合可击杀。"
          : "一回合打不死。"
        : `${killable} / ${prediction.enemies.length} 个敌人一回合可击杀。`;
    box.classList.add(killable === prediction.enemies.length ? "is-kill" : "is-far");
  }

  /** 这场战斗里要显示的规则类状态（敌人身上的，加上我方身上带解除方式的） */
  function currentBossNotes() {
    return battleStatusNotes(battle);
  }

  /**
   * 需要立刻看到的提示：当前预兆的解除条件，以及 Boss 身上带解除方式的特殊状态
   * （最终 Boss 的三种「命运」会给出中文的解除条件）。
   * Boss / 君临者格、以及第一次见到的条目，用更醒目的样式。
   */
  function renderOmenAlert() {
    const box = $("omen-alert");
    const omens = battle?.isArcarum3 ? battle?.omens || [] : [];
    const statuses = battle?.isArcarum3 ? currentBossNotes().filter((note) => note.alert) : [];
    box.hidden = !omens.length && !statuses.length;
    box.classList.remove("is-major", "is-new", "is-double");
    if (box.hidden) return;
    // 普通预兆和特殊状态可能在同一回合一起出现：两段都列出来，各自的解除条件都要满足
    const both = omens.length > 0 && statuses.length > 0;
    box.classList.toggle("is-double", both);

    const bossName = battle.bosses?.[0]?.name || "敌人";
    const newKeys = new Set(battle.newOmenKeys || []);
    const hasNew = [...omens, ...statuses].some((item) => newKeys.has(item.key));
    const major = OMEN_ALERT_NODE_TYPES.has(Number(battle.nodeType)) || statuses.length > 0;
    box.classList.toggle("is-major", major);
    box.classList.toggle("is-new", hasNew);

    const names = omens.map((omen) => omen.name).filter(Boolean);
    const kind = both ? "预兆 + 特殊状态同时出现" : omens.length ? "预兆" : "特殊状态";
    $("omen-alert-title").textContent =
      `${bossName}：${kind}` + (names.length ? `「${names.join(" / ")}」` : "");
    $("omen-alert-tag").hidden = !hasNew;

    const list = $("omen-alert-list");
    list.replaceChildren();
    for (const omen of omens) {
      for (const condition of omen.conditions) list.append(el("li", "", condition));
      if (!omen.conditions.length) list.append(el("li", "is-empty", "没有给出解除条件"));
    }
    $("omen-alert-omens").hidden = !omens.length;

    const statusList = $("omen-alert-status");
    statusList.replaceChildren();
    for (const note of statuses) {
      const item = el("li");
      if (note.title) item.append(el("strong", "", note.title));
      if (note.hint) item.append(el("span", "omen-status-hint", note.hint));
      item.append(el("span", "omen-status-raw", note.text));
      statusList.append(item);
    }
    $("omen-alert-statuses").hidden = !statuses.length;

    $("omen-alert-note").textContent =
      `这个敌人已记录 ${knownOmenCount(omenLog, bossName)} 条预兆 / 特殊状态` +
      (hasNew ? "，其中有第一次出现的。" : "。");
  }

  /** 战斗面板里：Boss 的规则类状态原文 + 已知 Boss 的机制速查 */
  function renderBossNotes() {
    const notes = currentBossNotes();
    const list = $("boss-notes");
    list.replaceChildren();
    for (const note of notes) {
      const item = el("li", note.alert ? "is-alert" : "");
      if (note.title) item.append(el("strong", "", `${note.title}：`));
      item.append(document.createTextNode(note.hint || note.text));
      if (note.hint) item.title = note.text;
      list.append(item);
    }
    list.hidden = !notes.length;

    const boss = (battle?.bosses || []).find((item) => findBossGuide(item));
    const guide = boss ? findBossGuide(boss) : null;
    const fold = $("boss-guide");
    fold.hidden = !guide;
    const body = $("boss-guide-body");
    body.replaceChildren();
    if (!guide) return;
    $("boss-guide-title").textContent = `机制速查：${guide.title}`;

    const section = (title, items) => {
      if (!items?.length) return;
      body.append(el("h4", "boss-guide-heading", title));
      const ul = el("ul", "boss-guide-list");
      for (const text of items) ul.append(typeof text === "string" ? el("li", "", text) : text);
      body.append(ul);
    };
    const pair = (name, value) => {
      const li = el("li");
      li.append(el("strong", "", name), document.createTextNode(` → ${value}`));
      return li;
    };
    section("被动规则", guide.passive);
    section("预兆解除条件", guide.omens.map((omen) => pair(omen.name, omen.cancel)));
    section(
      "三种隐藏「命运」",
      (guide.destinies || []).map((destiny) => pair(`${destiny.title}（${destiny.effect}）`, destiny.remove)),
    );
    section("补充", guide.extra);
  }

  function renderOmenLog() {
    const bosses = listOmenLog(omenLog);
    $("omen-log-empty").hidden = bosses.length > 0;
    const box = $("omen-log");
    box.replaceChildren();
    for (const boss of bosses) {
      const block = el("section", `omen-log-boss${boss.alert ? " is-major" : ""}`);
      const meta = [nodeTypeName(boss.nodeType), boss.day ? `第 ${boss.day} 天` : "", `${boss.omens.length} 种`]
        .filter(Boolean)
        .join(" · ");
      const head = el("h3", "omen-log-name", boss.name);
      head.append(el("span", "card-count", meta));
      block.append(head);
      const list = el("ol", "omen-log-list");
      for (const omen of boss.omens) {
        const item = el("li");
        item.append(el("span", "omen-log-kind", omen.kind === "status" ? "状态" : "预兆"));
        if (omen.name) item.append(el("strong", "", `${omen.name}：`));
        item.append(document.createTextNode(omen.conditions.join(" / ") || "没有给出解除条件"));
        list.append(item);
      }
      block.append(list);
      box.append(block);
    }
  }

  function renderDamage() {
    const { mods, conditional, unknownProgress } = aggregateGuidebookEffects(
      guidebooks?.inventory,
      guidebooks?.catalogue,
    );
    const hasBattle = Boolean(battle?.bosses?.length);
    const typeName = nodeTypeName(battle?.nodeType);
    $("damage-turn").textContent = hasBattle
      ? `${battle.isArcarum3 ? typeName || "肉鸽战斗" : "非肉鸽战斗"} · 第 ${battle.turn} 回合`
      : "无战斗";
    $("damage-empty").hidden = hasBattle;
    renderOmenAlert();
    renderParty();
    renderEstimate();
    renderEnemies();
    renderBossNotes();
    renderKill();

    const last = battle?.lastAction || null;
    const best = battle?.best || { attack: 0, special: 0, other: 0 };
    const rows = [
      {
        label: "通常攻击",
        last: last?.attack,
        best: best.attack,
        cap: displayedCap(CAP_TABLES.attack.tiers, {
          capUp: mods.capAll,
          amplify: mods.ampAll + mods.ampAttack,
        }),
      },
      {
        label: "奥义",
        last: last?.special,
        best: best.special,
        cap: displayedCap(CAP_TABLES.special.tiers, {
          capUp: mods.capAll + mods.capSpecial,
          amplify: mods.ampAll + mods.ampSpecial,
        }),
      },
      // 技能的上限表每个技能各不相同，无法给统一参考值
      { label: "技能 / 其他", last: last?.other, best: best.other, cap: null },
    ];

    const body = $("damage-rows");
    body.replaceChildren();
    for (const row of rows) {
      const tr = document.createElement("tr");
      const reached = row.cap != null && row.best >= row.cap * CAP_REACHED_RATIO;
      const head = el("th", "", row.label);
      head.scope = "row";
      const bestCell = row.best
        ? numberEl("td", reached ? "is-capped" : "", row.best, reached ? "已接近上限参考：" : "")
        : el("td", "", "—");
      const lastCell = el("td", "", row.last?.hits ? `${formatCompact(row.last.max)} ×${row.last.hits}` : "—");
      if (row.last?.hits) {
        lastCell.title =
          `最高单发 ${formatNumber(row.last.max)}，共 ${row.last.hits} 下，合计 ${formatNumber(row.last.total)}`;
      }
      tr.append(
        head,
        lastCell,
        bestCell,
        row.cap != null ? numberEl("td", "", row.cap) : el("td", "", "按技能"),
      );
      body.append(tr);
    }
    $("damage-table").hidden = false;

    const lastLine = $("damage-last");
    if (last) {
      lastLine.hidden = false;
      lastLine.textContent =
        `最近一次行动（${ACTION_LABEL[last.kind] || last.kind} · 第 ${last.turn} 回合）合计 ` +
        formatCompact(last.total);
      lastLine.title = formatNumber(last.total);
    } else {
      lastLine.hidden = true;
    }

    const list = $("damage-mods");
    list.replaceChildren();
    for (const [field, label] of MOD_LABELS) {
      if (!mods[field]) continue;
      list.append(el("dt", "", `导本·${label}`), el("dd", "", `+${formatPercent(mods[field])}`));
    }
    list.hidden = !list.children.length;
    $("guide-total-empty").hidden = list.children.length > 0;
    const held = Object.values(guidebooks?.inventory || {}).filter((item) => (item?.num || 0) > 0);
    $("guide-total-count").textContent = held.length
      ? `${held.length} 种 / ${held.reduce((sum, item) => sum + item.num, 0)} 本`
      : "";

    // 只在确实有没算进去的导本时才提示
    const notes = [];
    if (conditional.length) notes.push(`${conditional.length} 个带条件的导本未计入上限参考`);
    if (unknownProgress.length) notes.push(`${unknownProgress.length} 个成长型导本读不到当前值`);
    $("damage-mods-note").hidden = !notes.length;
    $("damage-mods-note").textContent = notes.join("；");
  }

  // ———————————————— 导本速查 ————————————————

  function saveHiddenQuickRef() {
    try {
      localStorage.setItem(QUICKREF_HIDDEN_STORAGE_KEY, JSON.stringify(hiddenQuickRef));
    } catch {
      // 存不下时本次会话内仍然生效。
    }
  }

  function dismissQuickRef(statusId) {
    hiddenQuickRef = hideQuickRefItem(hiddenQuickRef, statusId);
    saveHiddenQuickRef();
    renderQuickRef();
  }

  /** 不可重复导本：一个缩写方块，持有就亮 */
  function quickRefTile(item) {
    const li = el("li", `quickref-tile${item.num > 0 ? " is-held" : ""}${item.rarity === 3 ? " is-gold" : ""}`);
    li.draggable = true;
    li.tabIndex = 0;
    li.dataset.statusId = String(item.statusId);
    li.textContent = item.short;
    li.title = `${item.name}\n${item.num > 0 ? "已持有" : "未持有"}${item.rarity === 3 ? " · 金" : ""}`;
    li.setAttribute("aria-label", `${item.name}：${item.num > 0 ? "已持有" : "未持有"}`);
    return li;
  }

  function quickRefItem(item) {
    const li = el("li", `quickref-item${item.num > 0 ? " is-held" : ""}`);
    li.draggable = true;
    li.dataset.statusId = String(item.statusId);
    li.title = item.name;
    li.append(el("span", "quickref-name", item.name));
    if (item.nonStackable) li.append(el("span", "quickref-tag", "不可重复"));
    if (item.num > 0) li.append(el("span", "quickref-held", `已有${item.num > 1 ? ` ×${item.num}` : ""}`));
    const remove = el("button", "quickref-remove", "×");
    remove.type = "button";
    remove.setAttribute("aria-label", `剔除：${item.name}`);
    remove.title = "剔除，不再显示";
    li.append(remove);
    return li;
  }

  function renderQuickRef() {
    const ref = buildQuickRef(guidebooks, hiddenQuickRef);
    const heldCount = (items) => items.filter((item) => item.num > 0).length;

    // debuff：仿 Tarou，红色光晕逐条列出当前持有的
    const cursed = $("quickref-cursed");
    cursed.replaceChildren();
    for (const item of ref.cursed) {
      const li = el("li", "quickref-cursed-item", item.name);
      if (item.num > 1) li.append(el("span", "quickref-held", `×${item.num}`));
      cursed.append(li);
    }
    $("quickref-cursed-wrap").hidden = !ref.cursed.length;

    $("quickref-empty").hidden = ref.tiles.length > 0 || ref.hiddenCount > 0;
    $("quickref-tiles").replaceChildren(...ref.tiles.map(quickRefTile));
    $("quickref-tiles-count").textContent = ref.tiles.length
      ? `${heldCount(ref.tiles)} / ${ref.tiles.length}`
      : "";

    const gold = $("quickref-gold");
    gold.replaceChildren(...ref.gold.map(quickRefItem));
    if (!ref.gold.length) gold.append(el("li", "quickref-none", "没有要显示的金导本"));
    $("quickref-gold-count").textContent = ref.gold.length
      ? `${heldCount(ref.gold)} / ${ref.gold.length}`
      : "";

    // 恢复入口在设置页
    $("btn-quickref-restore").disabled = ref.hiddenCount === 0;
    $("quickref-hidden-text").textContent = ref.hiddenCount
      ? `已剔除 ${ref.hiddenCount} 个导本，速查里不再显示。`
      : "没有被剔除的导本。";
  }

  // 方块和金导本列表共用一套「拖出面板就剔除」
  for (const list of [$("quickref-tiles"), $("quickref-gold")]) {
    const card = list.closest(".quickref-card");
    list.addEventListener("click", (event) => {
      const button = event.target.closest?.(".quickref-remove");
      if (button) dismissQuickRef(button.closest("li").dataset.statusId);
    });
    list.addEventListener("keydown", (event) => {
      // 键盘上的等价操作：选中方块后按 Delete
      const item = event.target.closest?.("[data-status-id]");
      if (item && (event.key === "Delete" || event.key === "Backspace")) {
        event.preventDefault();
        dismissQuickRef(item.dataset.statusId);
      }
    });
    list.addEventListener("dragstart", (event) => {
      const item = event.target.closest?.("[data-status-id]");
      if (!item) return;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", item.dataset.statusId);
      item.classList.add("is-dragging");
    });
    list.addEventListener("dragend", (event) => {
      const item = event.target.closest?.("[data-status-id]");
      if (!item) return;
      item.classList.remove("is-dragging");
      // 拖到面板外面才算剔除，在面板里松手当作误触
      const rect = card.getBoundingClientRect();
      const inside =
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom;
      if (!inside) dismissQuickRef(item.dataset.statusId);
    });
  }
  $("btn-quickref-restore").addEventListener("click", () => {
    hiddenQuickRef = [];
    saveHiddenQuickRef();
    renderQuickRef();
  });

  $("btn-record-reset").addEventListener("click", () => {
    chrome.runtime
      .sendMessage({ type: MSG.RESET_BATTLE_RECORD })
      .then((response) => {
        if (response?.ok) setBattle(response.battle);
      })
      .catch(() => {});
  });

  function setDeck(next) {
    deckState = next || null;
    renderDeck();
    renderEstimate();
  }

  function setBattle(next) {
    battle = next || null;
    renderDamage();
  }

  /** 设置页里的敌人记录表：按类别分组，组内按等级从低到高 */
  function renderEnemyLog() {
    const groups = groupEnemiesByCategory(listEnemies(enemyLog));
    $("enemy-log-empty").hidden = groups.length > 0;
    $("enemy-log-table").hidden = !groups.length;
    const body = $("enemy-log-rows");
    body.replaceChildren();
    for (const group of groups) {
      const groupRow = document.createElement("tr");
      groupRow.className = "enemy-log-group";
      const oneTurn = group.enemies.filter((entry) => entry.oneTurnKills > 0);
      const top = oneTurn.sort((x, y) => (y.hpMax || 0) - (x.hpMax || 0))[0];
      const groupHead = el(
        "th",
        "",
        `${group.name}（${group.enemies.length}）` +
          (top ? ` · 一回合打死过最高 Lv${top.lv || "?"}（${formatCompact(top.hpMax)}）` : ""),
      );
      if (top) groupHead.title = `Lv${top.lv || "?"} ${top.name}：${formatNumber(top.hpMax)}`;
      groupHead.colSpan = 4;
      groupHead.scope = "colgroup";
      groupRow.append(groupHead);
      body.append(groupRow);

      for (const entry of group.enemies) {
        const tr = document.createElement("tr");
        if (entry.oneTurnKills > 0) tr.className = "is-one-turn";
        const head = el("th", "", `${entry.lv ? `Lv${entry.lv} ` : ""}${entry.name}`);
        head.scope = "row";
        const best =
          entry.oneTurnKills > 0
            ? `1 回合${entry.oneTurnKills > 1 ? ` ×${entry.oneTurnKills}` : ""}`
            : entry.bestTurns
              ? `${entry.bestTurns} 回合`
              : "未击杀";
        tr.append(
          head,
          entry.hpMax ? numberEl("td", "", entry.hpMax) : el("td", "", "—"),
          el("td", "", `${entry.seen} 次`),
          el("td", entry.oneTurnKills > 0 ? "is-one-turn-cell" : "", best),
        );
        body.append(tr);
      }
    }
  }

  function setEnemies(next) {
    enemyLog = next || null;
    renderEnemyLog();
    renderEnemies();
  }

  function setParty(next) {
    party = next || null;
    renderParty();
  }

  function setGuidebooks(next) {
    guidebooks = next || null;
    renderDamage();
    renderQuickRef();
  }

  function setOmens(next) {
    omenLog = next || null;
    renderOmenLog();
    renderOmenAlert();
  }

  renderDeck();
  renderDamage();
  renderQuickRef();
  renderOmenLog();
  renderEnemyLog();

  return { setDeck, setBattle, setGuidebooks, setOmens, setParty, setEnemies };
}
