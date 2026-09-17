// 云函数内存滑动窗口限流 —— 挡"绕过前端的脚本循环调用"，不追求精确计费。
//
// ⚠️ 每个云函数是独立部署单元，不能跨目录 require。
//    多个函数需要这份逻辑时，同源复制一份，并在两边文件头注明「改规则要同步」。
//
// ─────────────────────────────────────────────────────────────
// 为什么用内存而不是数据库计数（这是刻意的取舍）
// ─────────────────────────────────────────────────────────────
//   · 攻击面：云函数只有本应用的用户能调，身份由运行时注入、前端伪造不了；
//     前端通常也挡住了误触连点。要刷必须反编译改包，属于"有明确恶意的少数人"。
//   · 成本：数据库每次调用要多 1 读 1 写，而 DB 读写本身也在配额里 ——
//     用 DB 配额换业务配额，对"保护账单"这个目标未必划算。
//   · 内存层零成本、零延迟，能挡住绝大多数粗暴刷法（循环调用、快速重试）。
//
// 【已知局限，务必知晓】
//   · 多实例并发时各实例各算各的，实际上限 ≈ 阈值 × 实例数；
//   · 实例回收后计数清零。
//   真要精确计费保护，在同一个 allow() 调用点补一层 DB 计数即可，调用方不用改。
//
// 【平台侧的另一半】
//   控制台可以做"用量告警"，但注意 —— 自定义告警指标只有「错误次数」和「运行时间」，
//   没有「调用次数突增」。也就是说：【"被刷"这件事平台告警发现不了】
//   （刷子会让调用全部成功，错误数为 0）。所以函数内限流才是实际防线。
// ─────────────────────────────────────────────────────────────

/** 命中记录：`${scope}:${key}` → 时间戳数组（升序） */
const buckets = new Map();

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;

/**
 * 各 scope 的窗口规则：`[[窗口毫秒, 窗口内允许次数], ...]` —— 任一窗口超限即拒绝。
 *
 * ⚠️ 参数按「滥用危害」定，不按「调用成本」定。这是最重要的一条经验：
 *
 *    一次生图很贵（模型配额 + 存储写入），但一次垃圾评论的危害更高 ——
 *    评论直接公开可见、没有审核队列兜底，而生成失败用户只是重试一次。
 *
 * 下面的 RULES 是示例值，请按自己的业务替换 scope 名与阈值。
 */
let RULES = {
  // 单次最贵的操作
  'image:generate': [[MINUTE, 3], [DAY, 30]],

  // 向公开区域写入、有审核兜底的
  submit: [[MINUTE, 2], [DAY, 10]],

  // 向公开区域写入、【没有】审核兜底的 → 最紧
  comment: [[MINUTE, 5], [DAY, 50]],

  // 举报
  report: [[MINUTE, 5], [DAY, 20]],

  // 敏感凭据校验 → 防爆破
  claimAdmin: [[MINUTE, 5], [DAY, 20]],

  // 只读：只挡死循环式拉取。阈值放到正常人翻页绝不会碰到的高度，
  // 同时给管理员连续操作留足余量。
  default: [[MINUTE, 200]],
};

/** 清理阈值：超过这个键数就扫一遍过期记录，防止长期运行下 Map 无限增长 */
const MAX_BUCKETS = 5000;

/**
 * 全局最长窗口，用来裁掉各窗口都用不到的老记录。
 *
 * 从 RULES 动态计算，而不是写死一个常量 —— 否则 configure() 覆盖规则后
 * 这个值不会同步，超出新窗口的记录会被过早裁掉，限流静默失效。
 * （这类"两处必须保持一致"的写法是 bug 高发区，所以这里只保留一个来源。）
 */
function longestWindow() {
  const windows = Object.values(RULES).flat().filter(Array.isArray).map(([w]) => w);
  return windows.length ? Math.max(DAY, ...windows) : DAY;
}

/**
 * 覆盖规则表（可选）。
 * @param rules 形如 `{ scope: [[窗口毫秒, 次数], ...] }`
 */
function configure(rules) {
  RULES = { ...rules };
}

/**
 * 判断这次调用是否放行。
 *
 * ⚠️ 调用位置很关键：**放在业务逻辑最前面**。
 *    这样超频请求消耗不到后续的内容安全检测额度，也不产生数据库写入。
 *
 * @param scope 规则名（见 RULES）。未定义该 scope 时一律放行。
 * @param key   限流主体，用运行时注入的用户标识；没有时传 'anon'
 * @param now   可选，便于测试注入时间
 * @returns `{ ok: true }` 或 `{ ok: false, retryAfterMs }`
 */
function allow(scope, key, now = Date.now()) {
  const rules = RULES[scope];
  if (!rules) return { ok: true };

  const id = `${scope}:${key || 'anon'}`;
  const hits = (buckets.get(id) || []).filter((t) => now - t < longestWindow());

  for (const [windowMs, limit] of rules) {
    const inWindow = hits.filter((t) => now - t < windowMs);
    if (inWindow.length >= limit) {
      // 最早那次滑出窗口就能再放行一次，按它算等待时间（偏保守，但不会放太早）
      const wait = windowMs - (now - inWindow[0]);
      buckets.set(id, hits);
      return { ok: false, retryAfterMs: Math.max(wait, 1000) };
    }
  }

  hits.push(now);
  buckets.set(id, hits);
  if (buckets.size > MAX_BUCKETS) sweep(now);
  return { ok: true };
}

/** 丢掉所有窗口都用不到的老记录，键空了就一起删掉 */
function sweep(now = Date.now()) {
  for (const [id, hits] of Array.from(buckets.entries())) {
    const keep = hits.filter((t) => now - t < longestWindow());
    if (keep.length) buckets.set(id, keep);
    else buckets.delete(id);
  }
}

/** 人类可读的等待时间，用于回给客户端的提示 */
function humanWait(ms) {
  const s = Math.ceil(ms / 1000);
  return s < 60 ? `${s} 秒` : `${Math.ceil(s / 60)} 分钟`;
}

/**
 * 构造标准的 429 响应。
 * 客户端拿到后应给出"发太快了，X 后再试"这种可执行提示，
 * 并且【不要把它当成云端故障去熔断】—— 否则会把几秒的等待放大成全面不可用。
 */
function tooManyRequests(result) {
  return {
    ok: false,
    code: 429,
    error: 'TOO_MANY_REQUESTS',
    wait: humanWait(result.retryAfterMs),
    retryAfterMs: result.retryAfterMs,
  };
}

/** 测试用：清空计数（生产代码不要调用） */
function reset() {
  buckets.clear();
}

module.exports = {
  allow,
  humanWait,
  tooManyRequests,
  configure,
  sweep,
  reset,
  // 用函数取当前规则表，不要直接解构导出 RULES ——
  // 那样 configure() 之后拿到的还是旧对象（"导出快照"是另一类静默失效）
  getRules: () => RULES,
};
