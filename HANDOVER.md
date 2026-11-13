# 工程交接 · dsh-model-visibility

> 给下一位 Agent、模型或工程师：先读本文，再改代码。本文只保留当前有效的架构、契约与操作步骤；历史发布细节查 Git，功能说明查 [README.md](README.md)。
>
> 基线：`@tzyc/dsh-model-visibility` **1.13.0** · Node.js 24 · ESM · 217 个测试 · 2026-11-13 校验流程重构

## 1. 十分钟上手

### 1.1 项目职责

这是一个 DSH Host + Web 双端插件，做四件核心事情：

1. 过滤输入框模型目录，持久化显示/隐藏偏好；
2. 合并 Provider、适配器、中转站、快照和手动覆盖中的模型能力；
3. 在 pi-ai 中转站适配器上对齐图像输入准入与序列化；
4. 提供联网校验、Provider 写回、Token 账本与 CSV 导出。

**不是**新的模型选择器，**不是**实际模型能力基准测试，**不是**独立的用量计费系统。

### 1.2 首次检查

```powershell
cd D:\code\dsh-model-visibility
npm install
npm test
npm run build
git status --short
```

预期：217 个测试通过，构建成功，重复构建没有 `client.js` 差异。本机使用 Node.js 24，`usage-ledger` 依赖 Node 的 `zlib.zstd*`。

```powershell
npm pack --dry-run   # 发布前检查实际包内容
```

### 1.3 修改路径

| 你要改什么 | 修改位置 | 必须验证 |
| --- | --- | --- |
| 设置页、标签、筛选、校验面板 | `client-src/` | `npm test` → `npm run build` → 刷新 GUI |
| Host 路由、缓存接线、持久化 | `index.js` | Host 测试 + 重新加载 Host/重启 DSH |
| 能力优先级、图像准入语义 | `lib/model-info.js` | `model-info` / `capability` / `image-input` 测试 |
| 中转站方言、探测降级 | `lib/provider-probe.js` | 解析 + 401/DNS/超时/HTTPS 测试 |
| 学习快照、模型 ID 合并 | `lib/learned-catalog.js`, `lib/model-id.js` | 新旧值、别名、重开文件测试 |
| 校验编排、公开目录、提示词 | `lib/check-catalog.js` | 校验、公开目录、取消与 dispose 测试 |
| Provider 回写 | `lib/provider-write.js` | 路径、白名单、写后剥离测试 |
| Token 账本 | `lib/usage-ledger.js` | Zstd、修订/重试、增量与 dispose 测试 |
| 浏览器模型菜单过滤 | `client-src/composer-filter.mjs` | Store 还原、当前模型保留、真实 GUI |

**不要直接编辑 `client.js`。** 它由 `scripts/build-client.mjs` 生成并提交到仓库。

### 1.4 宿主环境

- 本地开发目录：`D:\code\dsh-model-visibility`
- profile 以 `link:` 指向此目录；DSH 实际 Host 插件行来自 `cordis.patch.yml`
- Host namespace / 插件行 id：`model-visibility`
- 包名与客户端 ModuleLoader id：`@tzyc/dsh-model-visibility`
- Web 路由前缀：`/api/dsh-model-visibility`
- 用户数据：`$DSH_HOME/dsh-model-visibility/`

只有客户端插件 HMR 且 `pnpm run dev:web` 正在同一 DSH checkout 运行时，才能期待客户端源码自动重载；本项目普通修改应按上表构建、刷新或重启，不要另起替代 GUI 服务。

## 2. 架构与数据流

```text
Browser
  settings-section / checker-view / usage-view
              │
              ▼
  catalog-store ── GET/POST /api/dsh-model-visibility/*
              │
              ▼
Host index.js
  ├─ model-info ── listProviders → listModels → resolveModelInfo
  │       ├─ provider-probe ── Provider /models + /api/pricing
  │       ├─ learned-catalog ─ learned.json
  │       ├─ model-overrides ─ overrides.json
  │       └─ capability-corrections / name heuristics
  ├─ check-catalog ─ public catalogs + checker LLM
  │       └─ provider-write ─ settings.mutate
  ├─ image-input-gate ─ pi-ai adapter.modelOf
  └─ usage-ledger ─ sessions/**/session.v4.jsonl[.zstd]

Browser composer-filter
  modelDirectories.directoryFor → directory.store
  → filter hidden provider/model keys in place
```

### 2.1 Host

`index.js` 负责生命周期和接线，复杂逻辑放在 `lib/`：

