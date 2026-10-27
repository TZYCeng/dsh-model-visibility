# HANDOVER — dsh-model-visibility

> 给下一个接手的人 / AI。目标：**不用重新啃 DSH 源码就能继续加功能**。
> 当前版本 **1.3.0**（新增每模型能力标注：推理支持、思考强度、上下文窗口、多模态）。

---

## 1. 这个插件是干什么的

两件事，互相独立：

1. **模型显示开关**：设置 → 模型显示，按 Provider 分组列出全部模型，每个模型一个开关；关闭的模型从聊天输入框的模型菜单里消失。偏好持久化在 Host 设置文档 + `$DSH_HOME/dsh-model-visibility/hidden.json` 影子副本。
2. **模型能力标注（1.3 新增）**：在同一个设置页，每个模型下面标注：
   - 是否支持推理；
   - 思考强度（`reasoningEfforts` 的全部档位 + 默认档位）；
   - 上下文窗口（context window）；
   - 多模态（`inputModalities` 是否包含 `image`）。

它**不接管**输入框的模型座位，因此官方的「模型 / 推理等级」菜单、`dsh-codex-effort-slider`、`dsh-model-effort-defaults` 都能和它共存。

---

## 2. 仓库与运行环境

| 项 | 值 |
| --- | --- |
| 仓库 | `https://github.com/TZYCeng/dsh-model-visibility` |
| 本地目录 | `D:\code\dsh-model-visibility` |
| 安装方式 | profile 里 `link:D:/code/dsh-model-visibility` |
| Host 行 id / 设置命名空间 | `model-visibility` |
| 客户端插件 id | `dsh-model-visibility` |
| 依赖的服务 | Host：`settings`、`llm`、`connection`；Client：`slots`、`locale`、`configForms`、`remote`、`remote.session`、`modelDirectories` |
| 构建 | 无。`client.js` 是手写 ModuleLoader bundle，直接加载 |
| 测试 | `npm test`（Node 内置 test runner） |

profile 里的两处接线（不要改名）：

- `package.json` 的 `dsh.bundle.patch` → `cordis.patch.yml`；
- `cordis.patch.yml` 插入 Host 行 `- id: model-visibility`；
- `package.json` 的 `dsh.client.immediately` 让浏览器半随页面加载。

---

## 3. 文件地图

```
index.js                     Host 半：hidden 持久化 + 影子副本 + /api/dsh-model-visibility/models 路由
lib/model-info.js            Host 能力探针（纯函数 + 缓存），单元测试直接测它
client.js                    浏览器半：设置页 + 目录过滤 + 能力标签
cordis.patch.yml             Host 行声明
locale/zh.json, en.json      插件列表标题/描述
docs/model-visibility-settings-v1.3.png   设置页截图
test/model-info.test.mjs     能力探针单测
package.json                 bundle 清单 / exports / files / npm test
```

### client.js 内部结构（按出现顺序）

| 区块 | 作用 |
| --- | --- |
| `NS`, `ENTRY`, `FIELD`, `SECTION_ID`, `API` | 常量；`API` 是相对 `document.baseURI` 解析出来的路由前缀 |
| `DICT` | 中英文字典，所有 UI 文案；**加文案必须两边都加** |
| `CSS` | 全部样式；颜色只用 `--dsw-alias-*` 主题变量 |
| `keyOf` / `hiddenSetOf` / `providerLabel` / `countModels` | 小工具 |
| `formatContext` / `effortNames` / `defaultEffortName` / `modalityLabel` / `capabilityTags` | **能力标签**：把模型记录变成 `[{key,label,title,tone}]` |
| `createCatalog` | 拉能力目录：先 Host 路由，失败退回官方 `session.modelCatalog()` |
| `patchDirectoryStore` / `installComposerFilter` | 就地改写模型目录 store，实现「隐藏」 |
| `makeSection` | 设置页组件（React） |
| `apply` | 注册字典、样式、设置 section、模型目录过滤 |

### index.js 内部

- `storeFile()` / `readStored()` / `writeStored()`：`hidden.json` 影子副本。
- `RESTORED`：模块加载时读影子副本，作为 `hidden` 的 schema 默认值。
- `apply(ctx, config)`：
  - `settings.configure({ auto: false })` 关闭自动生成的配置页；
  - 监听 `loader/volatile-update` / `settings/document-updated` → `persist()`；
  - `ctx.inject(['llm', 'connection'], ...)` → 注册能力路由 + 缓存失效监听。

