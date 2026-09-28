# dsh-session-keepwarm

Keep the most recently used sessions resident in the browser, so switching back reuses the loaded history instead of re-reading it.

[English](#english) | [中文](#中文)

<a id="english"></a>
## English

### Why this exists

Since DSH 0.1.7 the client keeps a session resident only while a `SessionReference` is outstanding
(see the Client references section of `packages/api/session-controller/README.zh.md`): a main-view
switch releases the outgoing session, and when the last reference is released the generation — local
data, scoped Context and history window — is torn down. Switching back builds a new generation and
re-reads the first history page (at least 50 messages across two turn boundaries), which the UI shows
as "Loading history…".

This plugin holds one extra reference per recently used session (under its own source key
`sessionKeepwarm`), so the last release never fires for those sessions. Switching back then reuses
the resident window — `Session.open()` is idempotent for an already-open session, so no history is
fetched again. The set is an LRU capped by the `keepWarm` setting, which bounds the memory the old
"keep everything" behaviour used to spend.

### Behaviour

- Watches the `sessions.list` snapshot: a row that gains `retainedBy.mainView > 0` is the session
  just switched to; it moves to the front of the LRU and is retained.
- When the LRU grows past `keepWarm`, the oldest reference is released.
- Plain sessions only; subagent rows keep their own lifecycle.
- Holding a reference keeps client-local data and the history stream only — it never starts or holds
  a Host Agent.

### Settings

The settings form is derived from this plugin's Config schema (profile entry id `session-keepwarm`):

| key | default | meaning |
|---|---:|---|
| `enabled` | `true` | master switch; turning it off releases every held reference |
| `keepWarm` | `5` | how many recently used sessions stay resident (1–20) |

### Boundaries

- **Same tab only.** The client shares no session state between tabs or browsers (no SharedWorker or
  BroadcastChannel), so a second window has its own heap and always loads on first open.
- **First open still loads**: keep-warm only affects switching back to a session this tab already
  visited and still holds.
- Held sessions keep their history in browser memory plus one stream each; a larger `keepWarm` costs
  more memory.

### Install

```sh
dsh plugin --profile web add dsh-session-keepwarm
```

Then enable it in the profile. The plugin needs DSH `0.1.7` or newer.

### Build

```sh
npm install   # esbuild
npm run build
```

### Exit condition

If the DSH client gains a "retain the last N sessions" setting (or an equivalent deferred-teardown
policy), prefer that and remove this plugin.

---

<a id="中文"></a>
## 中文

### 存在理由

DSH 0.1.7 起，客户端按**引用计数**管理会话（见 `packages/api/session-controller/README.zh.md`
的 Client 引用一节）：

> 引用保活**本地会话数据、作用域 Context 和历史流**……
> **最后一个引用释放时，generation 先退出可访问映射，再执行清理**。

主视图切换会话时先 retain 新目标、再 release 旧目标；旧会话没有别的持有者时计数归零，那一代
（含已解码的历史窗口）被销毁。切回来是**新的一代**，于是重新拉首页历史（≥50 条消息、跨 ≥2 个
turn），界面上就是「载入历史」。

本插件替**最近用过的 N 个会话**各持一张凭据（来源键 `sessionKeepwarm`），让它们的最后一个引用
永远不归零：同一标签页内切走再切回**零重读、瞬间复用**（`Session.open()` 对已打开会话是幂等的）
——同时 LRU 上限保证内存有界，不像旧模型那样无限保留。

### 行为

- 观测 `sessions.list` 快照：某行出现 `retainedBy.mainView > 0` 即视为「刚被切过去的会话」，
  推到 LRU 头部并 retain；
- LRU 超出 `keepWarm` 时释放最旧的引用；
- 只处理**普通会话**；子代理行有自己的生命周期，不保活；
- 只保活客户端本地数据与历史流，**不会启动或持有 Host Agent**。

### 配置

设置表单由本插件的 Config schema 派生（条目 id `session-keepwarm`）：

| 字段 | 默认 | 含义 |
|---|---:|---|
| `enabled` | `true` | 总开关；关闭即释放全部引用 |
| `keepWarm` | `5` | 保活几个最近用过的会话（1–20） |

### 边界（做不到什么）

- **只对同一个标签页有效**：客户端不在标签页/浏览器之间共享会话状态，第二个窗口永远是独立的
  一份堆，首次打开一定重新拉历史。
- **首次打开任何会话**（包括被保活的那些第一次）仍要拉一次历史——保活只影响「切走之后切回来」。
- 被保活会话的历史留在浏览器内存 + 各一条流；`keepWarm` 越大占用越高。

### 安装

```sh
dsh plugin --profile web add dsh-session-keepwarm
```

然后在 profile 里启用。需要 DSH `0.1.7` 或更新版本。

### 构建

```sh
npm install   # esbuild
npm run build
```

### 退出条件

上游若为客户端加入「保留最近 N 个会话」的设置（或恢复等价的延迟销毁策略），应优先用上游设置
并移除本插件。
