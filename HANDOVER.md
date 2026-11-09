# HANDOVER — dsh-model-visibility

> 给下一个接手的人 / AI。目标：**不用重新啃 DSH 源码就能继续加功能**。
> 当前版本 **1.10.2**（学习快照联网校验 + token 用量账本与导出 + client 模块化拆分 + 前述全部能力；静态内置目录已删除）。

---

## 1. 这个插件是干什么的

六件事，互相独立：

1. **模型显示开关**：设置 → 模型显示，按 Provider 分组列出全部模型，每个模型一个开关；关闭的模型从聊天输入框的模型菜单里消失。偏好持久化在 Host 设置文档 + `$DSH_HOME/dsh-model-visibility/hidden.json` 影子副本。
2. **真实能力标注**：在同一个设置页，每个模型下面标注：
   - 是否支持推理、思考强度档位；
   - 上下文窗口；
   - 输入 / 输出模态；
   - 模型类型：对话 / 生图 / 生视频 / 嵌入 / 重排 / 音频 / 审核 / 翻译（类型标签各用一种颜色）。
3. **区分声明与补全**：每个字段带 `sources`；实线标签 = 适配器、中转站或厂商文档声明，虚线标签 = 内置目录或模型名推断。生成类模型只显示类型 / 分辨率等真正相关的标签。
4. **请求侧图像准入对齐**：DSH 的 pi-ai 适配器按 Provider 的 `defaultInput`（通常是 text）构造模型，导致「页面显示多模态、发图却被拒绝」。Host 在内存里包装 pi-ai 适配器的 `modelOf`，对插件判定为可输入图像的模型补上 `image`；设置页开关 `applyInput` 可关闭，不写配置、卸载即恢复。`glm-5.3` 这类被官方校正为纯文本的模型不会放行。
5. **整组折叠**：设置页每组标题左侧有折叠箭头，工具栏有「折叠全部分组 / 展开全部分组」。折叠只影响渲染，不写入 `hidden`；状态在浏览器 `localStorage`（key `dsh-model-visibility:collapsed-groups:v1`），换浏览器 / 清缓存会丢，这是故意的，不污染 Host 设置。
6. **强制重新获取能力**：工具栏「重新获取能力」走 `?reload=1`，清空能力缓存、探测缓存、图像准入缓存和 in-flight 扫描后重读。用于上游有、页面偶发没识别到的情况；不能强迫 pi-ai 适配器重建它自己的快照，见决策 12。

7. **token 用量账本**：设置页顶部常驻今天 / 本周 / 本月 / 总计 token，数据来自会话日志（`lib/usage-ledger.js`，增量扫描），并有两个一键 CSV 导出（用量 / 模型清单）。
8. **联网校验**：设置页面板选择一个「校验员」模型，先拉 models.dev / OpenRouter 公开目录，再分批问校验员其余模型的类型 / 上下文 / 模态 / 档位；结果写入学习快照 `learned.json` 与（开关默认开）提供商配置；同名模型以后直接命中快照缓存（`lib/check-catalog.js`）。

它**不接管**输入框的模型座位，因此官方的「模型 / 推理等级」菜单、`dsh-codex-effort-slider`、`dsh-model-effort-defaults` 都能和它共存。

---

## 2. 仓库与运行环境

| 项 | 值 |
| --- | --- |
| 仓库 | `https://github.com/TZYCeng/dsh-model-visibility` |
| 本地目录 | `D:\\code\\dsh-model-visibility` |
| 安装方式 | profile 里 `link:D:/code/dsh-model-visibility` |
| Host 行 id / 设置命名空间 | `model-visibility` |
| 客户端插件 id | `dsh-model-visibility` |
| 依赖的服务 | Host：`llm`、`connection`，可选 `settings`、`credentials`；Client：`slots`、`locale`、`configForms`、`remote`、`remote.session`、`modelDirectories` |
| 构建 | `npm run build`（`scripts/build-client.mjs` 把 `client-src/*.mjs` 机械拼装成 `client.js`）；产物照旧提交进仓库 |
| 测试 | `npm test`（Node 内置 test runner） |

profile 里的接线（不要改名）：

- `package.json` 的 `dsh.bundle.patch` → `cordis.patch.yml`；
- `cordis.patch.yml` 插入 Host 行 `- id: model-visibility`；
- `package.json` 的 `dsh.client.immediately` 让浏览器半随页面加载。

---

## 3. 文件地图

```
index.js                     Host 半：hidden 持久化 + 影子副本 + /models 与 /overrides 路由 + 图像闸门安装
lib/model-info.js            Host 能力合并（纯函数 + 缓存），单元测试直接测它
lib/model-id.js              model-id 归一化与别名变体（各匹配层共用）
lib/learned-catalog.js       学习快照 learned.json：读写、mtime 失效、归一化 id 索引
lib/check-catalog.js         联网校验编排：公开目录双源、校验员分批、写回、token 记账
lib/usage-ledger.js          token 用量账本：zstd 帧解码、投影级折叠、按天/模型增量账
lib/export-csv.js            用量 / 模型清单两个 CSV 生成器（纯函数）
lib/model-overrides.js       手动覆盖的校验与 overrides.json 读写（按 mtime 失效）
lib/provider-write.js        把可对应的手动字段写回 llm-pi-ai Provider 配置（settings.mutate 路径操作）
lib/provider-probe.js        Host 中转站探测：读配置、解凭据、GET /models 与 /api/pricing
lib/capability-catalog.js    目录匹配 + 模型类型 / 家族模态启发式
lib/capability-corrections.js  厂商文档校正表（GLM-5.3 纯文本等），带来源链接
lib/image-input-gate.js      pi-ai 适配器 modelOf 包装（请求侧图像准入，可逆）
lib/model-catalog.js         由 scripts/build-catalog.mjs 生成的 models.dev 快照（勿手改）
scripts/build-catalog.mjs    重新生成目录
client-src/*.mjs             浏览器半源码，15 个模块（dict / css / pure / format 等），index.mjs 是入口
client.js                    构建产物（勿手改），npm run build 重新生成
cordis.patch.yml             Host 行声明
locale/zh.json, en.json      插件列表标题/描述
docs/*.png                   设置页截图（v1.3；v1.4 截图因沙箱 ACL 暂未落盘）
test/model-info.test.mjs     能力合并 / 缓存 / 手动覆盖优先级测试
test/model-overrides.test.mjs 覆盖校验、文件读写、损坏文件与外部改动
test/provider-write.test.mjs 回写映射、按模型下标写入、拒绝原因、写后字段剥离
test/capability.test.mjs     目录匹配、启发式、证据优先级、官方校正
test/provider-probe.test.mjs 配置读取、listing / pricing 解析、凭据、缓存、诊断
test/image-input.test.mjs    图像准入判定、适配器闸门与可逆性
test/host.test.mjs           index.js 接线：能力路由 + 官方校正 + 闸门开关变化 + 覆盖路由
package.json                 bundle 清单 / exports / files / npm test
```