- `Config.hidden`：volatile 数组，元素为不透明的 `provider/model` key；
- `Config.probe`：是否探测中转站；`MODEL_VISIBILITY_PROBE=0` 可关闭；
- `Config.applyInput`：volatile 图像放行开关，默认 `true`；
- `settings.configure({ auto: false })`：关闭重复的自动配置页；
- `ctx.inject(['llm', 'connection'])`：安装能力服务和同源认证路由；
- `settings`、`credentials` 是可选服务，缺失时降级而非崩溃；
- `scope.effect`：恢复适配器补丁、停止校验与用量扫描、解除事件订阅。

`hidden.json` 是 `cordis.patch.yml` 之外的恢复副本。模块加载时读取它作为 `hidden` 默认值；volatile/设置文档更新和卸载时同步。`hidden` 与 `applyInput` 不应混为同一个语义。

### 2.2 Browser

`client-src/index.mjs` 注册字典、CSS、设置 section 与 composer filter。

- React 使用宿主 `require('react')`，无 JSX；
- `catalog-store.mjs` 是 fetch/store 层；组件不直接拼 Host 请求；
- `pure.mjs` 保存可独立测试的筛选和统计逻辑；
- `format.mjs` / `tags.mjs` 负责来源与标签展示；
- `composer-filter.mjs` 就地包装 Store，不替换 Store 对象；
- `localStorage` 只保存阅读偏好与校验员选择，不保存权威模型事实。

构建器是受限的 ESM→CJS 文本转换器，不接受 default/namespace/side-effect import。新增语法前先读 `scripts/build-client.mjs`，不要假设它是一般 bundler。循环依赖会显式报错。

## 3. 文件地图

```text
index.js                         Host 生命周期、路由、隐藏列表、缓存接线
cordis.patch.yml                 Host 插件行；name 必须等于包名
client-src/
  index.mjs                      浏览器入口
  constants.mjs                  namespace / 字段 / API / section id
  catalog-store.mjs              模型、覆盖、用量、校验 Store
  composer-filter.mjs            输入框模型目录过滤
  settings-section.mjs           设置页主体
  checker-view.mjs               校验面板
  override-editor.mjs            单模型覆盖编辑器
  usage-view.mjs                 用量条与下载
  tags.mjs / format.mjs          标签与来源展示
  pure.mjs                       纯筛选、统计、诊断工具
  hooks.mjs                      Store React 绑定
  dict.mjs / css.mjs             中英文字典与主题样式
lib/
  public-catalog.js               公开目录纯解析、合并与匹配
  checker-answer.js               校验回复提取与能力投影
  checker-contract.js             固定结果格式、字段检查与引用过滤
  checker-call.js                 有界 LLM 工具循环、搜索与网页读取
  async-operation.js              超时/取消，即使下游忽略 AbortSignal 也返回
  model-info.js                  能力合并、目录构建、缓存、图像准入判断
  capability-catalog.js          类型与输入模态的保守名称推断
  capability-corrections.js      有官方文档依据的精确 ID 校正
  model-id.js                    ID 归一化与别名
  learned-catalog.js             learned.json、索引与新旧事实合并
  model-overrides.js             手动覆盖校验与持久化
  provider-probe.js              中转站配置、探测、缓存与诊断
  provider-write.js              Provider 字段映射与路径写回
  check-catalog.js               公开目录、校验员、分批/并发/取消
  http-body.js                   流式字节限量响应读取
  image-input-gate.js            可逆 pi-ai modelOf 包装
  usage-ledger.js                会话日志折叠、增量扫描、用量缓存
  export-csv.js                  安全 CSV 输出
scripts/build-client.mjs          单文件客户端构建器
client.js                        构建产物，勿手改
locale/                          插件列表文案
test/                            Node test runner 测试
docs/                            当前截图与市场图标
```

## 4. 核心契约

### 4.1 能力记录与来源

`mergeCapabilities(base, context)` 输出 UI 与图像闸门共享的纯记录：

```ts
type ModelRecord = {
  id: string
  name: string
  description?: string
  kind: 'chat' | 'image' | 'video' | 'embedding' | 'rerank' |
        'audio' | 'classifier' | 'translation'
  inputModalities?: string[]
  outputModalities?: string[]
  contextWindow?: number
  defaultMaxTokens?: number
  reasoning?: {
    efforts: { id: string; name: string; description?: string }[]
    defaultEffort?: string
  }
  reasoningSupported?: boolean
  sources: {
    kind: Source
    modalities: Source
    context: Source
    reasoning: Source
  }
  learned?: { id: string; verifiedAt?: number; origins?: string[]; checker?: object }
  correction?: { id: string; code: string; note: string; source?: string }
  infoError?: string
}

type Source = 'manual' | 'config' | 'adapter' | 'provider' |
              'snapshot' | 'inferred' | 'official' | 'unknown'
```

