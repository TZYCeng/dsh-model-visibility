# HANDOVER — dsh-model-visibility

> 给下一个接手的人 / AI。目标：**不用重新啃 DSH 源码就能继续加功能**。
> 当前版本 **1.4.0**（真实能力探测 + 生成类模型标注）。

---

## 1. 这个插件是干什么的

三件事，互相独立：

1. **模型显示开关**：设置 → 模型显示，按 Provider 分组列出全部模型，每个模型一个开关；关闭的模型从聊天输入框的模型菜单里消失。偏好持久化在 Host 设置文档 + `$DSH_HOME/dsh-model-visibility/hidden.json` 影子副本。
2. **真实能力标注**：在同一个设置页，每个模型下面标注：
   - 是否支持推理、思考强度档位；
   - 上下文窗口；
   - 输入 / 输出模态；
   - 模型类型：对话 / 生图 / 生视频 / 嵌入 / 重排 / 音频 / 审核 / 翻译。
3. **区分声明与补全**：每个字段带 `sources`；实线标签 = 适配器或中转站声明，虚线标签 = 内置目录或模型名推断。生成类模型只显示类型 / 分辨率等真正相关的标签。

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
| 构建 | 无。`client.js` 是手写 ModuleLoader bundle，直接加载 |
| 测试 | `npm test`（Node 内置 test runner） |

profile 里的接线（不要改名）：

- `package.json` 的 `dsh.bundle.patch` → `cordis.patch.yml`；
- `cordis.patch.yml` 插入 Host 行 `- id: model-visibility`；
- `package.json` 的 `dsh.client.immediately` 让浏览器半随页面加载。

---

## 3. 文件地图

```
index.js                     Host 半：hidden 持久化 + 影子副本 + /api/dsh-model-visibility/models 路由
lib/model-info.js            Host 能力合并（纯函数 + 缓存），单元测试直接测它
lib/provider-probe.js        Host 中转站探测：读配置、解凭据、GET /models 与 /api/pricing
lib/capability-catalog.js    目录匹配 + 模型类型 / 家族模态启发式
lib/model-catalog.js         由 scripts/build-catalog.mjs 生成的 models.dev 快照（勿手改）
scripts/build-catalog.mjs    重新生成目录
client.js                    浏览器半：设置页 + 筛选 + 能力标签 + 目录过滤
cordis.patch.yml             Host 行声明
locale/zh.json, en.json      插件列表标题/描述
docs/*.png                   设置页截图（v1.3；v1.4 截图因沙箱 ACL 暂未落盘）
test/model-info.test.mjs     能力合并 / 缓存旧测试
test/capability.test.mjs     目录匹配、启发式、证据优先级
test/provider-probe.test.mjs 配置读取、listing / pricing 解析、凭据、缓存、诊断
package.json                 bundle 清单 / exports / files / npm test
```

### client.js 内部结构（按出现顺序）

| 区块 | 作用 |
| --- | --- |
| `NS`, `ENTRY`, `FIELD`, `SECTION_ID`, `API` | 常量；`API` 是相对 `document.baseURI` 解析出来的路由前缀 |
| `DICT` | 中英文字典，所有 UI 文案；**加文案必须两边都加** |
| `CSS` | 全部样式；颜色只用 `--dsw-alias-*` 主题变量 |
| `keyOf` / `hiddenSetOf` / `providerLabel` / `countModels` | 小工具 |
| `formatContext` / `effortNames` / `defaultEffortName` / `modalityLabel` / `sourceLabel` / `sourceOf` / `isInferredSource` / `kindOf` / `bucketOf` / `isGenerationKind` / `resolutionOf` / `modalityNames` | 能力标签工具 |
| `generationTags` / `capabilityTags` | 生图 / 生视频等只标类型；对话模型标推理 / 上下文 / 模态，并带来源 |
| `createCatalog` | 拉能力目录：先 Host 路由，失败退回官方 `session.modelCatalog()`；保存 `groups/failures/providers/catalog` |
| `patchDirectoryStore` / `installComposerFilter` | 就地改写模型目录 store，实现「隐藏」 |
| `countKinds` / `probeOf` / `tagClassOf` / `makeSection` | 设置页组件（React） |
| `apply` | 注册字典、样式、设置 section、模型目录过滤 |