### client.js 内部结构（按出现顺序）

| 区块 | 作用 |
| --- | --- |
| `NS`, `ENTRY`, `FIELD`, `SECTION_ID`, `API` | 常量；`API` 是相对 `document.baseURI` 解析出来的路由前缀 |
| `DICT` | 中英文字典，所有 UI 文案；**加文案必须两边都加** |
| `CSS` | 全部样式；颜色只用 `--dsw-alias-*` 主题变量 |
| `keyOf` / `hiddenSetOf` / `providerLabel` / `countModels` | 小工具 |
| `readCollapsedGroups` / `persistCollapsedGroups` | 折叠分组在浏览器端的持久化；JSON 数组，读失败按空集合处理 |
| `formatContext` / `effortNames` / `defaultEffortName` / `modalityLabel` / `sourceLabel` / `sourceOf` / `isInferredSource` / `kindOf` / `bucketOf` / `isGenerationKind` / `resolutionOf` / `modalityNames` | 能力标签工具 |
| `generationTags` / `capabilityTags` | 生图 / 生视频等只标类型并着色；对话模型标推理 / 上下文 / 模态，并带来源；`correction` 渲染 `官方校正` |
| `tagClassOf` | 标签样式：实线 / 虚线、`kind-*` 类型色、muted |
| `createCatalog` | 拉能力目录：先 Host 路由，失败退回官方 `session.modelCatalog()`；保存 `groups/failures/providers/catalog`；`reload()` 用 `?reload=1` 并让旧请求作废 |
| `createOverrides` | 覆盖列表的浏览器端 store：GET / POST `/overrides`，404 时标记「Host 不支持」；POST 返回 `{overrides, provider}`，`provider` 是回写结果；保存后由调用方刷新目录 |
| `ModelOverrideEditor` | 单模型编辑表单：类型 / 上下文 / 输入模态 / 思考强度档位 / 不支持推理 / 「同时写入提供商设置」；空表单保存 = 删除覆盖 |
| `providerWriteNote` | 把回写结果转成提示文案（成功写入了哪些字段，或为什么没写） |
| `patchDirectoryStore` / `installComposerFilter` | 就地改写模型目录 store，实现「隐藏」 |
| `countKinds` / `probeOf` / `makeSection` | 设置页组件（React）；`makeSection(form, catalog, overrides)` 里有 `applyInput` 开关、分组折叠状态（`readCollapsedGroups` / `persistCollapsedGroups`）、刷新 / 强制重取两条路径，以及每行的「编辑能力」入口 |
| `apply` | 注册字典、样式、设置 section、模型目录过滤 |

### index.js 内部

- `storeFile()` / `readStored()` / `writeStored()`：`hidden.json` 影子副本。
- `RESTORED`：模块加载时读影子副本，作为 `hidden` 的 schema 默认值。
- `createOverrideStore({ logger })`：`overrides.json` 的读写；`context` 里传给能力服务与闸门，保证页面和请求侧用同一份手动声明。
- `writeCapabilities(settings, entry)`：把 `input` / `contextWindow` / `reasoningEfforts` 写进 `llm-pi-ai` 的 `providers.<id>.models[<index>]`；成功返回 `{written:true, fields, ns}`，失败返回原因而不是抛错。写成功后把已写入字段从本地覆盖里剥离（只剩 `kind` / `defaultEffort` 等无法映射的字段时才保留条目）。
- `Config.probe`：是否探测中转站（默认 true；可用 `MODEL_VISIBILITY_PROBE=0` 关闭）。
- `Config.applyInput`：是否在请求侧给多模态中转站模型补图像能力（默认 true，volatile）。
- `apply(ctx, config)`：
  - `settings.configure({ auto: false })` 关闭自动生成的配置页；
  - 监听 `loader/volatile-update` / `settings/document-updated` → `persist()`（`hidden` 与 `applyInput` 任一变化都触发）；
  - `ctx.inject(['llm', 'connection'], ...)` → 可选 `scope.get('settings')` / `scope.get('credentials')`，构造 `createOverrideStore`、`createProviderProbe` 与 `createModelInfoService`（`context` 选项提供同步的 profiles + 最近一次探测快照 + overrides），注册能力路由与覆盖路由；覆盖路由在 `applyToProvider !== false` 时调用 `writeCapabilities`，成功后 `clearFallbackProfiles()` + `probe?.noteSettingsChanged()` 让网关立即读到新配置；
  - `installImageInputGate(scope.llm, ...)` 包装已注册 pi-ai 适配器的 `modelOf`；`scope.effect` 在卸载时恢复；
  - `llm/adapters-updated` / 凭据事件 → 清能力 + 探测缓存并 `imageInput.refresh()`；
  - `settings/document-updated` → 清能力缓存，只有 Provider 路由指纹变化时才清探测缓存。

---

## 4. 数据流

```
设置页 (client.js) ──▶ GET /api/dsh-model-visibility/models[?fresh=1]
                              │ (Host, index.js)
                              ▼
              createModelInfoService(ctx.llm, { enrichment })
                              │
         ┌────────────────────┴─────────────────────┐
         ▼                                          ▼
  ctx.llm.listProviders → listModels          createProviderProbe
         → resolveModelInfo                          │
         │                                     settings.describe()
         │                                          │
         │                              读 providers[].baseURL / apiKeyEnv / defaultInput / models
         │                                          │
         │                               credentials.resolve(apiKeyEnv)（每次探测）
         │                                          │
         │                          GET {baseURL}/models
         │                          GET {origin}/api/pricing（New API）
         │                                          │
         ▼                                          ▼
  lib/model-info.js::mergeCapabilities  ◀── profiles + discovered + diagnostics + overrides
         │
         │  manual > config > adapter > official(correction) > provider > catalog > inferred > unknown
         ▼
  { groups, failures, providers, catalog, generatedAt }

请求侧（发图时）：
  api-session 准入 → llm.resolveModelInfo → pi-ai adapter.modelOf（被 image-input-gate 包装）
                                              │
                                   service.imageInputAllowed(provider, model)
                                              │ 同一套 mergeCapabilities
                                              ▼
                                 可输入图像 → 模型对象补 image；否则原样返回

浏览器：
  能力标签（实线 / 虚线 / 类型色）   开关（hidden 列表）      图像对齐开关（applyInput）
        │                              │                        │
        └──────────┬───────────────────┘                        │
                   ▼                                            │
   modelDirectories store 过滤 → 输入框模型菜单                 │
                                                                ▼
                                                    Host 闸门实时读取
```

### 能力记录的形状（`lib/model-info.js` 的输出）