---

## 4. 数据流

```
                         ┌──────────────────────────────┐
设置页 (client.js)  ───▶ │ GET /api/dsh-model-visibility/models │
                         └──────────────┬───────────────┘
                                        │ (Host, index.js)
                                        ▼
                         createModelInfoService(ctx.llm)
                                        │
                     listProviders → listModels → resolveModelInfo
                                        │
                                        ▼
                         { groups:[{id,name,models:[…]}], failures:[…] }
                                        │
                         ┌──────────────┴───────────────┐
                         ▼                              ▼
           能力标签（推理/档位/上下文/模态）      开关（hidden 列表）
                                                        │
                                        form.set('hidden', [...]) → 设置文档
                                                        │
                         modelDirectories store 过滤 ◀──┘ → 输入框模型菜单
```

### 能力记录的形状（`lib/model-info.js` 的输出）

```ts
type ModelRecord = {
  id: string
  name: string
  description?: string
  contextWindow?: number          // 正整数 token
  defaultMaxTokens?: number       // 正整数，目前只用于 tooltip
  inputModalities?: string[]      // 例如 ["text","image"]；DSH 当前只认 text/image
  reasoning?: {
    efforts: { id: string, name: string, description?: string }[]
    defaultEffort?: string        // 必须能在 efforts 里找到
  }
  infoError?: string              // resolveModelInfo 失败时存在；其它能力字段缺失
}

type Catalog = {
  groups: { id: string, name: string, models: ModelRecord[] }[]
  failures: { id: string, name: string, message: string }[]
  generatedAt: number
}
```

### 路由合同

- `GET /api/dsh-model-visibility/models` —— 命中 15s 缓存。
- `GET /api/dsh-model-visibility/models?fresh=1` —— 跳过 TTL，但仍合并 in-flight 请求。
- 成功：`200 { "ok": true, "value": Catalog }`
- 失败：`500 { "ok": false, "error": { code: "model-info/failed", message } }`
- 路由通过 `ctx.connection.fetch.register` 注册，走 DSH 的同源认证（owner peer），**不要**改成裸 `http.Server`。

---

## 5. 关键决策 & 为什么

1. **为什么 Host 端要新开路由，而不是直接用 `session.modelCatalog`？**
   官方投影（`dsh-api-session-controller/lib/types/catalog.js`）只保留
   `{ id, name, description?, reasoning }`，**丢掉了 context 和 inputModalities**。
   要显示这两项必须回到 `ctx.llm.resolveModelInfo`，而客户端 Remote 没有暴露它。
   `connection.fetch` 是 DSH 给插件开的、带认证的同源 HTTP 通道（`dsh-mobile-sync` 也用它）。

2. **为什么不改官方目录？**
   改官方包会污染升级路径，而且官方目录每次加载都要重算，插件没必要改它。我们只读。

3. **为什么 `resolveModelInfo` 失败不丢掉模型？**
   开关必须始终可用。失败记录 `infoError`，页面显示「推理未知 / 上下文未知 / 模态未知」，悬停能看到原始错误。

4. **为什么缓存 15s？**
   一个 Provider 可能有几十个模型，每次 `resolveModelInfo` 都可能访问适配器/网络。页面打开、切换 section、隐藏模型都会触发刷新；缓存防止把设置写入放大成一次全量探测。`llm/adapters-updated` 用 fresh 读，保证路由变化能立刻反映。

5. **为什么 `settings/document-updated` 用普通读（不 fresh）？**
   「隐藏一个模型」本身就会写设置文档；如果 fresh 读，每次点开关都全量重探。普通读让这次写入命中缓存。

6. **关于「合并 dsh-mobile-sync」。**
   已核对 `D:\code\dsh-android-Conversation sync`（package name `dsh-mobile-sync`）、它的 git 历史和全部源码：它是**手机同步**插件（会话/插件/技能/模型组经局域网同步到 Android），**没有**任何读取 `reasoningEffort` 的代码。因此没有从它合并代码；需求中的能力直接实现在本插件。若你实际想合并的是别的插件（例如 `dsh-model-effort-defaults`、`dsh-effort-sync`），它们的扩展点是「往 `llm-pi-ai` 设置写 `reasoningEfforts`」或「从供应商 `/v1/models` 同步档位」——那属于 Host 配置写入，和本页面的只读展示可以共存，不需要改这里的代码。