`official` 是校正层，不是普通顺序中的一级。它可修正 `provider`、`snapshot`、`inferred`、`unknown`，但不能压过显式 `config`、内置 `adapter` 或 `manual`。

返回给 Client 的 `Catalog` 包含：

```ts
{
  groups: { id, name, models: ModelRecord[] }[]
  failures: { id, name, message }[]
  providers: ProviderDiagnostic[]
  learned: {
    models: number
    updatedAt?: number
    checker?: object
    features: string[]
  }
  generatedAt: number
}
```

`learned.features` 用于新浏览器识别旧 Host。当前特性：`applyInput`、`reload`、`overrides`、`verify`、`usage`、`checkerBudget`、`verifyWeb`。不要恢复旧字段名 `catalog`；浏览器 Store 读取 `state.learned`。

### 4.2 学习快照

`learned.json` 以 `modelIdVariants(id)[0]` 为键，按 mtime 读取，支持外部手改。保存字段包括 `type`、`input`、`output`、`contextWindow`、`maxTokens`、`reasoning`、`reasoningEfforts`、`defaultEffort`、`verifiedAt`、`origins`、`checker`。

合并规则：

- 同时间或较新的批次可以覆盖同名字段；
- 较旧批次只能补充空缺，不能覆盖新声明；
- `verifiedAt` 取最大值；
- `origins` 求并集；
- 一批写一次，重读一次文件；
- 同一模型 ID 跨路由复用，不代表不同 Provider 的路由实测结果必然一致。

下一步若增强证据模型，优先设计字段级时间戳、来源和 Provider scope，不要退回“后写者总是覆盖”。

### 4.3 HTTP 路由

均经 `ctx.connection.fetch.register`，使用 DSH 同源认证。**不要改成裸 HTTP 服务。**

| 路由 | 行为 |
| --- | --- |
| `GET /models` | 读取能力目录；能力缓存 15 s，探测缓存 10 min。 |
| `GET /models?fresh=1` | 绕过 TTL，但合并当前 in-flight。 |
| `GET /models?reload=1` | 使本地缓存与代次失效，丢弃旧结果，再读取。 |
| `GET /overrides` | `{ ok, value: { overrides } }`。 |
| `POST /overrides` | 保存一条覆盖，或 `{ remove:true, provider, model }`。默认尝试 Provider 写回，`applyToProvider:false` 可关闭。 |
| `GET /usage` | 返回账本，按 60 s 节流触发扫描。 |
| `POST /usage` | 强制下一次读取触发扫描，但仍复用当前 in-flight。 |
| `GET /export?type=usage|models` | 下载对应 CSV。 |
| `GET /verify` | `{ state, learned }` 进度与快照元信息。 |
| `POST /verify` | `{ provider, model, writeBack?, webSearch?, concurrency? }` 启动；`{ cancel:true }` 取消。 |

`/models` 失败是 `500 model-info/failed`；`/overrides` 非 JSON 是 `400 overrides/body`。Provider 写回拒绝不一定是 HTTP 错误：本地覆盖仍有效，原因放入 `value.provider`。

### 4.4 Provider 写回

只写现有 Provider 的现有模型条目：

```text
settings.describe()
  → 找含 pi-ai 的 namespace 与 providers[id].models 下标
  → settings.mutate(ns, [
      { op:'set', path:['providers', id, 'models', index, field], value }
    ])
```

映射：`input` → `input`，`contextWindow` → `contextWindow`，档位 → `reasoningEfforts`。

- `off` 映射 `null`，其他允许档位映射自己的 ID；
- 档位白名单：`off/minimal/low/medium/high/xhigh/max`；
- 只有 `off` 的档位不写 Provider，保留本地；
- `kind` 与 `defaultEffort` 无等价 per-model 字段，保留本地；
- 已写字段通过 `stripWrittenFields` 从本地覆盖剥离；
- 写后必须刷新能力、Provider profile 与图像准入缓存；
- 不用整个 Provider `update`，不自动创建 `models`，不用 `modelOverrides` 绕过限制。

### 4.5 网络与响应上限