```ts
type ModelRecord = {
  learned?: { id: string; verifiedAt?: number; origins?: string[]; checker?: object }  // 命中的学习快照行
  //（snapshot 是 sources 的一个取值，原来写作 catalog）
  id: string
  name: string
  description?: string
  kind: 'chat' | 'image' | 'video' | 'embedding' | 'rerank' | 'audio' | 'classifier' | 'translation' | 'unknown'
  inputModalities?: string[]       // ["text","image"]
  outputModalities?: string[]      // ["image"] / ["video"]
  contextWindow?: number           // 正整数 token
  defaultMaxTokens?: number        // 仅 tooltip / 未来价格页
  reasoning?: { efforts: { id, name, description? }[]; defaultEffort?: string }
  reasoningSupported?: boolean     // 没有档位但目录/中转站知道支持或明确不支持
  sources: {
    kind: 'manual' | 'config' | 'adapter' | 'provider' | 'catalog' | 'official' | 'inferred' | 'unknown'
    modalities: 同上
    context: 同上
    reasoning: 同上
  }
  catalog?: { id: string; provider?: string; generatedAt?: string }
  correction?: { id: string; code: string; note: string; source?: string } // 厂商文档校正在生效
  infoError?: string               // resolveModelInfo 失败时存在；其它来源仍会补
}

type Catalog = {
  groups: { id: string; name: string; models: ModelRecord[] }[]
  failures: { id: string; name: string; message: string }[]
  providers: {
    id: string
    host?: string
    status: 'ok' | 'unauthorized' | 'failed' | 'skipped'
    models: number
    capabilities: number
    pricing: 'ok' | 'disabled' | 'failed' | 'skipped'
    message?: string
  }[]
  catalog: { generatedAt: string | null; piAiVersion: string | null; models: number; features?: string[] }
  generatedAt: number
}
```

`catalog.features` 是升级保护：新浏览器半看到缺少 `applyInput` 就显示「Host 半仍是旧版本」；看到缺少 `reload` 就把「重新获取能力」按钮禁用并提示重启；看到缺少 `overrides` 就禁用「编辑能力」并提示当前 Host 不支持手动覆盖。加 Host 能力时把标记加到这里。

### 路由合同

- `GET /api/dsh-model-visibility/models` —— 命中 15 s 能力缓存；探测结果另有 10 min 缓存。
- `GET /api/dsh-model-visibility/models?fresh=1` —— 跳过两层 TTL，但仍合并 in-flight 请求。页面「刷新」用这条。
- `GET /api/dsh-model-visibility/models?reload=1`（或 `&fresh=1&reload=1`）—— 先 `service.invalidate()` + `probe.invalidate()` + `clearFallbackProfiles()` + `imageInput.refresh()` + `overrides.invalidate()`，再重读；旧 in-flight 结果因 generation 变化被丢弃。页面「重新获取能力」用这条。
- `GET /api/dsh-model-visibility/overrides` —— `200 { ok: true, value: { overrides: [...] } }`。
- `POST /api/dsh-model-visibility/overrides` —— 一条覆盖（缺失字段表示不覆盖）或 `{ remove: true, provider, model }`；可选 `applyToProvider`（默认 true）把 `input` / `contextWindow` / `reasoningEfforts` 写进 Provider 配置。响应 `{ ok: true, value: { overrides, provider: { written, fields, ns?, reason?, message? } } }`；成功后清能力缓存、Provider profile 缓存与图像准入缓存。请求体不是 JSON → `400 overrides/body`；非 GET/POST → `405 overrides/method`；回写失败不改变 HTTP 状态（本地覆盖仍然生效，原因放在 `provider.reason`）。
- `GET /api/dsh-model-visibility/usage` —— 用量快照 `{ ranges: { today, week, month, total }, days, byModel, computing, progress }`；每次 GET 触发节流重扫（60s），POST 立即重扫。
- `GET /api/dsh-model-visibility/export?type=usage|models` —— CSV 附件下载。
- `GET /api/dsh-model-visibility/verify` —— `{ state }`（进度/批次/token）+ `{ learned }` meta；`POST { provider, model, writeBack? | cancel: true }`。
- 能力响应里的 `catalog` 已改名为 `learned`（`{ models, updatedAt?, checker?, features }`）。
- 成功：`200 { "ok": true, "value": Catalog }`
- 失败：`500 { "ok": false, "error": { code: "model-info/failed", message } }`
- 路由通过 `ctx.connection.fetch.register` 注册，走 DSH 的同源认证（owner peer），**不要**改成裸 `http.Server`。

---

## 5. 关键决策 & 为什么

1. **为什么不自动把 Provider 的 `input: []` 改成真实值？**
   自动改写用户配置会污染升级路径，而且中转站模型会变、同步插件会重写该块；自动纠偏仍走**内存包装** pi-ai 适配器的 `modelOf`（见决策 10），配置仍是用户自己的声明。只有用户在编辑器里显式勾选「同时写入模型提供商设置」，才通过 `settings.mutate` 写回该模型的 `input` / `contextWindow` / `reasoningEfforts`（见决策 15）。
2. **为什么 Host 端要新开路由，而不是直接用 `session.modelCatalog`？**
   官方投影只保留 `{ id, name, description?, reasoning }`，丢掉了 context、inputModalities，也没有类型。
3. **为什么要有内置目录快照？**
   中转站普遍只返回模型 id；`resolveModelInfo` 只回放 `defaultInput`。pi-ai 随包携带的 models.dev 数据已经知道 652 个模型的模态 / 上下文 / 推理 / 类型，蒸馏成静态模块后不依赖运行时 import，离线可用。
4. **为什么探测是 best-effort？**
   中转站可能 401、403、超时、只给 id、`/api/pricing` 被关闭。任何一个失败都不能让设置页不可用；失败写入 `providers[].status`，页面继续用目录补全。
5. **为什么实线 / 虚线？**
   用户明确要求「真实信息」。把推断值伪装成声明值是错误的；虚线 + tooltip 来源让用户能判断可信度。
6. **为什么生成类模型不显示推理 / 上下文 / 纯文本？**
   这些标签对生图 / 生视频没有意义，而且中转站的 `defaultInput: [text]` 会让它们错误显示「纯文本」。生成类只显示 `生图 / 生视频 / 4K / 可改图` 等。
7. **为什么 `settings/document-updated` 只清能力缓存？**
   「隐藏一个模型」本身就会写设置文档；如果每次都清探测缓存，点一下开关就会全量重探 8 个中转站。只有路由指纹变化才清探测缓存。
8. **为什么 `resolveModelInfo` 失败不丢掉模型？**
   开关必须始终可用。失败记录 `infoError`，页面照常显示，目录仍可补全能力。
9. **关于「合并 dsh-mobile-sync」。**
   已核对 `D:\\code\\dsh-android-Conversation sync`（package name `dsh-mobile-sync`）：它是手机同步插件，不包含读取思考强度的代码，不要为了「合并」把它搬进来。
10. **为什么补图像能力要包 `modelOf`，而不是改 `llm.resolveModelInfo`？**
    只改 `resolveModelInfo` 只能骗过 api-session 的准入；pi-ai 的 `streamWithSnapshot` 里还有 `if (containsImage && !model.input.includes("image")) throw UNSUPPORTED_CONTENT`。`modelOf` 是 `resolveModel`、`stream` 与 `imageRequestTarget` 共同的模型构造点，包它一次即可同时通过准入和序列化。DeepSeek Messages 适配器没有 `modelOf`，所以只命中 pi-ai。
