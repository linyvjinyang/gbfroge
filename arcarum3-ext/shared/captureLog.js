/**
 * 排查用的抓包记录：把最近若干条肉鸽接口的原始请求 / 响应记下来，方便事后导出看「游戏到底发了什么」。
 * 只在本机内存里保留（浏览器关掉就没了），导出前会隐去用户 ID、昵称这类字段。
 */

/** 最多保留多少条 */
export const CAPTURE_LOG_LIMIT = 60;
/** 整份记录的大小上限（字符数），超了从最早的开始丢 */
export const CAPTURE_LOG_MAX_CHARS = 3_000_000;
/** 单条响应的大小上限，超了只留摘要 */
const ENTRY_MAX_CHARS = 400_000;
/** 单个字符串的长度上限 */
const STRING_MAX_CHARS = 2_000;
const REDACTED = "[已隐去]";
const REDACT_KEYS = /^(?:user_?id|uid|viewer_?id|nickname|user_?name|token|special_token|csrf.*)$/i;
/** 页面外壳和整包的界面文案：占地方又没有信息量 */
const DROP_KEYS = new Set(["langMsg"]);

export function createCaptureLog() {
  return { entries: [] };
}

/** 只记肉鸽的接口 */
export function shouldLogCapture(url) {
  return typeof url === "string" && /\/arcarum3\//i.test(url);
}

/** 地址只留路径和有意义的参数：去掉时间戳和用户 ID */
export function scrubUrl(url) {
  try {
    const parsed = new URL(url, "https://game.granbluefantasy.jp");
    for (const key of ["_", "t", "uid"]) parsed.searchParams.delete(key);
    const query = parsed.searchParams.toString();
    return parsed.pathname + (query ? `?${query}` : "");
  } catch {
    return String(url || "").replace(/([?&])(?:_|t|uid)=[^&#]*/g, "$1").replace(/[?&]+$/, "");
  }
}

/** 深拷贝一份，隐去个人字段、丢掉界面文案、截断超长字符串 */
export function scrubValue(value, key = "") {
  if (value == null) return value;
  if (key && REDACT_KEYS.test(key)) return REDACTED;
  if (typeof value === "string") {
    // 页面外壳是一大段转义过的 HTML
    if (key === "data" && /^(?:%3C|<)/i.test(value)) return `[页面外壳，${value.length} 字]`;
    return value.length > STRING_MAX_CHARS
      ? `${value.slice(0, STRING_MAX_CHARS)}…[共 ${value.length} 字]`
      : value;
  }
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, key));
  const result = {};
  for (const [childKey, child] of Object.entries(value)) {
    if (DROP_KEYS.has(childKey)) continue;
    result[childKey] = scrubValue(child, childKey);
  }
  return result;
}

/** 请求内容：JSON / 表单都解析出来再隐去个人字段；解析不了就原样截断 */
export function scrubRequestBody(requestBody) {
  if (requestBody == null || requestBody === "") return null;
  if (typeof requestBody === "object") return scrubValue(requestBody);
  const text = String(requestBody);
  try {
    return scrubValue(JSON.parse(text));
  } catch {
    try {
      const params = new URLSearchParams(text);
      const keys = [...params.keys()];
      if (keys.length && !(keys.length === 1 && params.get(keys[0]) === "" && !text.includes("="))) {
        const result = {};
        for (const key of new Set(keys)) {
          const values = params.getAll(key);
          result[key] = scrubValue(values.length > 1 ? values : values[0], key);
        }
        return result;
      }
    } catch {
      /* 落到下面按纯文本处理 */
    }
    return scrubValue(text);
  }
}

function parseBody(body) {
  if (typeof body !== "string") return body;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

/**
 * 追加一条记录，返回新的记录对象（不改动传入的）。
 * @param {{ url: string, method?: string, requestBody?: any, body?: any }} capture
 */
export function appendCapture(log, capture, now = Date.now()) {
  const previous = Array.isArray(log?.entries) ? log.entries : [];
  let response = scrubValue(parseBody(capture.body));
  const size = JSON.stringify(response ?? null).length;
  if (size > ENTRY_MAX_CHARS) {
    response = {
      "[响应太大，只留摘要]": size,
      keys: response && typeof response === "object" ? Object.keys(response).slice(0, 40) : [],
    };
  }
  const entry = {
    at: now,
    time: new Date(now).toISOString(),
    method: String(capture.method || "GET").toUpperCase(),
    url: scrubUrl(capture.url),
    request: scrubRequestBody(capture.requestBody),
    response,
  };
  const entries = [...previous, entry].slice(-CAPTURE_LOG_LIMIT);
  // 总大小超了就从最早的开始丢，至少留下刚加的这一条
  let total = entries.reduce((sum, item) => sum + JSON.stringify(item).length, 0);
  while (entries.length > 1 && total > CAPTURE_LOG_MAX_CHARS) {
    total -= JSON.stringify(entries.shift()).length;
  }
  return { entries };
}

/** 导出文件的内容 */
export function exportCaptureLog(log, { version = "", now = Date.now() } = {}) {
  const entries = Array.isArray(log?.entries) ? log.entries : [];
  return {
    tool: "gbfroge",
    version,
    exportedAt: new Date(now).toISOString(),
    note: "排查用抓包记录。已隐去用户 ID / 昵称等字段，但仍是你的游戏数据，不要公开发布。",
    count: entries.length,
    entries,
  };
}
