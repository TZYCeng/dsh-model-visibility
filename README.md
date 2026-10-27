# dsh-model-visibility

在 DeepSeek Harness 的设置里管理「哪些模型出现在聊天输入框的模型菜单中」，按 Provider 分组一键显示/隐藏，并在**每个模型**下面标注它的真实能力：是否支持推理、思考强度档位、上下文窗口、输入/输出模态，以及它是对话模型还是生图 / 生视频 / 嵌入 / 重排 / 音频 / 审核 / 翻译模型。

一个 DSH bundle 插件：Host 端负责持久化偏好、读取 Provider 配置、探测中转站模型列表，并把能力目录投影给浏览器；浏览器端过滤模型目录并渲染设置页。它**不接管**输入框的模型座位，因此官方的「模型 / 推理等级」两级菜单、推理等级调整，以及像 `dsh-codex-effort-slider` 那样改造这一行的插件都保持可用。

## 为什么需要它

DSH 官方的 `session.modelCatalog` 只把模型 id / 名称 / 推理档位投影给浏览器，**没有**上下文窗口、输入模态和输出类型。自定义中转站通常这样配置：

```yaml
yujianwudi:
  api: openai-completions
  baseURL: https://example.net/v1
  defaultInput: [text]
  models:
    - id: grok-4.7
      input: []          # 不是“纯文本”，只是“没声明”
```

于是 registry 会把 `defaultInput: [text]` 当成模型能力，Grok / Claude / GPT / Gemini 全部显示成「纯文本」。本插件不再把这种默认值当成事实：它读取真实的中转站模型列表、用内置模型目录补全，并把「适配器声明」和「补全值」在 UI 上区分开。

## 功能

- **设置 → 模型显示**：按 Provider 分组列出全部模型，每个模型一个开关；关闭的模型立即从对话菜单中消失。
- **能力标签（按可信度分层）**：
  - `支持推理` / `不支持推理` / `推理未知`，以及适配器公布的全部思考强度档位（默认档位在悬停提示里）；
  - `上下文 1M` / `上下文 200K`（悬停显示精确 token 数与来源）；
  - `多模态` / `纯文本` / `模态未知`（输入模态）；
  - `生图`、`生视频`、`嵌入`、`重排`、`音频`、`审核`、`翻译`：生成类 / 非对话模型单独标记。
- **来源可见**：实线标签来自适配器或中转站；虚线标签来自内置模型目录或模型名推断。悬停任一标签可看到「来源：适配器配置 / 中转站模型列表 / 内置模型目录 / 模型名推断」。
- **生成类模型只标类型**：生图 / 生视频 / 嵌入等模型不再显示推理档位、上下文或「纯文本」，只显示 `生图`、`分辨率 4K`、`可改图` 这类真正相关的信息。
- **筛选**：顶部有 `全部 / 对话 / 生图 / 生视频 / 其它` 快捷筛选，每个按钮带数量。
- **分组汇总**：每组标题显示 `已显示/总数`、`对话 n · 生图 n · 生视频 n · 其它 n`，以及中转站探测结果（读到了多少模型、多少公布能力字段，未公布会明确写出来）。
- **分组一键开关**：每组标题右侧是「全组隐藏 / 全组显示」；筛选状态下按钮只作用于当前筛选结果。
- **对话菜单只显示开启的模型**：隐藏模型连同变空的分组一起消失；当前会话正在使用的模型即使被关闭也会保留，因为收起态按钮靠这份目录显示模型名。
- **偏好落在 Host 设置文档**：写入 profile 的 `cordis.patch.yml`（`- id: model-visibility → hidden: [...]`），刷新、重启、切换会话都保留，不依赖浏览器本地存储。
- **设置不会因为插件重装/配置层重建而丢失**：Host 端额外把同一份列表镜像到 `$DSH_HOME/dsh-model-visibility/hidden.json`，并用它给 `hidden` 的 schema 默认值播种。详见「持久化」。

## 安装

```powershell
# 目录方式（开发）：profile 里 link 这个目录
# 用 plugin_manager 安装：
#   install_bundle   target = D:\\code\\dsh-model-visibility
```

本地链接安装需要目录里有依赖：

```powershell
npm install
```

