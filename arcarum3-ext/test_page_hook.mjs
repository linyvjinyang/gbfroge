import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(
  new URL("./content/page-hook.js", import.meta.url),
  "utf8",
);

let poll = null;
let ajaxSuccessHandler = null;
const posted = [];
const document = {
  documentElement: { lang: "jp" },
  querySelectorAll() {
    return [];
  },
};
let commandListener = null;
const ajaxCalls = [];
const window = {
  addEventListener(type, listener) {
    if (type === "message") commandListener = listener;
  },
  fetch() {},
  XMLHttpRequest: class XMLHttpRequest {},
  postMessage(message, targetOrigin) {
    posted.push({ message, targetOrigin });
  },
};

const context = vm.createContext({
  // 页面里的时间跟测试用同一个钟
  Date,
  URL,
  document,
  location: { href: "https://game.granbluefantasy.jp/#arcarum3/book" },
  setInterval(callback) {
    poll = callback;
    return 1;
  },
  clearInterval() {},
  window,
});

vm.runInContext(source, context, { filename: "page-hook.js" });

assert.equal(typeof poll, "function", "页面 hook 应等待 GBF 的 jQuery 加载");

context.$ = context.jQuery = (target) => {
  assert.equal(target, document);
  return {
    ajaxSuccess(handler) {
      ajaxSuccessHandler = handler;
    },
  };
};
context.jQuery.ajax = (settings) => ajaxCalls.push(settings);
poll();

assert.equal(
  typeof ajaxSuccessHandler,
  "function",
  "jQuery 加载后应注册 ajaxSuccess",
);

const response = {
  status_list: [{ status_id: 101, name: "攻撃力上昇", rarity: 2, num: 1 }],
};
ajaxSuccessHandler(
  {},
  { status: 200 },
  {
    url: "/rest/arcarum3/dungeon/spacebook_status_list",
    type: "POST",
    data: "floor_id=1",
  },
  response,
);

assert.equal(posted.length, 1);
assert.deepEqual(JSON.parse(JSON.stringify(posted[0])), {
  message: {
    source: "gbfroge-hook",
    type: "api",
    url: "https://game.granbluefantasy.jp/rest/arcarum3/dungeon/spacebook_status_list",
    method: "POST",
    status: 200,
    body: response,
    requestBody: "floor_id=1",
    gameLanguage: "ja",
  },
  targetOrigin: "*",
});

ajaxSuccessHandler(
  {},
  { status: 200 },
  { url: "/socket/query?nickname=Alice", type: "GET" },
  { nickname: "Alice" },
);
assert.equal(posted.length, 2, "socket/query should be captured for the current player name");
assert.equal(posted[1].message.url, "https://game.granbluefantasy.jp/socket/query?nickname=Alice");

// —— 只听不发：页面脚本不主动发请求，也不接受外面发来的指令 ——
assert.equal(commandListener, null, "页面脚本不监听任何指令");
assert.equal(ajaxCalls.length, 0, "页面脚本不主动发请求");
assert.doesNotMatch(source.replace(/ajaxSuccess/g, ""), /\.ajax\(|fetch\(|XMLHttpRequest|sendBeacon/, "页面脚本里没有任何发请求的代码");

console.log("page hook: all assertions passed");