11. **为什么需要 `lib/capability-corrections.js`？**
    目录快照会把厂商的纯文本旗舰标成多模态（`glm-5.3` 与多模态的 `glm-5.3-flash` 只差一个后缀）。这种错误比「未知」更危险：既会误导用户，又会让请求侧闸门放行不该放的图像。校正表只收厂商文档能证明的条目，来源显示为 `official`；它替换目录 / 推断 / 中转站列表，但不压过用户显式写入的 `input` 与内置适配器声明（中转站列表经常直接抄目录，所以也要能被校正）。
12. **为什么「重新获取能力」要单独一个 `?reload=1`，而不是复用 `?fresh=1`？**
    `fresh` 只绕过 TTL；如果上一轮 `describeCatalog` / `probe` 还在跑，`read()` 会把新请求接到旧的 in-flight Promise 上，用户点到的仍是那轮旧结果。`reload` 先 `invalidate()` 并提升 generation，旧 Promise 的结果不再写缓存，页面端 `createCatalog` 也用 generation token 丢弃旧 publish，所以新按钮能真正重来。限制：pi-ai 适配器用自己的 `current()` 快照，`config.profiles()` 身份不变时不会重建，插件无法强迫它重读内置目录；因此配置里没写 `reasoningEfforts`、适配器目录也没档位的模型，重载后仍然没有档位。要覆盖这种情况只能改配置或重启 DSH。
13. **折叠状态为什么放 `localStorage`，不放 Host 设置文档？**
    折叠是纯阅读偏好，不是「哪些模型可用」的事实。写进设置文档会触发 `settings/document-updated`，还会让多台设备 / profile 互相覆盖；放浏览器本地最便宜，也不会影响 `hidden` 的语义。
14. **手动覆盖为什么单独存 `overrides.json`，不塞进 Config？**
    覆盖值是结构化对象（类型 + 数组 + 可选档位），不是扁平开关；它由设置页频繁局部修改，而 Config 的一次写入会重写整份 `cordis.patch.yml`（profile 自愈 / 插件重装还会清掉该行）。独立文件还能让请求侧同步读取、支持手改，并按 mtime 自动生效；代价是多一个路由与一个校验模块，但这部分逻辑可以完全单测覆盖。
15. **回写为什么走 `settings.mutate` 的路径操作，而不是 `update` 整个 Provider？**
    `update` 的对象合并会把数组整体替换：拿到的是已经展开默认值的 `describe().value`，写回去会把未声明的字段一起固化，还可能冲掉并发写入。`mutate` 用 `['providers', id, 'models', String(index), field]` 只改目标字段；`providers` 是 volatile dict，路径合法。不能用 `modelOverrides`：Provider 一旦有 `models` 数组，适配器会明确拒绝同时设置 `modelOverrides`。写入前先 `describe()` 找 `ns`（优先含 `pi-ai`）和模型下标；找不到就返回原因（`provider-missing` / `models-missing` / `model-missing`），本地覆盖继续生效。`kind` 与 `defaultEffort` 没有对应的 per-model Provider 字段（`reasoning` 默认档是 per-Provider），只有 `off` 的档位会被 Provider schema 拒绝（“offers no level beyond off”），这三类都只留在本地文件。成功写入的字段随即从 `overrides.json` 剥离，避免同一事实存两份；旧 Host 不认识 `applyToProvider` 时忽略该字段，行为退化为纯本地覆盖。
16. **为什么删除静态内置目录、改为联网校验 + 学习快照？** 中转站大多不公布上下文/模态/档位，models.dev 快照快速过时且只能手动重生成。校验把「公开目录基准（免密钥）」与「用户自选的校验员模型」分开：前者标注可公开比对的声明，后者覆盖冷门模型；`unknown` 一律允许，绝不猜。结果落 `learned.json`（键 = 归一化 id），跨路由同名模型直接复用。写回开关默认开：能对应 provider schema 的字段直接写进配置，所有表面读同一份事实。
17. **为什么自建用量账本而不是读官方投影缓存？** token-meter 投影是按会话的总计，没有按天分桶与路由归属；usage-ledger 直接折叠会话日志（语义与投影逐位一致，测试对账验证），所以能出今天/周/月/总计与按模型分解。增量扫描以 (mtime, size) 为键，成本只随改动走。
18. **为什么历史只有本月精确、更早按会话创建日粗算？** 全史精确回填要解压全部日志（约 119MB / 575 个会话，首次几十秒）；总量始终精确，粗算只影响较早的日期归属。
19. **为什么拆成 client-src 而不用 tsdown chunks？** 组合脚本只发 `client.js` 入口，异步 chunk 要大改结构且收益有限；`scripts/build-client.mjs` 用机械文本变换（受限 import/export 语法 + 纯文本拼接）产出单文件 bundle，官方 Loader 协议零风险，受限语法由构建脚本硬断言。

---

## 6. 加新功能：照着做

### 6.1 给模型多标一项（例：价格）

1. **Host**：在 `lib/model-info.js` 的 `mergeCapabilities` 里增加字段与来源；数据来自 `discovered`（中转站）或新增目录字段。
2. **Client**：`capabilityTags` 里加一个 tag；生成类模型想显示就加到 `generationTags`。
3. **字典**：`DICT.zh` / `DICT.en` 各加文案。
4. 单测 + 页面 `Ctrl+R`。

### 6.2 新增一种模型类型（例：3D）

1. `lib/capability-catalog.js`：`MODEL_KINDS` 加 `'3d'`；`inferModelKind` 加关键词（如 `mesh|3d|gaussian`）；`isGenerationKind` 视需要包含它。
2. `lib/model-info.js`：`outputModalities` 的兜底里加 `kind === '3d' ? ['mesh'] : …`（可选）。
3. `client.js`：`DICT` 加 `tag.kind.3d`，`bucketOf` 归到 `other`（或新增筛选桶）。
4. 测试：`inferModelKind('xxx-3d')`。

### 6.3 更新内置目录

```powershell
node .tools/asar.mjs extract "<DSH>/resources/app.asar" `
  "dsh/node_modules/@earendil-works/pi-ai" ".tools/extract/pi-ai"