- `provider-probe`：只向配置的 `baseURL` 同源地址请求，HTTPS only；HTTP 只允许 loopback。每请求默认 3.5 s，响应 4 MiB。
- `check-catalog`：公开目录无凭据，models.dev 两源 + OpenRouter + Hugging Face 镜像；每源 20 s，响应 16 MiB。
- 两者均 `redirect: 'error'`，防止 Authorization 跨域泄漏。
- `http-body.js` 以流式 chunk 累计**字节数**，不是 `text.length`；超限 cancel reader，Content-Length 只用于提前拒绝。
- 不要在无 `body` 的测试 double 上强行调用 `getReader`；helper 会退回 `text()` 并再次按 UTF-8 字节数验证。

### 4.6 校验任务与用量账本生命周期

`createCapabilityVerifier`：

- 同一时刻一轮 sweep；`start()` join 已存在的 run；
- 默认批大小 6、并发 2，单次并发限制 1–8；
- 校验输出预算 8192，仅模型声明支持时指定 `reasoningEffort:'low'`；
- `done` 为有效结果，`processed` 为已处理；另有 `unknown`、`failed`、`searchCalls`、`fetchCalls`；进度条以 processed 为准；
- 请求默认 180s、批次总预算 360s，搜索/读取最多 30s；工具循环最多 5 轮/12 次，响应限制 128000 字符；
- 联网模式采用严格固定 JSON 及 evidence 字段，只接受本批检索 URL，未引用的能力字段被剔除；引用仍需语义核实；
- Provider 写回默认关闭；`webSearch` 的 HTTP 默认 true，直接构造无 web 的校验器可离线使用；
- 所有 worker 通过 allSettled 收尾；flush 失败不能提前释放 running、让旧 worker 污染新 run；
- 结构错误定向重试一次，失败批次二分；
- `cancel()` 只 abort，不伪造 worker 已退出；
- `dispose()` 标记停止、abort 公开目录和 checker，并等待 `running`；
- dispose 后禁止重新启动；停止时只保留已 flush 的批次，不开始新的落库。

`createUsageLedger`：

- 递归找 `session.v4.jsonl.zstd` / `session.v4.jsonl`；
- Zstd 是多帧拼接，必须逐帧扫描，不可整文件一次解压；
- `(mtime,size)` 未变则复用；当前月精确日期，旧历史按会话创建日；
- 每文件内 `*` 是便利合计，聚合必须跳过；
- `dispose()` 阻止新扫描、吸账和写文件，等待当前扫描，停止后不得再落盘；
- 历史缓存约保留 14 个月，“总计”不是无限期财务总账。

## 5. 不可破坏的规则

修改前逐项读，以下规则比局部代码风格更重要：

1. **`input: []` 是未知，不是纯文本。** Provider 存在时，不要把回退的 `defaultInput:[text]` 当模型事实。
2. **不知道就保持 unknown。** 不把推断伪装成声明；`snapshot` 和 `inferred` 在 UI 必须是虚线。
3. **页面与请求侧共用 `mergeCapabilities`。** 图像准入不得另写一套判断。
4. **当前会话模型即使隐藏也保留。** 官方选择器需要它解析当前标签。
5. **模型 key 不透明。** 用 `keyOf` 生成，不能按 `/` split 还原，因为模型 ID 可含 `/`。
6. **就地 patch 模型 Store。** 官方座位可能已捕获对象；替换对象无效。
7. **生成类模型不套用对话标签。** 生图/生视频/嵌入等不显示推理、上下文或纯文本。
8. **隐藏开关不触发全量网络探测。** `settings/document-updated` 只在路由指纹变化时使探测缓存失效。
9. **旧请求不得覆盖新代次。** `invalidate()` 提升 generation；旧 in-flight 不得清掉新 Promise 或回填缓存。
10. **凭据不出 Host。** 不返回密钥、请求头或完整认证 URL；不跟随重定向。
11. **官方校正只锁精确 ID。** `glm-5.3` 与 `glm-5.3-flash` 不能混同；校正需有官方文档。
12. **模型 ID 归一化保持保守。** 不为了增加命中率把标点、后缀任意折叠。
13. **Provider 写回不猜测数组下标。** describe 与 mutate 之间仍可能漂移；需要更强保证时先设计条件写/重读确认。
14. **卸载可逆。** 图像 patch 只删除自己的 wrapper；后台任务不得在 scope dispose 后继续写配置或文件。
15. **手动覆盖高于 official。** 用户的显式声明不能被启发式或校正悄悄替换。
16. **UI 文案中英同步。** `client-src/dict.mjs` 两边 key 与 placeholder 必须一致。
17. **主题色用 `--dsw-alias-*`。** `color-mix` 前提供透明背景 fallback，开关选中态不能等同底色。
18. **`client.js` 的包 ID、包名、patch name 一致。** 否则 Loader 报 loaded without registering。
19. **所有写文件逻辑先校验并限制数据。** 损坏文件可以降级为空，但不得让插件主路径崩溃。
20. **公开目录或校验员不是实测。** 文档、UI、来源命名都不得暗示它测过目标模型。

