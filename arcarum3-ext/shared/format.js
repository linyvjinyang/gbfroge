/**
 * 数字的紧凑写法：用「万 / 亿」做单位，放得进窄格子。
 * 详细数值另外放在悬浮提示里，所以这里宁可少一位也不要被截断。
 *
 *   9,412,345      → 941万
 *   35,400         → 3.5万
 *   14,203,998     → 1420万
 *   142,039,980    → 1.42亿
 *   2,500,000,000  → 25亿
 */
export function formatCompact(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  const sign = number < 0 ? "-" : "";
  const abs = Math.abs(number);
  if (abs < 10000) return `${sign}${Math.round(abs)}`;
  if (abs < 99995000) {
    const wan = abs / 10000;
    // 不到 100 万留一位小数，再大就取整
    return `${sign}${wan < 100 ? trim(wan.toFixed(1)) : Math.round(wan)}万`;
  }
  const yi = abs / 100000000;
  return `${sign}${yi < 100 ? trim(yi.toFixed(2)) : Math.round(yi)}亿`;
}

/** 去掉小数末尾多余的 0：「3.0」→「3」、「1.40」→「1.4」 */
function trim(text) {
  return text.includes(".") ? text.replace(/\.?0+$/, "") : text;
}