node scripts/build-catalog.mjs --data .tools/extract/pi-ai
npm test
```

目录变大时注意仓库体积；当前 652 个模型约 92 KB。不要手工编辑 `lib/model-catalog.js`。

### 6.4 加搜索 / 排序

`makeSection` 里已经有 `groups`、`filteredGroups`、`filter`、`hidden`、`state`。推荐：

- 新增 `const [query, setQuery] = React.useState('')`；
- 在 `filteredGroups` 之前再按 `model.name/id` 过滤；
- 只改渲染，不要改 `hidden` 的语义（隐藏仍然是持久化偏好，不是筛选条件）。

### 6.5 加一个新 Host 能力（例：输出上限展示）

1. `mergeCapabilities` 已经带出 `defaultMaxTokens`；来源优先级与 context 相同。
2. Client 加 tag 或在 tooltip 里显示。
3. 单测补断言。

### 6.6 接一个新的中转站方言

1. `lib/provider-probe.js` 的 `readModelEntry` 增加字段映射（例如 `architecture.input_modalities` 之外的形状）。
2. `parsePricing` 增加 endpoint type 名称。
3. 在 `test/provider-probe.test.mjs` 加一个真实响应样例（去掉密钥）。
4. 不要新增网络请求到第三方域名；只允许配置的 `baseURL` 同源。

### 6.7 加一条官方校正

1. 只在厂商文档能证明目录行错误时才加，不要按模型名猜。
2. 在 `lib/capability-corrections.js` 的 `CORRECTIONS` 里按**规范化后的 id** 加 `{ input, code, note, source }`；`code` 同时加到 `client.js` 的 `DICT.zh/en`（`correction.<code>`）。
3. 单测：`lookupCorrection` 命中精确 id、不命中 `-flash` 等变体；`mergeCapabilities` 的 `sources.modalities === 'official'` 且显式 config 仍优先。
4. 校正覆盖 `catalog` / `inferred` / `unknown` / `provider`（中转站列表常抄目录）；不要让它压过 `config` 与内置适配器声明。

### 6.8 调整请求侧图像准入

1. 判定在 `lib/model-info.js::imageInputDecision`，**必须**继续复用 `mergeCapabilities`，否则页面标签与准入会各说各话。
2. 进入/退出逻辑只在 `lib/image-input-gate.js`；它只识别 pi-ai 形状（`modelOf` + `profileOf` + `current`），不要包其它适配器。
3. 新增/删除适配器走 `llm/adapters-updated` → `imageInput.refresh()`；卸载时必须能恢复原方法。
4. 想默认关闭就把 `Config.applyInput` 的默认值改成 `false`，并同步字典说明。

### 6.9 加一种手动覆盖字段

1. `lib/model-overrides.js`：`sanitizeOverride` 校验新字段（白名单 / 数值范围），空值视为未声明；如果是数组，先写一个 `sanitizeX`。
2. `lib/model-info.js`：在 `mergeCapabilities` 对应字段的自动链之后加 `override` 分支，并把 `sources.<field>` 设为 `'manual'`；注意顺序，手动值必须压过 `official` 校正。
3. `client.js`：`ModelOverrideEditor` 加输入控件，保存时只在有值时才放进 payload（空 = 不覆盖）；`DICT.zh/en` 同步文案。
4. 单测：`test/model-overrides.test.mjs` 覆盖校验；`test/model-info.test.mjs` 覆盖「手动优先」与「空覆盖回到自动」。

---

## 7. 改动 / 调试流程（重要）

### 只改 `client.js`
- 页面 `Ctrl+R` 即可。浏览器半不经过构建。
- 打开 设置 → 模型显示 验证。

### 改 `index.js` / `lib/`
Host 半在 DSH 启动时加载，**改完必须让 Host 重新加载**：
1. 正常方式：重启 DSH（会中断当前会话，但最可靠）。
2. 开发方式（桌面版）：让 profile 重新组合。HMR 会在下一次 profile 重组时替换「磁盘上已改动的已链接包」。
   - 改一下 `%USERPROFILE%\\.dsh\\profiles\\desktop\\cordis.patch.yml`（例如给 `model-visibility` 行加 `probe: true`）触发，**验证完把临时内容删掉**；
   - 不要用「禁用/启用插件」来指望重载代码：HMR 可能复用旧模块生成。
3. 验证新路由是否生效：设置页底部出现「中转站探测：…」和「内置目录：…」；Grok / Claude 显示真实上下文与多模态；生图行只显示 `生图` 且为蓝色；`glm-5.3` 显示 `纯文本 / 官方校正`；顶部有「让输入框按能力标注放行图像」开关。
4. 重载后如果页面顶部仍显示「模型能力信息暂不可用」，Host 还是旧的。

### 看日志
Host 的 `console` 输出在 DSH 桌面进程里；没有独立日志文件。调试优先用单测 + 假 ctx 脚本。
中转站问题看设置页分组标题旁的探测徽标（悬停有 host / status / pricing 诊断）。

---

## 8. 坑（踩过的）

1. **`client.js` 不是普通 ESM**：文件开头是 `window.__ModuleLoader__.load({ id, factory(require){...} })`，`require('react')` 由外壳提供。不要加 `import`，不要用 JSX，不要打包。
2. **`key` 是 `provider/model` 的拼接**：model id 里可能含 `/`，所以永远用 `keyOf(group.id, model.id)` 生成，不要 split 回来。
3. **不要替换 store 对象**：官方座位可能已经捕获了同一个 store；只能就地改 `getSnapshot` / `subscribe`。
4. **`connection.fetch` 路由的 query 不参与匹配**：`?fresh=1` 安全；匹配只看 `pathname`。
5. **`resolveModelInfo` 可能很慢**：串行会慢，`Promise.all` 并发；缓存不要去掉。
6. **DSH 的模态只有 `text` / `image`**：不要硬编码别的值，未知值原样透传；视频 / 音频只用于展示，请求侧只对齐 `image`。
7. **`color-mix` 需要 fallback**：CSS 里先写 `background: transparent` 再写 `background: color-mix(...)`。
8. **中英文案**：`DICT` 只注册了一次；漏加 key 时 `t(key)` 会返回 key 本身。
9. **能力标签不改变可见性**：`hidden` 只由开关写入；筛选 / 标签不能顺手改 `hidden`。
10. **设置写入会触发 `settings/document-updated`**：不要在该事件里做 fresh 全量探测（见决策 7）。
11. **`settings.configure({ auto: false })`**：不要删；否则设置里会多出一个自动生成的配置页。
12. **`hidden.json` 是全局的**：多 profile 共用；测试时不要拿它当 profile 级状态。
13. **凭据只在 Host 解析**：不要把 `apiKeyEnv` 的值、请求头或 baseURL 全文塞进路由响应 / 日志 / 诊断。
14. **探测请求不要跟随重定向**：否则 `Authorization` 可能被带到别的域。`getJson` 用 `redirect: 'error'`。
15. **`defaultInput: [text]` 不是事实**：任何 `mergeCapabilities` 改动都要保住「profile 存在 + 模型未显式声明 input → 不把 adapter 的 text 当纯文本」这条规则。
16. **目录 key 会碰撞**：`gpt-5.1` 与 `gpt-5-1`、`glm-5.3` 与 `glm-5p3` 在快照里可能是两条；`modelIdVariants` 只做保守归一化，不要加过于激进的折叠。`glm-5.3` 与 `glm-5.3-flash` 是不同模态的两个型号，校正只锁精确 id。
17. **中转站 `/api/pricing` 很常见是 403**：这是正常状态，诊断记为 `disabled`，不是错误。
18. **`docs/` 目录在部分 Windows 环境被 Low integrity + NW 标记**：常规进程无法新建文件（截图落盘会 Access denied）。需要的话用管理员/低完整性进程处理，不要为了截图改 ACL。
19. **`llm.adapters` 是内部字段**：`image-input-gate` 依赖它枚举已注册适配器，并用 `modelOf`/`profileOf`/`current` 三重特征识别 pi-ai；升级 DSH 后若字段或适配器形状变化，先跑 `test/image-input.test.mjs` 再改这里。不要改成只包 `llm.resolveModelInfo`（pi-ai 序列化还会拒绝）。
20. **`modelOf` 包装必须可逆**：适配器重建后旧实例可能还在内存里，`refresh()` 只处理新注册；`dispose()` 只删除值仍等于自己 wrapper 的自有属性，不要覆盖别人的补丁。
21. **现在注册了两条路由**：`/models` 与 `/overrides`。`connection.fetch.register` 的测试 double 如果只保存「最后一条」，断言 `/models` 的用例会拿到覆盖路由的响应；`test/host.test.mjs` 按 path 后缀分别记录 `route.current` 与 `route.overrides`，加路由时照此扩展。
22. **回写用模型下标，先 `describe()` 再 `mutate()`**：两次调用之间如果模型列表被增删，下标会漂移。`settings.mutate` 的 `set` 在 `index === length` 时会追加，所以不要用它来「兜底新增模型」；找不到 id 就返回 `model-missing`，不要猜。`providers` 没有 `models` 数组时也不要临时造一个：有 `models` 列表会替换整个 served catalog，等于把其它模型全藏了。
23. **回写后必须刷新 profile 缓存**：Provider 的 `input` / `contextWindow` 改动不一定改变探测指纹，但 `probe.profiles()` 是同步图像闸门的数据源。写完调用 `clearFallbackProfiles()` + `probe?.noteSettingsChanged()`（`noteSettingsChanged` 会无条件刷新 `cached.profiles`），否则页面已经显示新值、输入框却仍按旧的 `input` 拒绝图片。
24. **不要把 `off` 单独写进 `reasoningEfforts`**：Provider schema 要求至少有一个非 `off` 的档位（“offers no level beyond off”），只勾 `off` 时回写必须跳过思考强度、把档位留在本地覆盖里；否则整个 `mutate` 会被 schema 拒绝，连模态和上下文也一起写不进去（当前实现是按字段发 ops，但未来合并成一次多字段校验时要记得这个约束）。
25. **`client.js` 的 `id` 必须逐字等于 `package.json` 的 `name`**：Host 按包名请求浏览器模块，Loader 找不到同 id 的注册就报「loaded without registering」。改名成作用域包（`dsh-model-visibility` → `@tzyc/dsh-model-visibility`）时，`client.js` 第 2 行、`cordis.patch.yml` 的 `name`、profile patch 里的插件行必须一起改；只改其中两处就会出现「服务端能加载、页面同步失败」。改完用 `node` 跑一遍假 Loader 模拟（见 `test/` 之外的临时脚本思路）或直接重启验证。
26. **先 `npm run build` 再 Ctrl+R**：改 `client-src/` 忘了构建会一直跑旧 bundle；构建脚本同样检查所有受限语法。
27. **会话日志是逐行 zstd 帧拼接**（不是单流压缩）：整文件 `zstdDecompressSync` 只解出第一行；必须按帧扫描（魔法数 + 帧头/块头步行）逐帧解。Node 24 的 `zlib.zstd*` 原族够用，不需要依赖。
28. **用量共同体不 double count**：每文件的分桶里 `*` 是当天合计的便利行，聚合（天/模型/区间）必须跳过它。
29. **校验批的 JSON 容错**：允许 ``` 围栏与前后闲话（`extractJsonBlock`），但只接受本批 id 的条目，`kind` 必须在白名单里，模态经 `normalizeModalities` 过滤；`unknown` 返回 null 事实。
30. **公开目录请求免凭据、不跟随重定向**：models.dev / OpenRouter 各自 15s 超时，失败按空目录处理（进度照常继续）。