---

## 6. 加新功能：照着做

### 6.1 给模型多标一项（例：输出上限 `defaultMaxTokens`）

1. **Host**：`lib/model-info.js` 的 `describeResolvedModel` 已经带出 `defaultMaxTokens`，无需改（如果字段不在 `info` 里，先在这里加映射）。
2. **Client**：`capabilityTags` 里加一个 tag：
   ```js
   const maxOut = Number.isFinite(model.defaultMaxTokens) ? formatContext(model.defaultMaxTokens) : null
   tags.push({ key: 'output', tone: maxOut ? 'neutral' : 'muted', label: t('tag.output') + ' ' + (maxOut ?? t('tag.unknown')), title: ... })
   ```
3. **字典**：`DICT.zh` / `DICT.en` 各加 `'tag.output'`。
4. 跑 `npm test` + 页面 `Ctrl+R` 看效果。

### 6.2 加筛选 / 搜索 / 排序

`makeSection` 里已经有 `groups`、`hidden`、`state`。推荐：

- 新增 `const [query, setQuery] = useState('')`；
- 在 `for (const group of groups)` 之前派生 `visibleGroups`：按 `model.name/id` 过滤、按 `reasoning`/`inputModalities` 筛选；
- 只改渲染，不要改 `hidden` 的语义（隐藏仍然是持久化偏好，不是筛选条件）。

### 6.3 加一个「只看多模态」快捷筛选

同上，用 `Array.isArray(model.inputModalities) && model.inputModalities.includes('image')`。**注意**：`inputModalities` 缺失表示「未知」，不是「纯文本」；纯文本是 `["text"]`。

### 6.4 新增一个 Host 能力（例：价格）

1. 在 `lib/model-info.js` 里扩 `describeResolvedModel`（数据必须来自 `ctx.llm` 或其它 Host 服务）；
2. 在 `index.js` 的 `ctx.inject([...])` 里把新服务加进依赖数组；
3. 不要改路由路径，客户端会自动拿到新字段；
4. 单测补一个字段断言。

### 6.5 合并另一个插件的 UI / 功能

- **Host 逻辑**：放到 `lib/`，由 `index.js` 调用；不要和 `apply` 里的持久化耦合。
- **Client 逻辑**：新文件不会被 ModuleLoader 自动加载；要么写进 `client.js`，要么在 `package.json` 的 `dsh.client` 里新增入口（需要确认 DSH 的 client bundle 加载约定）。
- **命名空间**：本插件只拥有 `model-visibility`。要复用别人的设置命名空间，走 `ctx.configForms.get('other-ns')`，不要改本插件的 `ENTRY`。

---

## 7. 改动 / 调试流程（重要）

### 只改 `client.js`
- 页面 `Ctrl+R` 即可。浏览器半不经过构建。
- 打开 设置 → 模型显示 验证。