安装后刷新页面（或重启 DSH）即可看到「设置 → 模型显示」。

## 能力标注从哪里来

答案按下面的优先级合并。每一层只填前一层不知道的字段，最终记录里带 `sources`，页面据此决定实线 / 虚线。

| 优先级 | 来源 | 什么时候可信 | 页面标记 |
| --- | --- | --- | --- |
| 1 | `config` | 设置文档里该模型显式写了 `input`、`contextWindow`、`maxTokens`，或 Provider 的 `defaultInput` 显式包含非文本模态 | 实线 |
| 2 | `adapter` | 适配器不是从中转站配置（内置目录），或该模型不在 Provider 的 `models` 列表里 | 实线 |
| 3 | `provider` | 中转站自己的 `GET {baseURL}/models` 返回了 `architecture.input_modalities` / `input_modalities` / `capabilities` / `type` / `supported_endpoint_types` 等字段 | 实线 |
| 4 | `catalog` | 内置 pi-ai / models.dev 快照里有同名模型（会规范化 `openai/`、`~`、`:free`、`-4k` 等前缀后缀） | 虚线 |
| 5 | `inferred` | 模型名明确带家族特征（`claude` / `gpt-4o+` / `gemini` / `grok-4+` / `vl` / `vision` / `image` / `video` / `embed` …） | 虚线 |
| — | `unknown` | 以上都没有：显示「未知」，**不会**把中转站的 `defaultInput: [text]` 当成纯文本 | 灰色 |

### 中转站探测

Host 端通过 `settings.describe()` 读取配置了 `baseURL` 与 `apiKeyEnv` 的 Provider，然后：

1. 用 `ctx.credentials.resolve(apiKeyEnv)` 在**每次探测时**解析密钥（不缓存、不写入、不返回给浏览器）；
2. `GET {baseURL}/models`（base 不带 `/v1` 时再补一次 `/v1/models`），带 `Authorization: Bearer` 或 Anthropic 的 `x-api-key`；
3. 同源尝试 `GET {origin}/api/pricing`（New API 的公开价格接口），读取 `supported_endpoint_types` 来判断生图 / 生视频 / 嵌入；
4. 只保留能力事实（模态、上下文、最大输出、推理、类型），不保留响应正文；失败只记录诊断。

安全约束：不跟随重定向（避免把 `Authorization` 带到别的域）、4 MB 响应上限、每请求 3.5 s 超时、Provider 并发探测、结果缓存 10 分钟。关闭探测：设置行里 `probe: false`，或环境变量 `MODEL_VISIBILITY_PROBE=0`。

### 内置模型目录

`lib/model-catalog.js` 是从当前安装的 `@earendil-works/pi-ai`（models.dev 数据，2026-10-07 快照）蒸馏出的紧凑表：**652 个模型**，包含 `type`（chat / image / classifier）、`input` / `output` 模态、`reasoning`、`contextWindow`、`maxTokens`。重新生成：

```powershell
# 先从桌面安装包里提取 pi-ai 数据（只需做一次）
node .tools/asar.mjs extract "<DeepSeek Harness>/resources/app.asar" `
  "dsh/node_modules/@earendil-works/pi-ai" ".tools/extract/pi-ai"

