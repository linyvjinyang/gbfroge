import assert from "node:assert/strict";
import {
  CAPTURE_LOG_LIMIT,
  CAPTURE_LOG_MAX_CHARS,
  appendCapture,
  createCaptureLog,
  exportCaptureLog,
  scrubRequestBody,
  scrubUrl,
  scrubValue,
  shouldLogCapture,
} from "./shared/captureLog.js";

// 只记肉鸽接口
assert.equal(shouldLogCapture("https://game.granbluefantasy.jp/rest/arcarum3/dungeon/move_node"), true);
assert.equal(shouldLogCapture("https://game.granbluefantasy.jp/arcarum3/dungeon/content/book_index"), true);
assert.equal(shouldLogCapture("https://game.granbluefantasy.jp/rest/raid/start.json"), false);
assert.equal(shouldLogCapture("https://game.granbluefantasy.jp/party/deck/1/1"), false);
assert.equal(shouldLogCapture(null), false);

// 地址：去掉时间戳和用户 ID，保留有意义的参数
assert.equal(
  scrubUrl("https://game.granbluefantasy.jp/rest/arcarum3/dungeon/spacebook_status_list?filter_type=4&_=1791705159127&t=1791705159481&uid=12345678"),
  "/rest/arcarum3/dungeon/spacebook_status_list?filter_type=4",
);
assert.equal(scrubUrl("/arcarum3/dungeon/content/index/0?_=1&t=2&uid=3"), "/arcarum3/dungeon/content/index/0");
assert.equal(scrubUrl("https://game.granbluefantasy.jp/rest/arcarum3/dungeon/move_node"), "/rest/arcarum3/dungeon/move_node");

// 内容：隐去个人字段、丢掉界面文案和页面外壳、截断超长字符串
{
  const scrubbed = scrubValue({
    data: "%3Cdiv%20id%3D%22root%22%3E%3C%2Fdiv%3E",
    option: {
      langMsg: { a: { msgid: "a", msg: "x" } },
      bgm: "364.mp3",
      nickname: "某玩家",
    },
    display_list: { "9_10": { id: 1, user_id: "12345678", name: "真理の土" } },
    status_list: [{ status_id: 7, name: "ダメージ上限UP(10%)", num: 1 }],
    special_token: "abc",
    long: "x".repeat(5000),
  });
  assert.match(scrubbed.data, /^\[页面外壳，\d+ 字\]$/);
  assert.equal("langMsg" in scrubbed.option, false);
  assert.equal(scrubbed.option.bgm, "364.mp3");
  assert.equal(scrubbed.option.nickname, "[已隐去]");
  assert.equal(scrubbed.display_list["9_10"].user_id, "[已隐去]");
  assert.equal(scrubbed.display_list["9_10"].name, "真理の土");
  assert.deepEqual(scrubbed.status_list, [{ status_id: 7, name: "ダメージ上限UP(10%)", num: 1 }], "导本数据原样保留");
  assert.equal(scrubbed.special_token, "[已隐去]");
  assert.ok(scrubbed.long.length < 2100 && scrubbed.long.endsWith("[共 5000 字]"));
  assert.equal(JSON.stringify(scrubbed).includes("12345678"), false);
}

// 请求内容：JSON、表单、纯文本
assert.deepEqual(scrubRequestBody(JSON.stringify({ status_ids: [10], uid: 1, special_token: null })), {
  status_ids: [10],
  uid: "[已隐去]",
  special_token: null,
});
assert.deepEqual(scrubRequestBody("status_ids[]=7&status_ids[]=10&uid=99"), {
  "status_ids[]": ["7", "10"],
  uid: "[已隐去]",
});
assert.deepEqual(scrubRequestBody({ node_id: 3 }), { node_id: 3 });
assert.equal(scrubRequestBody("just text"), "just text");
assert.equal(scrubRequestBody(null), null);
assert.equal(scrubRequestBody(""), null);

// 追加：不改动原对象，按时间顺序，条数封顶
{
  const empty = createCaptureLog();
  const one = appendCapture(empty, {
    url: "https://game.granbluefantasy.jp/rest/arcarum3/dungeon/move_node?_=1&uid=12345678",
    method: "post",
    requestBody: JSON.stringify({ node_id: 3 }),
    body: JSON.stringify({ after_current_node_id: 3 }),
  }, 1000);
  assert.deepEqual(empty.entries, []);
  assert.deepEqual(one.entries, [{
    at: 1000,
    time: "1970-01-01T00:00:01.000Z",
    method: "POST",
    url: "/rest/arcarum3/dungeon/move_node",
    request: { node_id: 3 },
    response: { after_current_node_id: 3 },
  }]);

  let log = one;
  for (let index = 0; index < CAPTURE_LOG_LIMIT + 5; index++) {
    log = appendCapture(log, { url: `/rest/arcarum3/dungeon/x${index}`, body: {} }, 2000 + index);
  }
  assert.equal(log.entries.length, CAPTURE_LOG_LIMIT);
  assert.equal(log.entries.at(-1).url, `/rest/arcarum3/dungeon/x${CAPTURE_LOG_LIMIT + 4}`);
  assert.equal(log.entries.at(-1).method, "GET");
}

// 太大的响应只留摘要；总量超了丢最早的
{
  const huge = { node_list: Array.from({ length: 30000 }, (_, id) => ({ node_id: id, position_x: id, position_y: id })) };
  const log = appendCapture(createCaptureLog(), { url: "/arcarum3/dungeon/content/index/0", body: huge }, 1);
  assert.deepEqual(log.entries[0].response.keys, ["node_list"]);
  assert.ok(JSON.stringify(log).length < 1000);

  const medium = { text: Array.from({ length: 150 }, () => "y".repeat(1900)) };
  let big = createCaptureLog();
  for (let index = 0; index < 20; index++) {
    big = appendCapture(big, { url: `/rest/arcarum3/dungeon/big${index}`, body: medium }, index);
  }
  assert.ok(JSON.stringify(big).length <= CAPTURE_LOG_MAX_CHARS + 1000, "总大小封顶");
  assert.ok(big.entries.length < 20 && big.entries.length >= 1);
  assert.equal(big.entries.at(-1).url, "/rest/arcarum3/dungeon/big19", "最新的一定留着");
}

// 不是 JSON 的响应也不报错
assert.equal(appendCapture(createCaptureLog(), { url: "/arcarum3/x", body: "<html>" }, 1).entries[0].response, "<html>");

// 导出
{
  const log = appendCapture(createCaptureLog(), { url: "/rest/arcarum3/dungeon/a", body: {} }, 5);
  const exported = exportCaptureLog(log, { version: "1.2.3", now: 10 });
  assert.equal(exported.count, 1);
  assert.equal(exported.version, "1.2.3");
  assert.equal(exported.entries, log.entries);
  assert.equal(exportCaptureLog(null).count, 0);
}

console.log("capture log tests passed");