### 改 `index.js` / `lib/`
Host 半在 DSH 启动时加载，**改完必须让 Host 重新加载**：
1. 正常方式：重启 DSH（会中断当前会话，但最可靠）。
2. 开发方式（桌面版）：让 profile 重新组合。HMR 会在下一次 profile 重组时替换「磁盘上已改动的已链接包」。
   - 可以改一下 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`（例如加一行注释）触发，**验证完把注释删掉**；
   - 不要用「禁用/启用插件」来指望重载代码：HMR 可能复用旧模块生成。
3. 验证新路由是否生效：设置页顶部不应再出现「模型能力信息暂不可用」；模型的「上下文」不再是「未知」。

### 看日志
Host 的 `console` 输出在 DSH 桌面进程里；没有独立日志文件。调试优先用单测 + `host-smoke` 式的假 ctx 脚本（见 `test/` 思路），不要在生产窗口里反复试错。

---

## 8. 坑（踩过的）

1. **`client.js` 不是普通 ESM**：文件开头是 `window.__ModuleLoader__.load({ id, factory(require){...} })`，`require('react')` 由外壳提供。不要加 `import`，不要用 JSX，不要打包。
2. **`key` 是 `provider/model` 的拼接**：model id 里可能含 `/`（如 `opencode/deepseek/...`），所以永远用 `keyOf(group.id, model.id)` 生成，不要 split 回来。
3. **不要替换 store 对象**：官方座位可能已经捕获了同一个 store；只能就地改 `getSnapshot` / `subscribe`（`patchDirectoryStore` 已处理捕获与恢复）。
4. **`connection.fetch` 路由的 query 不参与匹配**：`?fresh=1` 安全；匹配只看 `pathname`。
5. **`resolveModelInfo` 可能很慢**：串行会慢，`Promise.all` 并发；缓存不要去掉。
6. **模态只有 `text` / `image`**（DSH 当前 `MODEL_MODALITIES`）。不要硬编码别的值，未知值原样透传。
7. **`color-mix` 需要 fallback**：CSS 里先写 `background: transparent` 再写 `background: color-mix(...)`，老内核不会整条失效。
8. **中英文案**：`DICT` 只注册了一次；漏加 key 时 `t(key)` 会返回 key 本身（`modalityLabel` 依赖这个行为判断未知模态）。
9. **能力标签不改变可见性**：`hidden` 只由开关写入；筛选/标签不能顺手改 `hidden`。
10. **设置写入会触发 `settings/document-updated`**：不要在该事件里做 fresh 全量探测（见决策 5）。
11. **`settings.configure({ auto: false })`**：不要删；否则设置里会多出一个自动生成的配置页。
12. **`hidden.json` 是全局的**：多 profile 共用；测试时不要拿它当 profile 级状态。

---

## 9. 测试清单（发版前）

```powershell
cd D:\code\dsh-model-visibility
npm test
```

手工：

- [ ] 设置 → 模型显示：页面标题/描述/图例正常，模型按 Provider 分组。
- [ ] 每个模型都有能力标签；`支持推理` 与 `不支持推理` 都出现过（例：`gpt-image-2` 不支持推理）。
- [ ] `多模态` 出现在带 image 的模型上（例：`DeepSeek-V4.1-Flash`），纯文本模型显示 `纯文本`。
- [ ] 上下文显示 `1M` / `262.1K` 等；悬停有精确 token 数。
- [ ] 点一个开关：计数立即变化，设置文档 `cordis.patch.yml` 的 `hidden` 更新，刷新后仍保留。
- [ ] 输入框模型菜单：被关闭的模型不出现；当前会话的模型即使被关闭仍显示。
- [ ] （改 Host 后）页面顶部没有「模型能力信息暂不可用」的黄色提示。
- [ ] 英文界面（切换 DSH 语言）文案完整。

---

## 10. 发布

```powershell
cd D:\code\dsh-model-visibility
git add -A
git commit -m "feat: per-model capability tags (reasoning, effort, context, modalities)"
git push origin main
```

- 版本号在 `package.json`；当前 `1.3.0`。
- `files` 已包含 `lib`；测试目录不进包。
- 如果改了设置页外观，重新截一张 `docs/model-visibility-settings-v1.3.png`（crop 到设置弹窗即可）。

---

## 11. 还可以做什么（按价值排序）

1. **搜索 / 按能力筛选**（多模态、支持推理、上下文 ≥ N）——模型 90+ 时最实用。
2. **显示输出上限 / 价格**（`defaultMaxTokens` 已有；价格要从适配器 `imageRequestPricing` 或自建表来）。
3. **把「当前会话模型」固定在每组顶部**，避免在长列表里找。
4. **一键导出当前可见模型列表**（方便排查「为什么菜单里没有 X」）。
5. **显示模型的 `description`**（Host 已返回，当前只放在 title 里）。
6. **给能力标签加图例开关 / 紧凑模式**（模型很多时降低视觉噪音）。

---

## 12. 给下一个 AI 的快速启动

1. 读 `README.md` 的「能力标注从哪里来」和本文第 4、5 节。
2. 确认 `index.js` 的 `ctx.inject(['llm','connection'], ...)` 路由存在；`client.js` 的 `createCatalog` 先走它、失败退回官方目录。
3. 改 UI 只动 `client.js`，改数据只动 `lib/model-info.js`，改持久化只动 `index.js` 顶部。
4. 任何新字段都要：Host 映射 → Client 标签 → 中英文字典 → 单测 → 页面验证。
5. 不要为了「合并」把手机同步插件搬进来：它的领域是局域网同步，和这个设置页无关；先确认需求到底要哪个能力。