# 生成 lib/model-catalog.js
node scripts/build-catalog.mjs --data .tools/extract/pi-ai
```

也可以把 `--data` 指向任何 pi-ai 包根目录或它的 `dist/providers/data`。内置目录只补缺，**不会覆盖**适配器或中转站明确声明的事实。

### 路由

```
GET /api/dsh-model-visibility/models[?fresh=1]
```

Host 端遍历 `ctx.llm.listProviders()` → `listModels()` → `resolveModelInfo()`，再叠加设置文档里的 Provider 配置与中转站探测结果，返回：

```jsonc
{
  "ok": true,
  "value": {
    "groups": [{
      "id": "yujianwudi",
      "name": "TianJi",
      "models": [{
        "id": "grok-4.7",
        "name": "grok-4.7",
        "kind": "chat",
        "inputModalities": ["text", "image"],
        "contextWindow": 500000,
        "reasoning": { "efforts": [...], "defaultEffort": "medium" },
        "reasoningSupported": true,
        "sources": { "kind": "catalog", "modalities": "catalog", "context": "catalog", "reasoning": "config" },
        "catalog": { "id": "grok-4.7", "provider": "xai", "generatedAt": "..." }
      }]
    }],
    "failures": [],
    "providers": [{ "id": "yujianwudi", "status": "ok", "models": 58, "capabilities": 14 }],
    "catalog": { "generatedAt": "2026-10-07T22:01:28.515Z", "piAiVersion": "1.1.0", "models": 652 }
  }
}
```

`?fresh=1` 绕过两层缓存（能力快照 15 s、中转站探测 10 min），用于页面「刷新」按钮与 `llm/adapters-updated`。浏览器端优先走这条路由；如果 Host 半还没加载（例如刚升级插件但页面还是旧 Host），会自动退回官方 `session.modelCatalog()`，页面顶部显示「模型能力信息暂不可用」。

## 结构

| 文件 | 作用 |
| --- | --- |
| `package.json` | bundle 清单、`dsh.client` 声明、`./locale/*.json` 与 `./icon` 导出；含 `npm test` |
| `cordis.patch.yml` | 插入 Host 行 `model-visibility` |
| `index.js` | Host 端：`hidden` 持久化 + 影子副本 + 能力路由 + 探测缓存失效 |
| `lib/model-info.js` | 能力合并：证据优先级、`describeCatalog`、15 s 缓存 |
| `lib/provider-probe.js` | 读取 Provider 配置、解析凭据、探测中转站、10 min 缓存与诊断 |
| `lib/capability-catalog.js` | 内置目录匹配、模型类型与家族模态启发式 |
| `lib/model-catalog.js` | 由脚本生成的 models.dev 快照（勿手改） |
| `scripts/build-catalog.mjs` | 从 pi-ai 数据重新生成 `lib/model-catalog.js` |
| `client.js` | 浏览器端：设置页、筛选、能力标签、就地包装模型目录 store |
| `locale/*.json` | 插件列表里的标题与描述 |
| `test/*.test.mjs` | 能力合并、目录匹配、探测解析与缓存的单元测试 |
| `icon.svg` | 插件列表图标 |

## 实现要点

### 过滤模型

- 不注册 `conversation.input.model` 座位：官方选择器仍是唯一占位者。过滤发生在会话目录的 store 上——`getSnapshot()` / `subscribe()` 被**就地**替换成过滤版本，因为官方座位可能在本插件加载前就捕获了同一个 store 对象，替换对象本身够不到它。
- 目录来自共享的 `modelDirectories.directoryFor(sessionId)`；插件同时包装该方法，让之后新建的目录也走同一套 store 补丁。
- 隐藏项用 `provider/model` 字符串作为不透明 key，Set 化后同时用于设置页与过滤。
- 设置页的读写走 `ctx.configForms.get('model-visibility')`，与 Host 设置文档保持同一 revision；写入失败会在页面上提示。

### 能力合并

- `describeResolvedModel` 只负责把 `resolveModelInfo()` 的结果变成纯对象；真正的合并发生在 `mergeCapabilities`（纯函数，单测直接覆盖）。
- `profile.models` 里为空数组的 `input` 被视为「未声明」，而不是「仅文本」。只有显式写了非空 `input`，或 `defaultInput` 明确包含非文本模态时，才把模态记为 `config`。
- 上下文窗口同理：中转站的 `defaultContextWindow: 262144` 是 DSH 默认值，不当事实使用；目录里有 500K / 1M 就用目录值。
- 模型类型优先取中转站返回的 `type` / `supported_endpoint_types`，其次取内置目录的 `type`，最后用模型名关键词判断；`生图 / 生视频 / 嵌入 / 重排 / 音频 / 审核 / 翻译` 会走 `generationTags`，不显示推理档位与文本标签。
- 所有字段都是可选的；不知道就显示未知，不猜。

### 缓存与失效

- 能力快照 TTL 15 s，`?fresh=1` 绕过；并发的页面读共享同一个 in-flight Promise。
- 中转站探测 TTL 10 min；`?fresh=1` 也会强制重探。
- `llm/adapters-updated`、`credentials/record-updated`、`credentials/reference-updated`：能力缓存与探测缓存一起失效。
- `settings/document-updated`：能力缓存失效，但探测缓存只在 Provider 路由指纹（id / baseURL / apiKeyEnv / 模型 id 集合）真的变化时才失效。因此「隐藏一个模型」不会触发网络探测。

## 持久化

`cordis.patch.yml` 是「用户覆盖层」，DSH 会整层重建它：

- profile 自愈（`sanitizeProfile`）会把整份 patch 改名成 `.bak-<ts>` 后从空文件重来；
- 插件重装 / 升级会重置该行的 `config`；
- 设置写入时若新值等于继承值（例如隐藏列表为空），DSH 会直接删掉这一行。

任何一种发生，`hidden` 都会退回默认值 `[]`，表现出来就是「插件重新加载后所有模型又都显示了」。

所以 Host 端做了两件事：

1. **镜像**：每次 `hidden` 变化（`loader/volatile-update` / `settings/document-updated`）都原子写入
   `$DSH_HOME/dsh-model-visibility/hidden.json`；插件加载和卸载时各同步一次。
2. **恢复**：`hidden` 的 schema 默认值在模块加载时从该文件读取，所以 patch 层被清空后，
   插件重新加载得到的是上次的列表而不是空列表。

存储文件缺失或损坏时按空列表处理，行为与之前一致；需要重置时删掉该文件即可。
文件是全局的（不按 profile 区分），多个 profile 共用同一份隐藏列表。

## 测试

```powershell
npm test
```

覆盖：证据优先级、默认文本不被当成事实、中转站探测解析（OpenRouter / pi-ai / New API 三种 dialects）、凭据缺失与 401、`/v1/models` 回退、缓存 TTL / `fresh` / 设置变化只失效必要缓存、模型类型与家族模态、目录别名匹配、推理档位清洗。

GUI 冒烟测试（改完代码后）：

1. 改 `client.js` → 页面 `Ctrl+R`，打开 设置 → 模型显示，确认标签、筛选、虚线来源、生图 / 生视频行。
2. 改 `index.js` / `lib` → 需要 Host 重载：重启 DSH，或让 profile 重新组合（桌面版 HMR 会在下一次 profile 重组时替换已改动的已链接包）。
3. 重载后确认页面底部出现「中转站探测：…」和「内置目录：…」两行，且 Grok / Claude / GPT / Gemini 显示真实上下文与多模态。
4. 打开对话输入框的模型菜单，确认被关闭的模型没有出现、当前模型仍显示。

## 已知限制

- **内置目录是快照**：`lib/model-catalog.js` 生成于 2026-10-07，之后新增的模型要靠中转站探测或模型名推断；用 `scripts/build-catalog.mjs` 可以随时重新生成。
- **中转站不一定公布能力**：多数中转站的 `/v1/models` 只有 id；New API 的 `/api/pricing` 经常被关闭（403）。这时只能靠内置目录和模型名家族规则。
- **模型名推断是保守的**：只对明确的家族生效；不在目录里、名字也没有特征的自定义模型会显示「模态未知 / 上下文未知」，而不是猜一个。
- **DSH 的模态契约只有 text / image**：视频 / 音频输入无法进入官方请求准入；这里只做展示，不改变请求路由。
- **适配器声明优先**：如果 Provider 明确写了 `input: [text]`（例如 opencode-go 的模型），页面会尊重这个声明，即使内置目录认为它支持图像。想改就以 Provider 配置为准。
- 上下文按十进制缩写（262144 → `262.1K`），精确值在悬停提示里。
- 目录是实时注册表快照；如果某个动态免费模型源刚好在刷新，页面模型总数可能和输入框里较旧的目录缓存略有出入，点「刷新」即可对齐。
- 探测需要 Host 的 `credentials` 服务；没有它时只跳过探测，页面仍显示适配器 + 内置目录。
- 中转站诊断信息会显示在分组标题旁，但不会显示 baseURL 全文、请求头或任何密钥。

## 隐私

- 探测只向设置文档里该 Provider 的 `baseURL` 同源地址发请求；不跟随重定向。
- 密钥只在 Host 内存里用于构造一次请求头，不写日志、不进路由响应、不进诊断。
- 页面只拿到能力事实和来源标签。

## License

MIT