### index.js 内部

- `storeFile()` / `readStored()` / `writeStored()`：`hidden.json` 影子副本。
- `RESTORED`：模块加载时读影子副本，作为 `hidden` 的 schema 默认值。
- `Config.probe`：是否探测中转站（默认 true；可用 `MODEL_VISIBILITY_PROBE=0` 关闭）。
- `apply(ctx, config)`：
  - `settings.configure({ auto: false })` 关闭自动生成的配置页；
  - 监听 `loader/volatile-update` / `settings/document-updated` → `persist()`；
  - `ctx.inject(['llm', 'connection'], ...)` → 可选 `scope.get('settings')` / `scope.get('credentials')`，构造 `createProviderProbe` 与 `createModelInfoService`，注册能力路由；
  - `llm/adapters-updated` / 凭据事件 → 清能力 + 探测缓存；
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
  lib/model-info.js::mergeCapabilities  ◀── profiles + discovered + diagnostics
         │
         │  config > adapter > provider > catalog > inferred > unknown
         ▼
  { groups, failures, providers, catalog, generatedAt }

浏览器：
  能力标签（实线 / 虚线）        开关（hidden 列表）
        │                              │
        └──────────┬───────────────────┘
                   ▼
   modelDirectories store 过滤 → 输入框模型菜单
