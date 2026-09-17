#!/usr/bin/env node
// 小程序页面静态校验：事件绑定与处理器是否对得上。
//
// 用法：
//   node tools/verify-miniprogram.cjs                 # 自动探测 miniprogram/ 或 src/
//   node tools/verify-miniprogram.cjs --root ./src    # 指定小程序根目录
//   node tools/verify-miniprogram.cjs --root ./src --silent   # 只输出问题
//
// 检查项：
//   1. 结构文件里 bind*/catch* 引用的处理器，在对应脚本中都有定义（支持 async 前缀与动态绑定）
//   2. 脚本中定义的页面方法，是否有从未被结构文件或 this. 引用的死代码
//   3. 配置里注册的页面，四件套（脚本/结构/样式/配置）是否齐备
//
// 为什么需要它：
//   小程序里"绑定了不存在的处理函数"通常不报错，只是点了没反应。
//   删函数忘删绑定、改函数名漏改一处 —— 这类问题靠肉眼极难发现。
//
// 无依赖，只用 Node 内置模块。发现问题退出码为 1，可直接接入 CI。

const fs = require('fs');
const path = require('path');

// ---------- 参数 ----------
const argv = process.argv.slice(2);
function argOf(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
const SILENT = argv.includes('--silent');

/** 自动探测小程序根目录 */
function detectRoot() {
  const explicit = argOf('--root', null);
  if (explicit) return path.resolve(process.cwd(), explicit);
  for (const candidate of ['miniprogram', 'src', 'app', '.']) {
    const p = path.resolve(process.cwd(), candidate);
    if (fs.existsSync(path.join(p, 'app.json'))) return p;
  }
  return null;
}

const MP = detectRoot();
if (!MP) {
  console.error('❌ 找不到小程序根目录（未发现 app.json）。请用 --root <目录> 指定。');
  process.exit(1);
}
const ROOT = path.dirname(MP);

// ---------- 常量 ----------
// 生命周期与框架钩子：不算"死代码"
const LIFECYCLE = [
  'onLoad', 'onShow', 'onHide', 'onUnload', 'onReady', 'onPullDownRefresh',
  'onReachBottom', 'onShareAppMessage', 'onShareTimeline', 'onPageScroll',
  'onResize', 'onTabItemTap', 'onAddToFavorites', 'onSaveExitState',
  // 组件生命周期
  'attached', 'detached', 'created', 'moved', 'ready', 'error',
  'lifetimes', 'pageLifetimes', 'observers', 'methods',
];

// 方法名按行锚定后，需要排除的 JS 关键字与框架工厂函数
const NOT_A_METHOD = [
  'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'else', 'do', 'try',
  'Page', 'Component', 'App', 'Behavior', 'require', 'module', 'exports',
  'describe', 'it', 'test', 'expect', 'beforeEach', 'afterEach',
];

// ---------- 解析工具 ----------

/**
 * 从一段绑定属性值里取出处理器名。
 * 必须同时支持两种写法，否则会漏判：
 *   静态：bindtap="onTab"
 *   动态：catchtouchmove="{{dragging ? 'onGridTouchMove' : ''}}"
 */
function handlerNamesFrom(value) {
  const names = new Set();
  const bare = value.trim();
  if (/^[A-Za-z_$][\w$]*$/.test(bare)) names.add(bare);
  for (const m of value.matchAll(/'([A-Za-z_$][\w$]*)'/g)) names.add(m[1]);
  for (const m of value.matchAll(/"([A-Za-z_$][\w$]*)"/g)) names.add(m[1]);
  return [...names];
}

/**
 * 提取对象字面量里的方法名。
 *
 * 必须按行锚定：方法名独占行首（允许缩进与 async 前缀）。
 * 若用宽松的正则跨行匹配，`Page(` 之后的 `[^)]*` 会吞掉后面某个方法的签名，
 * 导致该方法被漏掉 —— 这会制造大量假阳性。
 */
function extractMethods(src) {
  const re = /^[ \t]*(?:async[ \t]+)?([A-Za-z_$][\w$]*)[ \t]*\([^)\n]*\)[ \t]*\{/gm;
  const out = new Set();
  for (const m of src.matchAll(re)) {
    if (!NOT_A_METHOD.includes(m[1])) out.add(m[1]);
  }
  return [...out];
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      walk(p, out);
    } else out.push(p);
  }
  return out;
}

// ---------- 执行 ----------
const problems = [];
const notes = [];

// 1 & 2：逐页交叉校验
const wxmls = walk(MP).filter((f) => f.endsWith('.wxml'));
let checkedPages = 0;

for (const wxmlPath of wxmls) {
  const tsPath = wxmlPath.replace(/\.wxml$/, '.ts');
  const jsPath = wxmlPath.replace(/\.wxml$/, '.js');
  const scriptPath = fs.existsSync(tsPath) ? tsPath : (fs.existsSync(jsPath) ? jsPath : null);
  if (!scriptPath) continue;

  checkedPages++;
  const wxml = fs.readFileSync(wxmlPath, 'utf8');
  const script = fs.readFileSync(scriptPath, 'utf8');
  const rel = path.relative(ROOT, wxmlPath);

  const handlers = [...new Set(
    [...wxml.matchAll(/(?:bind|catch)[a-zA-Z:]*\s*=\s*"([^"]*)"/g)]
      .flatMap((m) => handlerNamesFrom(m[1]))
  )];
  const defined = extractMethods(script);

  const missing = handlers.filter((h) => !defined.includes(h));
  if (missing.length) {
    problems.push(`${rel} 引用了不存在的处理器: ${missing.join(', ')}`);
  }

  const unused = defined.filter((d) => {
    if (LIFECYCLE.includes(d)) return false;
    if (handlers.includes(d)) return false;
    return !new RegExp(`this\\.${d}\\s*\\(`).test(script);
  });
  if (unused.length) {
    notes.push(`${rel} 疑似死代码（既无绑定也无 this. 调用）: ${unused.join(', ')}`);
  }
}

// 3：页面注册
const appJsonPath = path.join(MP, 'app.json');
let registered = 0;
if (fs.existsSync(appJsonPath)) {
  let appJson;
  try {
    appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
  } catch (e) {
    problems.push(`app.json 解析失败: ${e.message}`);
    appJson = null;
  }
  if (appJson && Array.isArray(appJson.pages)) {
    registered = appJson.pages.length;
    for (const p of appJson.pages) {
      for (const ext of ['ts', 'js', 'wxml', 'wxss', 'json']) {
        // 脚本与样式允许二选一（ts/js、wxss 可为空），但 wxml 与 json 必须存在
        if (ext === 'js' || ext === 'wxss') continue;
        if (ext === 'ts' && fs.existsSync(path.join(MP, `${p}.js`))) continue;
        if (!fs.existsSync(path.join(MP, `${p}.${ext}`))) {
          problems.push(`app.json 注册的 ${p} 缺少 .${ext}`);
        }
      }
    }
  }
} else {
  problems.push(`未找到 ${path.relative(ROOT, appJsonPath)}`);
}

// ---------- 输出 ----------
if (!SILENT) {
  console.log(`扫描 ${checkedPages} 个有脚本的页面，配置注册 ${registered} 个页面`);
}

if (notes.length && !SILENT) {
  console.log('\n提示（不阻断）：');
  notes.forEach((n) => console.log('  · ' + n));
}

if (problems.length) {
  console.log('\n❌ 问题：');
  problems.forEach((p) => console.log('  · ' + p));
  process.exit(1);
}

if (!SILENT) console.log('\n✅ 事件绑定、处理器定义、页面注册全部一致');
