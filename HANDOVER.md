# 模型显示 · 开发与发布

归档基线 **v1.16.1** · Node.js 24 · ESM。用户用法见 [README](README.md)，最终维护版改动见 [v1.16.1 发布说明](docs/RELEASE-1.16.1.md)。下文保留作为旧版开发与发布记录；新功能、协议适配与后续开发见 [DSH-The-Model-List](https://github.com/TZYCeng/DSH-The-Model-List)。旧包名、运行数据位置和既有安装不变。

## 1. 本地启动与验证

```powershell
npm ci
npm run build
npm test
npm pack --dry-run
```

源码在 `client-src/`，由 [构建器](scripts/build-client.mjs) 组装成提交到 Git 的 [client.js](client.js)。不要手改生成物。React 从 DSH 的 ModuleLoader 取得，不另装一份 React；入口标识与包名、Cordis 行保持一致。Host 逻辑改动要重载 Host 或重启 DSH，再刷新原有页面。不要起替代 Web 服务器；只有同一 DSH checkout 的 Web 构建监听器正在运行时，才可期待客户端 HMR。

## 2. 模块地图：遇到问题先看哪条路径

| 路径 | 入口 → 关键模块 | 约束 |
| --- | --- | --- |
| 显隐 | [设置页](client-src/settings-section.mjs) → [可见性提交](client-src/visibility-identity.mjs) → [菜单过滤](client-src/composer-filter.mjs) | 使用期望 revision 并只提交指定目标；保留当前会话的选中项。旧多斜杠键不能猜拆分，[编码规则](client-src/visibility-codec.mjs)与 CSV 共用。 |
| 能力与图像准入 | [模型目录](lib/model-info.js) → [证据仲裁](lib/evidence-policy.js) → [中转站探测](lib/provider-probe.js) / [图像闸门](lib/image-input-gate.js) | 精确证据按字段合并。不把图像闸门自身的扩展、名称推断或别名参考当成适配器已验证能力。 |
| 校验 | [调度器](lib/check-catalog.js) → [公开目录](lib/public-catalog.js) 或 [模型调用](lib/checker-call.js) → [答复协议](lib/checker-contract.js) → [快照](lib/learned-catalog.js) | 保留已合法的行，repair 只补未解决的目标，不重查来源；快照不可读时不得以空库覆盖。 |
| 写回 | [本地覆盖](lib/model-overrides.js) → [提供商写入](lib/provider-write.js) / [批量计划](lib/bulk-efforts-plan.js) / [批量执行](lib/bulk-efforts.js) | 确认归属和 revision，写后回读。保留原映射；不会把档位标签猜成上游请求值。自动写回复用展示侧的字段仲裁。 |
| 用量与数据 | [账本](lib/usage-ledger.js) / [磁盘回退](lib/usage-disk.js) / [CSV](lib/export-csv.js) → [数据路径](lib/profile-store.js) / [锁](lib/store-lock.js) | 读取可分页、限时并取消；继承会话不重复计量；旧数据只按可证明的归属导入。 |
| Host 和客户端 | [Host 接线](index.js) → [目录与核验路由](lib/host-routes.js)、[JSON 控制路由](lib/host-http.js) → [客户端状态](client-src/catalog-store.mjs) | 使用 DSH 认证的 Fetch 注册；代次变化要丢弃旧响应。设置页的草稿使用稳定身份。 |
| 调试与版本 | [本地日志](lib/debug-trace.js) / [客户端观测](client-src/diagnostic-events.mjs) / [版本查询](lib/version-info.js) → [支持面板](client-src/support-panels.mjs) | 仅白名单字段；不得写入密钥、原始内容、工具参数、异常全文或上游映射值。 |

## 3. 不能混淆的状态

- **显示与请求**：菜单可见性只影响选择器。`requestReasoning` 是当前适配器的实际档位，`referenceReasoning` 是资料参考；能力来源绑定到字段，不能把整行标成某一个来源。
- **精确与模糊**：独立保存能证明精确 ID 的公开字段。旧混合来源、模糊别名和 `input: []` 都不能像显式提供商配置一样参与真实请求。写回前严格重读本地覆盖与快照；展示可以保留最后一次成功读取。
- **核验进度与失败**：`processed` 是已处理，`done` 是有效，`unknown` 是未获可靠结论，`failed` 是该模型处理失败，`skippedKnown` 是跳过已有。`sourceFailures` 统计来源尝试，不算模型失败。取消须带当前 `runId`。
- **已派发与已生效**：设置写入可能已经派发但回读失败。保留历史回执；取消和授权过期阻止新派发，不回滚已完成或已派发的请求。结果不确定时不要盲重试。

### 最终答复与补答

每个最终请求放一份精确 ID 数组；`ref` 是这个请求内的 1-based 数字编号，宿主不从答案出现顺序猜模型。读取证据时只允许声明的搜索工具、已检索的来源；补答复用本轮证据，不启动搜索。遇到长 ID 或截断，最多把未通过的行拆成两个互不重叠的组；每个目标最多进入一次补答。部分已经通过的行仍可提交。回归覆盖 [长 ID 与错位保护](test/checker-recovery-long-ids.test.mjs) 和 [失败恢复](test/checker-recovery.test.mjs)。

### Host 路由约定

前缀是 `/api/dsh-model-visibility`。混合 GET/POST 的精确路由使用 **`requestBody: 'buffered'`**：DSH `0.2.2-rc.5` 的 bridge 在 streaming 路由会尝试为无 body 的 GET 创建流式 Request，导致 handler 之前的 HTTP 400。控制 JSON 仍单独限制大小、校验类型和超时；[bridge 回归](test/host-fetch-body.test.mjs)不能只用直接调用 handler 代替。

| 路由 | 合约 |
| --- | --- |
| `/models` | GET；普通读取或强制刷新。能力元数据可降级，不重置浏览器筛选。 |
| `/overrides` | GET 列表与 revision；POST 写入或移除。实际写入 Provider 另需明确动作。 |
| `/verify` | GET 只取进度；POST 开始或 `{cancel:true,runId}`。 |
| `/bulk-efforts` | GET 只取状态；POST `preview` 只预览，`enable` 带确认票据才生效，`disable` 停止新派发。 |
| `/usage`、`/export` | 用量读与 CSV；扫描受节流。导出只根据明确类型选择数据。 |
| `/diagnostics`、`/version` | GET 不改变采集状态；调试 POST 支持 `toggle`、`clear` 和经 epoch 校验的 `append`。版本默认本地，`?check=1` 才请求固定 npm 源。 |

## 4. 验收清单

- Node 测试由 [隔离引导](test/setup.mjs) 设置临时 `DSH_HOME`，清掉实际 profile 变量。测试不调用真实校验员，不写真实提供商。修改线协议时补一条 Host 路由或客户端 fixture，不只测纯函数。
- 真机验收：重启后用量、手动覆盖、核验和调试面板能读；筛选刷新不丢；隐藏后切换当前模型，原模型消失；折叠后编辑草稿不丢。批量先点取消，验证**没有写入**。实际写回只在量身准备的测试 profile 验证。
- 校验验收：用量、来源失败与模型失败分开；长 ID 缺行补答不增加搜索；来源镜像回退显示原因。核验范围不是页面筛选结果，不为截图随意重查全量目录。
- 发布包要能载入 Host 入口，包含 [清单](package.json) 以及 [截图清单](screenshots.json)、本地化和当前 README 引用的素材。不要包含测试、临时产物、`code_engineer/`、日志或用户数据。

## 5. 提交与发布

1. 核对 [清单](package.json)、[锁文件](package-lock.json) 和目标 Git 标签版本一致，查询 npm 版本与远端标签均未占用。标签说明和 GitHub Release 共用 [版本说明](docs/RELEASE-1.16.0.md)；下一版本另写新说明。
2. 两次构建哈希一致、测试全绿、安装包预检通过后，按明确文件清单提交。不要用覆盖式暂存把其他已暂存文件带进发行提交。
3. [分支 CI](.github/workflows/ci.yml) 在 Windows、Ubuntu 验证。**推送 `v*` 标签会启动 [发布工作流](.github/workflows/publish.yml)，尝试 npm 可信发布并上传 GitHub Release 资产。** 只推分支不会触发该发布。带 `confirm_publish` 的手动运行须指向已存在的标签。
4. 拿到明确发布确认后才推送标签。等待工作流结果，再检查 npm 版本、GitHub Release 和下载包；本地打包成功不代表已发布。除非另有授权，不变更 DSH 用户 profile、npm 权限或市场索引。