---

## 9. 测试清单（发版前）

```powershell
npm test
```

> 如果终端本身在受限沙箱里、`node --test` 的子进程管道被拒（`spawn EPERM`），用
> `node --test --test-isolation=none test/*.test.mjs` 验证；这是环境限制，不是测试失败。

手工：

- [ ] 设置 → 模型显示：标题 / 描述 / 筛选 / 图例正常，模型按 Provider 分组。
- [ ] 摘要显示 `已显示 x / y 个模型 · 已关闭 n 个 · m 个生图/生视频模型`。
- [ ] `TianJi` 组里 `glm-5.3` 显示 `纯文本` + `官方校正`（不再是多模态）；`grok-4.7`、`claude-fable-5`、`gemini-3.8-flash` 显示 `多模态`，上下文是 `1M / 500K` 而不是统一的 `262.1K`。
- [ ] `minimax-m3.1-flash` 这类目录里没有的模型显示 `上下文 未知 / 模态未知`，而不是错误的 `纯文本`。
- [ ] 生图行只显示 `生图` + 可选 `4K` / `可改图`，没有 `支持推理`、`思考强度`、`上下文`；类型标签是蓝色。
- [ ] 生视频行只显示 `生视频`，标签是绿色；嵌入橙色、音频紫色、重排红色、审核玫红、翻译灰色；生成类行左侧有同色细条。
- [ ] 嵌入 / 翻译 / 审核行只显示类型。
- [ ] 虚线标签悬停能看到「来源：内置模型目录 / 模型名推断」；`官方校正` 悬停能看到厂商说明和文档链接。
- [ ] 顶部「让输入框按能力标注放行图像」开关可以切换并持久化；关闭后发图恢复为「模型不支持图像输入」。
- [ ] 分组标题旁显示 `中转站 n 个模型 · m 个带能力字段`；悬停能看到 status / pricing。
- [ ] 筛选 `生图` 只留生图行；此时分组按钮显示「显示/隐藏筛选结果」。
- [ ] 点分组标题左侧箭头：模型行收起、统计保留；刷新页面后折叠状态仍在；点「折叠全部分组 / 展开全部分组」一次切换所有分组，模型开关不受影响。
- [ ] 「重新获取能力」可用（Host 已重载）；点击后进入「正在获取…」，完成后能力标签刷新且显示开关不变；旧 Host 上按钮禁用并提示重启。
- [ ] 找一个能力未知的模型点「编辑能力」：勾选输入模态 / 思考强度并填上下文，保存后标签变成 `手动`，刷新页面仍在；清空保存后恢复自动识别，`overrides.json` 里对应条目消失。
- [ ] 保持「同时写入模型提供商设置」再保存：页面提示已写入，`cordis.patch.yml` 的 `providers.<id>.models[<n>]` 出现 `input` / `contextWindow` / `reasoningEfforts`，`overrides.json` 不再保留这些字段；输入框能按新模态发送图片。取消勾选时 Provider 配置不变，`overrides.json` 保留完整条目。
- [ ] 点一个开关：计数立即变化，设置文档 `cordis.patch.yml` 的 `hidden` 更新，刷新后仍保留。
- [ ] 输入框模型菜单：被关闭的模型不出现；当前会话的模型即使被关闭仍显示。
- [ ] （改 Host 后）页面底部有「中转站探测」和「内置目录」两行。
- [ ] 英文界面（切换 DSH 语言）文案完整。

