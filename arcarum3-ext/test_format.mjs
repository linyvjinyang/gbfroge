import assert from "node:assert/strict";
import { formatCompact } from "./shared/format.js";

const cases = [
  [0, "0"],
  [28, "28"],
  [9999, "9999"],
  [10000, "1万"],
  [35400, "3.5万"],
  [99949, "10万"],
  [123456, "12.3万"],
  [999999, "100万"],
  [1000000, "100万"],
  [9412345, "941万"],
  [14203998, "1420万"],
  [55563174, "5556万"],
  [99994999, "9999万"],
  [99995000, "1亿"],
  [100000000, "1亿"],
  [142039980, "1.42亿"],
  [227360000, "2.27亿"],
  [2500000000, "25亿"],
  [12345678901, "123亿"],
  [-9412345, "-941万"],
];
for (const [input, expected] of cases) {
  assert.equal(formatCompact(input), expected, `${input}`);
}
assert.equal(formatCompact("9412345"), "941万", "字符串数字也认");
assert.equal(formatCompact(null), "0");
assert.equal(formatCompact(undefined), "0");
assert.equal(formatCompact("abc"), "0");

// 放进窄格子：任何伤害数字都不超过 6 个字符
for (const value of [1, 12345, 999999, 9999999, 99999999, 999999999, 9999999999, 99999999999]) {
  assert.ok([...formatCompact(value)].length <= 6, `${value} → ${formatCompact(value)}`);
}

console.log("format tests passed");
