// 文案纪律扫描的配置示例。
// 复制为 copy-discipline.config.cjs 后改成自己的。
//
// 三件事要做：
//   1. 在 collect() 里返回待检查的条目
//   2. 按需覆盖内置规则（checks）
//   3. 按需加跨字段规则（crossChecks）或完全自定义规则（extraCheck）

module.exports = {
  // ── 1. 收集待检查的内容 ─────────────────────────────────────
  // 返回 [{ group, name, fields: { 字段名: 文本 } }]
  //
  // 这里可以直接 require 你自己的数据模块。
  // 如果项目用 TypeScript，需要先把它复制到临时目录并补齐相对导入的扩展名
  // （因为 Node 默认不认 .ts），或者用 ts-node / Node 23+ 直接加载。
  collect() {
    // 示例：从本地数据模块读取
    // const { ITEMS, TEMPLATES } = require('../src/data/content.js')

    const rows = []

    // for (const it of ITEMS) {
    //   rows.push({
    //     group: '预置内容',
    //     name: it.name,
    //     fields: {
    //       // 字段名可以随意取，会出现在报错信息里
    //       title: it.title,
    //       quick: it.guide?.quick?.site,
    //       pro: it.guide?.pro?.frame,
    //     },
    //   })
    // }

    return rows
  },

  // ── 2. 内置规则（按需覆盖或开关）─────────────────────────────
  // 可用：jargon / emptyTalk / madeUpDistance / anchor / maxLength / minLength
  checks: {
    // 开启"方位必须含可数锚点"（对手写内容建议开，对 AI 生成内容建议开）
    // anchor: { on: true, fields: ['site', 'position'] },

    // 开启长度限制
    // maxLength: { on: true, limit: 80 },
    // minLength: { on: true, limit: 15 },

    // 覆盖术语词表（换成你所在领域的）
    // jargon: {
    //   on: true,
    //   pattern: /你的|领域|术语/,
    //   message: '出现目标用户可能看不懂的专业术语',
    // },
  },

  // ── 3. 跨字段规则：禁止撞句 ─────────────────────────────────
  // 同一句话出现在两个本应不同的版本里 = 其中一个版本是废的
  crossChecks: [
    // {
    //   fields: ['quick', 'pro'],
    //   message: '快速版与专业版内容重复（其中一个等于没写）',
    // },
  ],

  // ── 4. 完全自定义规则（可选）───────────────────────────────
  // 返回问题字符串数组。适合做正则表达不了的检查。
  // extraCheck(item) {
  //   const out = []
  //   if (item.fields.title && !item.fields.title.includes('·')) {
  //     out.push('标题缺少分隔符')
  //   }
  //   return out
  // },
}