---

## 10. 发布（每次版本更新必须完整走完 GitHub + npm 两件事）

每一次升版本，下面五步缺一不可（这也是历史踩坑后的标准链路，照抄即可）：

```powershell
cd D:\code\dsh-model-visibility
npm test                      # 必须全绿
npm run build                 # client-src 变化后重新拼装 bundle
npm pack --dry-run            # 核对 files 清单（client-src 已加入 files）
```
**① 更新版本号与文档** → `package.json` 的 `version`、README/HANDOVER 里的版本徽章与手工清单。
**② commit + tag + push GitHub**：`git commit` + `git tag v1.10.0` + `git push origin main` + `git push origin v1.10.0`（tag 为 GMT 命名 v<版本>）。
**③ 打 tar 包**：`npm pack --pack-destination .publish`（生成 `tzyc-dsh-model-visibility-<v>.tgz`）。
**④ GitHub Release**：用 REST（Bearer 通过 `git credential fill` 拿 device token；`.publish/release.mjs` 已写好全流程）创建 tag 对应 release，资源同时上传两个：**带版本号**的 `dsh-model-visibility-<v>.tgz` 与**不带版本号**的 `dsh-model-visibility.tgz`——市场条目的 `releases/latest/download/...` 依赖不带版本名，否则安装路径直接 404。
**⑤ npm publish**：作用域名 `@tzyc/dsh-model-visibility`。直发不通就按下面 token 流程；发完后核对 `npm view @tzyc/dsh-model-visibility version` 与从 registry 下载包检查 `client.js` 里 `id` 是作用域名。

版本号在 `package.json`；当前 `1.10.2`。
- 发版五步见本节开头（改版本号 → commit+tag+push → pack → GitHub Release 双资源 → npm publish）。1.10.0 起 `client-src` 已加入 `files`，tarball 里源码与产物一起发布。
- `files` 已包含 `lib`；`scripts` / `test` / `.tools` 不进包。
- `docs/` 只留 `settings-page.png`、`capability-tags.png`（1.9.0 起）与 `icon-180.png`；换截图时同步改 `screenshots.json` 与 README 的 `<img>`。如果重新截图，先确认目录可写（见坑 18）。
- npm 发布见 10.2；名字是作用域 `@tzyc/dsh-model-visibility`，`cordis.patch.yml` 里的 `name` 必须与 `package.json` 的 `name` 完全一致，否则 bundle 安装时 loader 找不到包。

### 10.1 插件市场（awesome-dsh-plugin）

投稿只需在 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 里加 **一个** 文件
`data/plugins/TZYCeng__dsh-model-visibility.yml`（格式见仓库 `contributing.md`，README 由数据生成，不要手改）。
当前条目：

```yaml
url: https://github.com/TZYCeng/dsh-model-visibility
name: TZYCeng/dsh-model-visibility
category: ui            # 模型选择菜单的过滤 + 标注；model 分类留给「接入 provider」的插件
description.en/zh       # 只写功能，逐句要能在源码里对上
icon: https://raw.githubusercontent.com/TZYCeng/dsh-model-visibility/main/docs/icon-180.png   # 必须是位图，SVG 不收
tarball: https://github.com/TZYCeng/dsh-model-visibility/releases/latest/download/dsh-model-visibility.tgz
```

- 首次投稿 PR：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/11149 —— **已合并**（fkysly，2026-11-02，commit `d8fc9be`，「2 checks passed」）。CI 结论（head `13420d6`）：`PR check` 通过（约 11 分钟：`npm ci`、`awesome-lint`、四个 `node --test`、`build-site.mjs`）；`Submission gate` 通过，原文「All 1 submitted entry passes: `dsh.bundle` declared, repo old enough, enough commits.」。
- 1.6.0 发布后同步：条目 `description` 补上「名称 / ID 搜索、按能力（多模态、支持推理）与上下文下限筛选」。合并时用的是 1.6.0 之前的文案，因此另开了补文案的 PR：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/11353（分支 `update/tzyceng-dsh-model-visibility-1.6.0`，从 fork main 同步到 upstream `152f265` 后只改这一个文件）。该 PR 的 CI 在 head `5cc70b8` 上已全绿：`PR check` 通过（`npm ci` → 7 项结构检查 → `awesome-lint` → 四个测试套件 → `build-site.mjs`，2026-11-02T09:48:53Z 起约 18 分钟），`Submission gate` 通过，标题「No new entries; 1 modified」（只改说明，不涉及新条目的年龄/提交数门槛）。等维护者合并；未合并前市场页面显示的仍是 1.5.0 文案。
- 发新版本后：`npm pack` 出的 tgz 以 **不带版本号** 的名字 `dsh-model-visibility.tgz` 传到该 tag 的 Release，`latest/download` 就始终指向最新包，条目文件不用再改。
- `screenshots.json`（放在 `package.json` 旁边）列出 1–8 个仓库内相对路径；市场每晚探测，推自己的仓库即可换图，不用再提 PR。
- `icon-180.png` 由 `icon.svg` 光栅化而来（`icon.svg` 不能被市场当图标）。
- 仓库需要 `dsh-plugin` topic；`dsh.bundle` + `cordis.patch.yml` 是安装的前提，只有 `dsh.client` 会被 CI 拒。
- 1.9.0 起条目说明应覆盖：手动覆盖能力（含写回 Provider 配置）、整组折叠、重新获取能力、名称 / ID 搜索与能力 / 上下文筛选、官方校正、图像放行。改条目后同样要等 `PR check`（约 18 min）+ `Submission gate`。
- 1.9.0 的条目更新 PR：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/11745（分支 `update/tzyceng-dsh-model-visibility-1.9.0`，从 fork main 同步到 upstream `ec0da42` 后只改这一个文件）。CI 全绿（head `95ad000`）：`PR check` 通过（2026-11-03T15:32:24Z 起约 12 分钟，run 41664925071），`Submission gate` 通过，标题「No new entries; 1 modified」；**已合并**，市场页现在显示 1.9.0 文案。
- 截图：`docs/settings-page.png`（设置页全貌）与 `docs/capability-tags.png`（模型行 + 编辑入口），`screenshots.json` 同步；旧的 `model-visibility-*.png` 已删除。

### 10.2 npm