## 6. 常见修改指引

### 6.1 新增能力字段

1. 在对应来源 parser 中读取并清洗；
2. 在 `mergeCapabilities` 定义来源优先级、默认值与 `sources`；
3. 明确该字段是否进入图像闸门、学习快照和 Provider 写回；
4. 在 `tags.mjs` / `format.mjs` 渲染，并同步 `dict.mjs`；
5. 添加纯函数、Host、渲染测试；
6. 若 Host 新功能需让新 Client 识别，增加 `learned.features` 标志。

### 6.2 新增中转站方言

1. 只改 `readModelEntry` / `parsePricing` 等 parser，尽量不改任务编排；
2. 使用脱敏的真实响应形状写 fixture；
3. 保留未知字段为 unknown，不根据猜测补全；
4. 测 401、超时、HTTP/HTTPS、空 models、pricing 403；
5. 不新增携带凭据的第三方请求。

### 6.3 新增官方校正

在 `capability-corrections.js` 添加规范化精确 ID、字段、说明、code 和官方链接；在字典补 code；测试精确命中、相似 ID 不命中、config/manual 优先、图像闸门同步。

### 6.4 修改校验或快照

1. 明确“公开声明”与“LLM 推断”的来源差异；
2. 旧批次只能补空缺，不能覆盖新事实；
3. 测同一模型跨路由、取消、立即重启、dispose 中途落库；
4. 所有网络 stub 保留标准 Response 或验证 `http-body` 的 no-body fallback；
5. 校验错误直接显示真实原因，不只显示“0 条”。

### 6.5 修改 UI

1. 只改 `client-src/`，无 JSX，避免不支持的 import/export 语法；
2. 长说明放折叠区，首屏保留关键动作；
3. 搜索/筛选不改 `hidden`；折叠只写 localStorage；
4. 增加控件后扩展真实 `client.js` 渲染点击测试；
5. `npm run build` 后刷新现有 DSH GUI，验证中英、深色主题与长模型列表。

### 6.6 修改账本

先读会话事件真实结构，再改 `foldLogToBuckets`。必须覆盖同 `(turn,step)` 修订替换、重试加计、重复结算去重、`*` 不重复聚合、残缺末帧、跨月与 dispose。不要把整文件 Zstd 当单帧，也不要假设 mtime 不变就一定没有外部内容替换。

## 7. 测试与验证

### 7.1 自动化

```powershell
npm test
npm run build
git diff --exit-code -- client.js
```

当前基线 **217 个测试**。覆盖：

- 能力优先级、官方校正、未知与推断来源；
- 快照新旧合并、别名、外部修改；
- Provider 方言、鉴权失败、网络降级；
- 流式字节上限、中文、超限取消；
- 缓存代次、in-flight、图像闸门；
- 校验预算、格式、重试、取消与 dispose；
- 用量 Zstd、重试、增量与 dispose；
- CSV 转义与公式注入；
- 客户端 Bundle 确定性、模块卫生与真实渲染点击。

`test/setup.mjs` 在任何模块加载前将 `DSH_HOME` 指向临时目录；`host.test.mjs` 每个用例清理覆盖文件。新增测试必须沿用这一隔离，不能读取用户真实快照。

### 7.2 GUI 最小冒烟

Host 改动后重新加载 Host/重启 DSH；Client 改动后构建并刷新页面。

- [ ] 设置页能打开，无空白、ReferenceError 或 stale-Host 横幅；
- [ ] 单模型、整组、全部显示开关生效，刷新后保持；
- [ ] 输入框不显示隐藏模型，当前模型仍显示；
- [ ] 搜索、类型、能力、上下文筛选和折叠正常；
- [ ] 显式纯文本、未知、多模态与官方校正标签正确；
- [ ] 对一个确认支持图像的模型发送小图；关闭放行后恢复原声明；
- [ ] 手动覆盖保存、重载、恢复自动，以及 Provider 写回/不写回均正确；
- [ ] 「刷新」与「重新获取能力」都不会改隐藏列表；
- [ ] 校验能启动、显示进度与失败原因、取消后停止，dispose/重载不继续写；
- [ ] 用量与两个 CSV 可导出，历史总计文案不误导；
- [ ] 英文界面无缺词，窄窗口不破坏布局。