```

### 能力记录的形状（`lib/model-info.js` 的输出）

```ts
type ModelRecord = {
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
    kind: 'config' | 'adapter' | 'provider' | 'catalog' | 'inferred' | 'unknown'
    modalities: 同上
    context: 同上
    reasoning: 同上
  }
  catalog?: { id: string; provider?: string; generatedAt?: string }
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
  catalog: { generatedAt: string | null; piAiVersion: string | null; models: number }
  generatedAt: number
}
```

### 路由合同

- `GET /api/dsh-model-visibility/models` —— 命中 15 s 能力缓存；探测结果另有 10 min 缓存。
- `GET /api/dsh-model-visibility/models?fresh=1` —— 跳过两层 TTL，但仍合并 in-flight 请求。
- 成功：`200 { "ok": true, "value": Catalog }`
- 失败：`500 { "ok": false, "error": { code: "model-info/failed", message } }`
- 路由通过 `ctx.connection.fetch.register` 注册，走 DSH 的同源认证（owner peer），**不要**改成裸 `http.Server`。

---

## 5. 关键决策 & 为什么

1. **为什么不直接把 Provider 的 `input: []` 改成真实值？**
   改用户配置会污染升级路径，而且中转站模型会变；本插件只读。页面显示真实能力，但请求路由仍由用户配置决定。若用户想要请求层也支持图像，应自行把 `input` 改成 `["text","image"]`（或让中转站声明）。
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
3. 验证新路由是否生效：设置页底部出现「中转站探测：…」和「内置目录：…」；Grok / Claude 显示真实上下文与多模态；生图行只显示 `生图`。
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
6. **DSH 的模态只有 `text` / `image`**：不要硬编码别的值，未知值原样透传；视频 / 音频只用于展示。
7. **`color-mix` 需要 fallback**：CSS 里先写 `background: transparent` 再写 `background: color-mix(...)`。
8. **中英文案**：`DICT` 只注册了一次；漏加 key 时 `t(key)` 会返回 key 本身。
9. **能力标签不改变可见性**：`hidden` 只由开关写入；筛选 / 标签不能顺手改 `hidden`。
10. **设置写入会触发 `settings/document-updated`**：不要在该事件里做 fresh 全量探测（见决策 7）。
11. **`settings.configure({ auto: false })`**：不要删；否则设置里会多出一个自动生成的配置页。
12. **`hidden.json` 是全局的**：多 profile 共用；测试时不要拿它当 profile 级状态。
13. **凭据只在 Host 解析**：不要把 `apiKeyEnv` 的值、请求头或 baseURL 全文塞进路由响应 / 日志 / 诊断。
14. **探测请求不要跟随重定向**：否则 `Authorization` 可能被带到别的域。`getJson` 用 `redirect: 'error'`。
15. **`defaultInput: [text]` 不是事实**：任何 `mergeCapabilities` 改动都要保住「profile 存在 + 模型未显式声明 input → 不把 adapter 的 text 当纯文本」这条规则。
16. **目录 key 会碰撞**：`gpt-5.1` 与 `gpt-5-1`、`glm-5.3` 与 `glm-5p3` 在快照里可能是两条；`modelIdVariants` 只做保守归一化，不要加过于激进的折叠。
17. **中转站 `/api/pricing` 很常见是 403**：这是正常状态，诊断记为 `disabled`，不是错误。
18. **`docs/` 目录在部分 Windows 环境被 Low integrity + NW 标记**：常规进程无法新建文件（截图落盘会 Access denied）。需要的话用管理员/低完整性进程处理，不要为了截图改 ACL。

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
- [ ] `TianJi` 组里 `glm-5.3`、`grok-4.7`、`claude-fable-5`、`gemini-3.8-flash` 显示 `多模态`，上下文是 `1M / 500K` 而不是统一的 `262.1K`。
- [ ] `minimax-m3.1-flash` 这类目录里没有的模型显示 `上下文 未知 / 模态未知`，而不是错误的 `纯文本`。
- [ ] 生图行只显示 `生图` + 可选 `4K` / `可改图`，没有 `支持推理`、`思考强度`、`上下文`。
- [ ] 生视频行只显示 `生视频`。
- [ ] 嵌入 / 翻译 / 审核行只显示类型。
- [ ] 虚线标签悬停能看到「来源：内置模型目录 / 模型名推断」。
- [ ] 分组标题旁显示 `中转站 n 个模型 · m 个带能力字段`；悬停能看到 status / pricing。
- [ ] 筛选 `生图` 只留生图行；此时分组按钮显示「显示/隐藏筛选结果」。
- [ ] 点一个开关：计数立即变化，设置文档 `cordis.patch.yml` 的 `hidden` 更新，刷新后仍保留。
- [ ] 输入框模型菜单：被关闭的模型不出现；当前会话的模型即使被关闭仍显示。
- [ ] （改 Host 后）页面底部有「中转站探测」和「内置目录」两行。
- [ ] 英文界面（切换 DSH 语言）文案完整。

---

## 10. 发布

```powershell
cd D:\\code\\dsh-model-visibility
git add -A
git commit -m "feat: real capability sources, relay probe, generation model tags"
git push origin main
```

- 版本号在 `package.json`；当前 `1.4.0`。
- `files` 已包含 `lib`；`scripts` / `test` / `.tools` 不进包。
- `docs/` 旧截图仍保留；如果重新截图，先确认目录可写（见坑 18）。

---

## 11. 还可以做什么（按价值排序）

1. **搜索 / 按能力筛选**（多模态、支持推理、上下文 ≥ N）。
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
3. 改 UI 只动 `client.js`；改合并逻辑动 `lib/model-info.js`；改探测动 `lib/provider-probe.js`；改目录匹配动 `lib/capability-catalog.js`；改持久化动 `index.js` 顶部。
4. 任何新字段都要：Host 映射 → 来源标注 → Client 标签 → 中英文字典 → 单测 → 页面验证。
5. 不要为了「合并」把手机同步插件搬进来：它的领域是局域网同步，和这个设置页无关。
6. 生成类模型（image / video / embedding / rerank / audio / classifier / translation）**不要**套用对话模型的推理 / 上下文 / 文本标签。
