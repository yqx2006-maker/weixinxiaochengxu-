# tools · 可复用工具

三个从真实项目里拿出来的工具，**全部去掉了业务耦合**，可以直接用到自己的项目。

| 工具 | 作用 | 依赖 |
|---|---|---|
| [`verify-miniprogram.cjs`](verify-miniprogram.cjs) | 小程序页面绑定一致性校验：结构文件里的事件绑定 ↔ 脚本里的处理函数 ↔ 页面注册 | 无 |
| [`check-copy-discipline.cjs`](check-copy-discipline.cjs) | 文案纪律扫描：逐条打印"哪条不合格"，**不中断** | 无 |
| [`cloudfunction-ratelimit.js`](cloudfunction-ratelimit.js) | 云函数内存滑动窗口限流：零 DB 成本挡住粗暴刷 | 无 |

---

## 1. verify-miniprogram.cjs

**解决什么问题**：删了一个事件处理函数但忘了删对应的绑定 / 改了函数名但漏改一处 / 在配置里注册了页面但文件不全 —— 这类问题**在小程序里往往不报错，只是点了没反应**。

```bash
node tools/verify-miniprogram.cjs                # 自动探测 miniprogram/ 目录
node tools/verify-miniprogram.cjs --root ./src   # 指定目录
```

**检查三项**：

1. 结构文件里 `bind*` / `catch*` 引用的处理函数，在对应脚本里**是否有定义**（支持 `async` 前缀与动态绑定写法）；
2. 脚本里定义的方法，**是否从未被绑定或内部调用**（死代码提示，不阻断）；
3. 配置里注册的页面，**四件套是否齐备**。

**退出码**：发现问题返回 1（可直接接入 CI 或提交前钩子）。

**它抓到过的真实问题**：一次删除功能时，删了脚本里的函数但漏删了一个界面按钮的绑定 —— 这个校验立刻报了出来，避免了"点了没反应"上线。

---

## 2. check-copy-discipline.cjs

**解决什么问题**：面向用户的文案（尤其是 **AI 生成或批量铺开**的）会漂移 —— 这次编了距离、下次用了专业术语、再下次两个版本写成同一句话。人工审 200 条内容不现实。

```bash
node tools/check-copy-discipline.cjs                    # 用同目录的配置文件
node tools/check-copy-discipline.cjs --config my.cjs    # 指定配置
```

复制 [`copy-discipline.config.example.cjs`](copy-discipline.config.example.cjs) 改成自己的。

**核心设计：逐条打印、不中断。**

断言式测试在第一条失败时就停了，你只能一条一条改；这个脚本**一次列出全部问题** —— 铺开改大量文案时效率差好几倍。

**内置的通用规则**（可扩展）：

| 规则 | 检查什么 |
|---|---|
| 禁用词 | 目标用户看不懂的专业术语 |
| 空话 | "随心所欲""看感觉"这类放到任何场景都成立的句子 |
| 编造数字 | "走 50 米""第 3 棵树"这类需要现场测量才能确认的数字 |
| 锚点缺失 | 方位词里没有可数锚点（"入口/桥/转角/尽头"） |
| 撞句 | 同一句话出现在多个本应不同的版本里 |
| 长度 | 超过上限的条目（冗长通常意味着没想清楚） |

---

## 3. cloudfunction-ratelimit.js

**解决什么问题**：云函数被脚本循环调用会烧配额。平台侧**没有"调用上限"这种硬开关**（只有告警），所以函数内限流才是实际防线。

**用法**：

```js
const { allow, humanWait } = require('./lib/ratelimit')

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const r = allow('<你的scope>', OPENID)
  if (!r.ok) {
    return { ok: false, code: 429, error: 'TOO_MANY_REQUESTS', wait: humanWait(r.retryAfterMs) }
  }
  // ... 业务逻辑
}
```

**三个设计要点**：

1. **参数按"滥用危害"定，不按调用成本定** —— 一条垃圾评论的调用成本是 0，但直接公开可见、危害最大；
2. **限流要放在业务逻辑最前面** —— 拦在内容安全检测与入库之前，超频请求消耗不到后续配额；
3. **客户端识别 429 后不要当成云端故障** —— 否则会触发熔断，把 5 秒的等待放大成全面不可用。

**已知局限（写在代码注释里了）**：多实例并发时各实例各算各的，实际上限 ≈ 阈值 × 实例数；实例回收后计数清零。

> 真要精确计费保护，在同一个 `allow()` 调用点补一层 DB 计数即可，**调用方不用改**。

**注意**：每个云函数是独立部署单元，**不能跨目录引用**。多个函数需要这份逻辑时，同源复制并在文件头注明"两边必须同步"。

---

## 无依赖

三个工具都只用 Node 内置模块，**不需要安装任何依赖**。

**运行环境提示**：部分工具会加载 `.ts` 文件（若你的项目用 TypeScript），需要 Node 23+ 才能直接 `require`；更低版本的做法是先把 TS 复制到临时目录并补齐相对导入的扩展名（见 `check-copy-discipline.cjs` 里的思路）。