### 7.3 排错入口

| 症状 | 优先检查 |
| --- | --- |
| 设置页空白 | `client-src` import、构建转换、真实渲染测试、浏览器异常 |
| Host 特性按钮不可用 | `learned.features`、Host 是否重载、catalog store 是否发布 `learned` |
| 点击开关引发全量探测 | `noteSettingsChanged` 路由指纹与缓存订阅 |
| 标签多模态但发图失败 | pi-ai adapter 形状、`modelOf` 是否被包装、显式 `input:[text]` |
| 校验全是空/截断 | checker 思考档位、8192 预算、finish reason、真实 JSON 形状 |
| 校验取消后仍写 | 是否等待 `running`，flush 是否受 abort/disposed 保护 |
| 用量偏低 | Zstd 帧扫描、`*` 聚合跳过、历史保留窗口、文件变更重读 |

## 8. 当前技术边界与优先事项

### 已知的剩余风险

1. **校验不是目标模型实测。** Provider 写回默认关闭，联网引用只能证明 URL 来自本轮检索，语义准确性仍需复核；已开始的 settings.mutate 不支持取消或撤销。
2. **私有宿主契约。** `modelDirectories`、`llm.adapters`、`modelOf`、设置结构和日志格式都可能随 DSH 更新改变。
3. **写回下标竞态。** describe 与 mutate 间模型数组改变时可能写错目标；不要在 UI 并发动态修改 Provider 列表。
4. **多 Host/多 profile。** 文件为全局共享，当前原子替换不等于跨进程事务锁。
5. **账本性能。** 修改过的日志会整文件重读、同步解压；大型历史库需要流式或分块增量。
6. **模块规模。** 校验已拆分公开目录、结果契约、回复投影与工具执行；`check-catalog.js` 仍负责调度，设置页主体仍可继续拆分。
7. **构建器语法受限。** 长期可换标准 bundler，但必须保留宿主 ModuleLoader 包装及现有回归测试。

### 推荐顺序

1. 为字段增加来源、观测时间、Provider scope 和置信度；写回提供预览/撤销；
2. 引入真实 DSH 版本矩阵与 GUI E2E，减少私有 patch 的“测试全绿、线上失效”；
3. 为校验、探测和 Store 增加统一取消/请求超时，完善多实例文件锁；
4. 账本改流式/分块扫描，设置页大列表虚拟化；
5. 将公开目录 parser、校验编排、Provider 写回继续拆分；最后再考虑价格、预设和批量规则等新功能。

## 9. 发布检查

不要在未明确要求时提交、打 tag 或发布。需要发布时：

```powershell
npm test
npm run build
git diff --exit-code -- client.js
npm pack --dry-run
```

1. 更新 `package.json` 版本、README 测试徽章与本文基线；保持包名和 Loader id 一致。
2. 检查 README 图片与 `screenshots.json`；当前是 `docs/overview.png` 与 `docs/online-verification.png`，市场图标是 `docs/icon-180.png`。
3. 确认 `package.json.files` 包含 `client-src`、`lib`、`docs`；`scripts` 和 `test` 不需进入运行包。
4. 完成上述 GUI 冒烟，尤其 Host 重载、真实图片发送与校验取消。
5. 经用户确认后再 commit、tag、push、`npm pack`、GitHub Release 和 `npm publish`。
6. GitHub Release 同时提供带版本号与固定名 `dsh-model-visibility.tgz`，固定名供市场 `releases/latest/download` 使用。
7. npm 使用 `publishConfig.access=public`；不得把 token、临时 npmrc 或凭据写进仓库。

历史版本、旧 PR、旧 shasum 和已修故障不再记录在这里；使用 `git log` 与 Release 页面检索。

---

## 下一位执行者的最短指令

> 先跑 `npm test`；按文件地图定位；守住第 5 节不变量；Client 必构建、Host 必重载；每个修复补能证明旧行为会失败的测试；结束前跑全量测试、构建和 GUI 冒烟；不要把联网校验写成真实能力测试，不要把密钥或用户快照带入测试和提交。
