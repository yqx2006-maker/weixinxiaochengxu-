#!/usr/bin/env node
// 文案纪律批量自检：把"哪一条内容不合格"逐条打印出来。
//
// 用法：
//   node tools/check-copy-discipline.cjs                       # 用同目录的配置文件
//   node tools/check-copy-discipline.cjs --config my.cjs       # 指定配置
//
// ── 为什么需要它 ────────────────────────────────────────────────
//   面向用户的文案（尤其是 AI 生成或批量铺开的）会漂移：
//   这次编了距离、下次用了专业术语、再下次两个版本写成同一句话。
//   人工审 200 条内容不现实，而且改一次就要重审。
//
// ── 与断言式测试的关键区别 ──────────────────────────────────────
//   断言式测试在第一条失败时就停了，你只能一条一条改；
//   这个脚本【逐条打印、不中断】，一次列出全部问题 ——
//   铺开改大量文案时，效率差好几倍。
//
// 配置文件格式见同目录的 copy-discipline.config.example.cjs
// 无依赖，只用 Node 内置模块。有不合格项时退出码为 1。

const path = require('path');

// ---------- 参数 ----------
const argv = process.argv.slice(2);
function argOf(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const configPath = path.resolve(
  process.cwd(),
  argOf('--config', path.join(__dirname, 'copy-discipline.config.cjs')),
);

let config;
try {
  config = require(configPath);
} catch (e) {
  console.error(`❌ 无法加载配置：${configPath}`);
  console.error(`   ${e.message}`);
  console.error('   提示：从 copy-discipline.config.example.cjs 复制一份改成自己的。');
  process.exit(1);
}

if (typeof config.collect !== 'function') {
  console.error('❌ 配置缺少 collect()：它应返回待检查的条目数组。');
  process.exit(1);
}

// ---------- 内置规则 ----------
// 每一条都对应一次真实的翻车。默认值偏保守，按需在配置里覆盖。
const DEFAULTS = {
  // 目标用户看不懂的专业术语。用词表而不是"智能识别"，因为规则必须可解释。
  jargon: {
    on: true,
    pattern: /三分线|引导线|测光|曝光|构图|焦段|光圈|快门速度|ISO|白平衡|虚化|散射光|顺光|逆光/i,
    message: '出现目标用户可能看不懂的专业术语',
  },

  // 放到任何场景都成立的句子 —— 看起来写了，其实什么都没说
  emptyTalk: {
    on: true,
    pattern: /随心所欲|随便走走|怎么舒服怎么来|看感觉|随便拍拍|依个人喜好/,
    message: '空话（换个地点也成立，等于没说）',
  },

  // 【重要】编造的距离/序号
  // 批量生成的场景往往"不知道具体是哪儿"，编数字等于教用户走错路
  madeUpDistance: {
    on: true,
    pattern: /[0-9０-９一二三四五六七八九十百]+(?:多)?米|第\s*[0-9０-９一二三四五六七八九十]+\s*(?:棵|根|级台阶)/,
    message: '编造距离或序号（现场无法验证）',
  },

  // 方位必须含"可数锚点"，否则用户站在现场无法定位
  // 「堤边」这类方位站哪儿都成立 —— 读起来像指导，实际无法执行
  anchor: {
    on: false, // 只在需要时开启（对"方位类"字段生效）
    pattern: /口|入口|出口|门|桥|椅|栏|阶|牌坊|碑|亭|站|路口|转角|广场|码头|售票|检票|正门|南侧|北侧|东侧|西侧|对面|尽头|中段|门口|台|墙/,
    message: '方位缺少可数锚点（无法在现场定位）',
    fields: ['site', 'position', 'location'], // 仅对这些字段名生效
  },

  // 长度：冗长通常意味着没想清楚
  maxLength: {
    on: false,
    limit: 60,
    message: '超过长度上限（冗长通常意味着没想清楚）',
  },

  minLength: {
    on: false,
    limit: 20,
    message: '过短（可能没有实际信息量）',
  },
};

const checks = { ...DEFAULTS, ...(config.checks || {}) };

// ---------- 执行 ----------
const items = config.collect() || [];
const rows = [];

for (const item of items) {
  const problems = [];
  const fields = item.fields || {};

  for (const [fieldName, rawText] of Object.entries(fields)) {
    const text = typeof rawText === 'string' ? rawText : (rawText == null ? '' : String(rawText));

    if (!text.trim()) {
      problems.push(`字段「${fieldName}」为空`);
      continue;
    }

    // 术语 / 空话 / 编造数字：任何字段都查
    for (const key of ['jargon', 'emptyTalk', 'madeUpDistance']) {
      const rule = checks[key];
      if (rule && rule.on && rule.pattern.test(text)) {
        problems.push(`[${fieldName}] ${rule.message}：${text.slice(0, 40)}${text.length > 40 ? '…' : ''}`);
      }
    }

    // 锚点：只对规则指定的字段名生效（通常是"方位/位置"类字段）
    const anchor = checks.anchor;
    if (anchor && anchor.on) {
      const applies = !anchor.fields || anchor.fields.includes(fieldName);
      if (applies && !anchor.pattern.test(text)) {
        problems.push(`[${fieldName}] ${anchor.message}：${text}`);
      }
    }

    // 长度
    if (checks.maxLength && checks.maxLength.on && text.length > checks.maxLength.limit) {
      problems.push(`[${fieldName}] ${checks.maxLength.message}（${text.length} > ${checks.maxLength.limit}）：${text}`);
    }
    if (checks.minLength && checks.minLength.on && text.length < checks.minLength.limit) {
      problems.push(`[${fieldName}] ${checks.minLength.message}（${text.length} < ${checks.minLength.limit}）：${text}`);
    }
  }

  // 跨字段规则：撞句
  // 同一句话出现在两个本应不同的版本里 = 其中一个版本是废的
  for (const cross of config.crossChecks || []) {
    const picked = (cross.fields || []).map((f) => fields[f]).filter((t) => typeof t === 'string' && t.trim());
    const seen = new Map();
    for (const t of picked) {
      if (seen.has(t)) {
        problems.push(cross.message || `字段「${seen.get(t)}」与「${t.slice(0, 20)}」内容重复`);
        break;
      }
      seen.set(t, cross.fields[picked.indexOf(t)]);
    }
  }

  // 完全自定义的规则
  if (typeof config.extraCheck === 'function') {
    const extra = config.extraCheck(item);
    if (Array.isArray(extra)) problems.push(...extra);
  }

  rows.push({ group: item.group || '未分组', name: item.name || '(未命名)', problems });
}

// ---------- 输出 ----------
const bad = rows.filter((r) => r.problems.length);

console.log(`检查 ${rows.length} 条内容，不合格 ${bad.length} 条\n`);

for (const r of bad) {
  console.log(`✖ [${r.group}] ${r.name}`);
  for (const p of r.problems) console.log(`    · ${p}`);
}

if (!bad.length) console.log('全部合格');

process.exitCode = bad.length ? 1 : 0;