- 作用域名：`@tzyc/dsh-model-visibility`。普通名 `dsh-model-visibility` 已被 `Lzh3070/dsh-model-visibility`（发布者 `phynez_1103`，0.2.1）占用，不能用。
- `package.json`：`name` 用作用域名、去掉 `"private": true`、加 `"publishConfig": { "access": "public" }`（作用域包默认私有，必须显式 public）。
- 发布：`npm whoami` 确认是 `tzyc` → `npm publish`。发布前 `npm test` 全绿，`npm pack --dry-run` 确认文件清单（`test/`、`scripts/`、`.publish/`、`.tools/` 不进包）。
- 安装：`install_bundle target = @tzyc/dsh-model-visibility`。
- 1.9.0 已发布：2026-11-03T15:47:15Z，`shasum 3d2fcaf3d7fbfe607c3e1e88de991092b1569224`，`latest` = `1.9.0`，21 个文件 / 288.2 kB。npm 的 staged publish 会在版本列表里留下一个 `0.0.0-stage` 占位版本（网站标「Temporary package placeholder for staged publishing」），`latest` 仍指向 `1.9.0`，不用处理。
- 1.9.1：修复包名改成作用域后 `client.js` 仍注册 `dsh-model-visibility` 导致的启动报错「loaded without registering "@tzyc/dsh-model-visibility"」；前端注册 id 现在与 `package.json` 的 `name` 一致（见坑 25）。只影响浏览器半，Host 半无需改动。
- 1.10.0：学习快照联网校验（删静态模型目录）、token 用量账本 + 双 CSV 导出、client-src 模块化拆分（`npm run build` 产 bundle，Hygiene 测试守门）。
- 1.10.1：修了一次「渲染冒烟 + handover」排查过程——发现 1.10.0 的 `settings-section` 引用了未定义的局部 `canVerify`；当时的修复不完整，`build-client.mjs` 的 `export function` → `exports.NAME = function NAME` 变换把模块内部对同一函数/常量的裸调用变成了 ReferenceError（真实的 DevTools 报错：`modalityLabel is not defined` → `slot entry crashed in 'settings.section'`）。教训已气化在两处测试上：`client-hygiene` 多了一条「compile 后 bundle 不允许 `exports.NAME = function/class` 形态」的守门。
- 1.10.2：把变换改成「let the module-scope binding stay visible and defer the export assignment」（保留模块内名字可达、exports 指派延后），并补了渲染守门测试。发版记录见下。
- 1.10.0 已发布（2026-11-08）：
- 1.10.1 已发布（2026-11-08）：修复 1.10.0 的 `canVerify` 未定义导致设置页整块空白；npm shasum 见 registry（`npm view @tzyc/dsh-model-visibility@1.10.1 dist.shasum`），GitHub Release `v1.10.1` 双 tarball 就位，`releases/latest/download` 指向 1.10.1。
  - npm 2026-11-08T14:34Z，shasum `813d413bb59e927f6fc4d92a58fc727f89d52ec0`，39 个文件 / 695.4 kB，`latest` = 1.10.0；包含 `client-src/` 15 个模块与 4 个新 lib（usage-ledger / check-catalog / learned-catalog / export-csv）；包内 `client.js` 头两行是构建脚注即正确 builder。
  - GitHub Release `v1.10.0`（tag = `6ca3990`）带 `dsh-model-visibility-1.10.0.tgz` 与不带版本号的 `dsh-model-visibility.tgz`，`releases/latest/download` 指向最新包成立。
  - 发布过程中唯一额外 sweet：`package.json` 的 `files` 补进 `client-src`（否则 tarball 缺源码）。
  - 临时 npmrc 已删除，token 未落入任何提交。
- 1.9.1 已发布：npm 2026-11-04T04:52:17Z，`shasum 1f9a12b8051ee498ed4f1901f4af37e225538ab7`，`latest` = `1.9.1`，21 个文件 / 288.2 kB（包内 `package/client.js` 第 2 行确认是 `id: '@tzyc/dsh-model-visibility'`）；GitHub Release `v1.9.1`（id `433528919`）带 `dsh-model-visibility-1.9.1.tgz` 与不带版本号的 `dsh-model-visibility.tgz`，均 288246 B，`releases/latest/download/dsh-model-visibility.tgz` 回 206。**npm 上的 1.9.0 是坏的（注册 id 仍是旧名），1.9.1 才是第一个能 npm 安装的版本。**
- **npm 2FA / token**：帐号开了 2FA，CLI 直发会 `EOTP` 且 npm 把一次性网页地址打码（`https://www.npmjs.com/auth/cli/****`），自动流程无法走通。两条路：① 我方用户在仓库里手跑 `npm publish`，浏览器完成认证后终端自动继续（若 npm 给出的链接已在输出里打码则弃用）；② 推荐 —— 给一段 **granular token（带 2FA-bypass 勾选的 expiry ≤ 7 天）**，把它写进临时 userconfig（`.publish/npmrc`，gitignore 内）：`npm publish --userconfig .publish/npmrc`，发布后立即删除临时文件；不要覆盖用户自己的 `~/.npmrc`。若 token 失效或用完，向项目组要新的一枚。
- 发布后核对：`npm view @tzyc/dsh-model-visibility version` 与 `npm pack @tzyc/dsh-model-visibility@1.9.0` 后看 `package/cordis.patch.yml` 里的 `name` 是否为作用域名。CDN 传播可能 1–3 分钟，期间 registry 仍回 404，属正常。

---

## 11. 还可以做什么（按价值排序）

1. ~~**搜索 / 按能力筛选**（多模态、支持推理、上下文 ≥ N）~~ —— 1.6.0 已做：名称 / ID 搜索、`多模态` / `支持推理` 开关、上下文下限下拉（128K / 256K / 512K / 1M），见 `client.js` 的 `filteredGroups`。剩下的可做：筛选条件计数、搜索高亮、把筛选写进 URL。
2. **显示价格 / 输出上限**（`defaultMaxTokens` 已有；价格可从 `/api/pricing` 的 ratio 字段来，注意各家中转站口径不同）。
3. **把「当前会话模型」固定在每组顶部**。
4. **一键导出当前可见模型 / 能力表**（JSON / CSV，排查「为什么菜单里没有 X」）。
5. **给能力标签加图例开关 / 紧凑模式**。
6. **记住筛选状态**（目前只存在组件 state，切走再回来会重置）。
7. **把探测结果按 Provider 显示在单独的诊断面板**，而不是塞在分组标题里。

---

## 12. 给下一个 AI 的快速启动

1. 读 `README.md` 的「能力标注从哪里来」和本文第 4、5 节。
2. 确认 `index.js` 的 `ctx.inject(['llm','connection'], ...)` 路由存在；`client.js` 的 `createCatalog` 先走它、失败退回官方目录。
3. 改 UI 只动 `client.js`；改合并逻辑动 `lib/model-info.js`；改探测动 `lib/provider-probe.js`；改目录匹配动 `lib/capability-catalog.js`；改手动覆盖动 `lib/model-overrides.js`；改持久化动 `index.js` 顶部。
4. 任何新字段都要：Host 映射 → 来源标注 → Client 标签 → 中英文字典 → 单测 → 页面验证。
5. 不要为了「合并」把手机同步插件搬进来：它的领域是局域网同步，和这个设置页无关。
6. 生成类模型（image / video / embedding / rerank / audio / classifier / translation）**不要**套用对话模型的推理 / 上下文 / 文本标签。
