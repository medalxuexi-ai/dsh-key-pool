# dsh-key-pool

一个给本地 [DSH (DeepSeek Harness)](https://github.com/deepseek-ai/deepseek-harness) 用的插件：
当当前 provider 的 **key 额度耗尽（或 key 失效 / 限流）** 时，自动从该 provider 的 key 池里
切换到下一个 key，并让 agent 重试当前步骤，无需重启、无需改 provider 配置。

切换只发生在凭证层：插件把池中下一个 key 的值写回 provider 正在读取的
`apiKeyEnv` 凭证引用。DSH 的 LLM 适配器每次请求都会重新解析凭证，所以重试会立即用上新 key。

---

## 工作原理

插件挂载在 agent loop 的 `agent/request-error` waterfall 上（与 `dsh-llm-retry` 同一个扩展点）：

1. 一次模型请求以错误结束后，DSH 把 `provider`、失败码（如 `QUOTA`）和当前重试策略交给插件；
2. 该 provider 配置了 key 池、且失败码匹配 `rotateOnCodes` 时，插件从凭证服务
   `ctx.credentials` 读取 provider 的 `apiKeyEnv` 当前值；
3. 按配置顺序找到池中下一个有值、且不同于当前值的 key，把它写入 `apiKeyEnv` 引用；
4. 插件返回 `{ kind: 'retry' }`，agent loop 用同一个 turn/step 重新请求，适配器解析到新 key；
5. 每个失败步骤最多切换 `maxRotationsPerStep` 次。池子耗尽后交回原有重试策略，
   本次请求按原策略失败，不会死循环。

轮转位置不需要额外的状态文件：`apiKeyEnv` 的当前值本身决定"下一个 key"，所以重启后
仍然从上次切换到的 key 继续。切换写入的是 `~/.dsh/.credentials.yaml`（由 credentials-local
持久化），因此跨会话、跨重启生效。

并发安全：同一进程内对同一 provider 的切换串行化，并在提交前重新检查 `apiKeyEnv`
是否已被其他会话切换，避免两个会话同时失败时跳过池中的一个 key。

---

## 适用范围

覆盖：

- agent loop 的模型请求，包括主对话与子 agent（都经过 `agent/request-error`）；
- 默认失败码：`QUOTA`、`RATE_LIMIT`、`AUTH`、`INVALID_CREDENTIAL`、`MISSING_CREDENTIAL`；
- 任意 provider 路由（`llm-pi-ai`、`llm-deepseek` 等），只要它的 `apiKeyEnv` 指向一个可写的凭证引用。

不覆盖（与 `dsh-llm-retry` 的边界一致）：

- session 标题生成、压缩摘要等直接调用 `ctx.llm.stream()` 的辅助请求；
- 请求前的主动额度预检——只在请求失败后切换；
- 账户级余额（`ACCOUNT_QUOTA`）默认不切换：换 key 不一定能解决账户余额问题，
  如确需处理可在 `rotateOnCodes` 中显式加入；
- 多个 DSH 进程同时运行、且共享同一个 credentials 文件时的跨进程轮转原子性
  （写入本身有跨进程锁，但"读当前值 → 选下一个 → 写回"不是跨进程事务）；
- `headless` profile：它禁用了交互式凭证服务，插件会保持未激活，无法轮转。

---

## 安装到本机 superagent profile

前提：DSH >= 0.2.1；profile 已挂载 `@deepseek-ai/dsh-credentials-local`（`dsh-base` 默认挂载）。

### 1. 把插件安装为 profile 依赖

```sh
cd ~/.dsh/profiles/superagent
pnpm add /Users/dingjianxun/src/dsh-demo/dsh-key-pool
```

没有 pnpm 时，也可以手工建立链接（效果相同）：

```sh
mkdir -p ~/.dsh/profiles/superagent/node_modules
ln -sfn /Users/dingjianxun/src/dsh-demo/dsh-key-pool \
  ~/.dsh/profiles/superagent/node_modules/dsh-key-pool
```

### 2. 在 profile manifest 中启用 bundle

编辑 `~/.dsh/profiles/superagent/package.json`，把 `"dsh-key-pool"` 加进
`dsh.profile.bundles`（放在 `@deepseek-ai/dsh-base` 之后即可）：

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-superagent",
        "dsh-key-pool"
      ]
    }
  }
}
```

### 3. 把池中的 key 写入凭证存储

编辑 `~/.dsh/.credentials.yaml`（权限必须是 `600`；DSH 运行中修改会热加载，无需重启）：

```yaml
version: 1
refs:
  # provider 当前 apiKeyEnv 指向的引用；插件切换时会覆盖它的值
  MN_SHARED1_API_KEY: sk-...
  # key 池的其它槽位（名字可自定义，只要和下面配置里的 keys 对应）
  MN_SHARED1_API_KEY_2: sk-...
  MN_SHARED1_API_KEY_3: sk-...

  MN_DJX_API_KEY: sk-...
  MN_DJX_API_KEY_2: sk-...
```

```sh
chmod 600 ~/.dsh/.credentials.yaml
```

不要把 key 值直接写进 `cordis.patch.yml` 或任何配置文件；配置里只出现引用名。

### 4. 在 profile 的 cordis.patch.yml 中配置 key 池

编辑 `~/.dsh/profiles/superagent/cordis.patch.yml`，追加（本机现有两个 provider 的示例）：

```yaml
- id: key-pool
  config:
    pools:
      mn-shared1:
        apiKeyEnv: MN_SHARED1_API_KEY
        keys:
          - MN_SHARED1_API_KEY
          - MN_SHARED1_API_KEY_2
          - MN_SHARED1_API_KEY_3
      mn-djx:
        apiKeyEnv: MN_DJX_API_KEY
        keys:
          - MN_DJX_API_KEY
          - MN_DJX_API_KEY_2
```

> 该 patch 会整体替换 `key-pool` 这一行的 config（bundle 默认是 `pools: {}`），
> 所以在这里写出全部池即可。

### 5. 重启一次

`dsh web`（superagent profile）需要重启一次才能加载新的 bundle。之后增删池中的 key
只改 `.credentials.yaml`，无需再重启。

### 验证安装

```sh
# 组合树里应出现 key-pool
dsh --profile superagent --dump-config | grep -A3 key-pool

# 或看 stderr / 终端 / ~/.dsh/dsh-web.log；插件切换时输出（不含 key 值）：
# key-pool: provider "mn-shared1" switched to pool key 2/3 after QUOTA; retrying the request
```

---

## 配置字段

### 顶层

| 字段 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | `false` 时插件加载但不注册任何监听器。 |
| `pools` | `{}` | provider 路由名 → key 池配置。空对象表示全部休眠。 |
| `rotateOnCodes` | 见下 | 触发切换的失败码；可被每个池覆盖。 |
| `retryDelayMs` | `500` | 切换后重试前的等待；可被每个池覆盖。 |

默认 `rotateOnCodes`：`[QUOTA, RATE_LIMIT, AUTH, INVALID_CREDENTIAL, MISSING_CREDENTIAL]`。

### 每个池

| 字段 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `apiKeyEnv` | 是 | — | provider 的 `apiKeyEnv`（插件把新 key 写回这个引用）。 |
| `keys` | 是 | — | 有顺序的凭证引用列表；值必须存在于凭证存储中才会被选中。 |
| `rotateOnCodes` | 否 | 顶层值 | 本池的失败码集合。 |
| `maxRotationsPerStep` | 否 | `max(1, keys.length - 1)` | 同一个失败步骤最多切换几次；到上限后交回原重试策略。 |
| `retryDelayMs` | 否 | 顶层值 | 切换后重试前的等待毫秒数；provider 返回的 `Retry-After` 优先（上限 300 秒）。 |

所有字段都做启动时校验：引用名不合法、`keys` 为空、重复引用、未知字段等都会让
插件加载失败并给出明确路径，而不是静默失效。

### 轮转规则

- 从当前 key 的下一个池槽位开始，按配置顺序找第一个"有值且值不等于当前值"的 key；
- 未配置（未设置）的池槽位会被跳过；
- 到末尾后回绕；
- 当前 `apiKeyEnv` 为空（`MISSING_CREDENTIAL`）时，从池中第一个有值的 key 开始；
- 当前值不在池中（例如手工换过 key）时，从池首开始尝试；
- 池中没有任何可用替代 key 时，不切换，直接交回原策略。

---

## 开发与验证

插件是零依赖的纯 ESM，无需构建。

```sh
cd dsh-key-pool

# 单元测试（不依赖 DSH 安装）
node --test test/*.test.js

# 真实 Cordis 运行时集成测试（fiber 生命周期、服务注入、waterfall 派发）
DSH_PACKAGE_ROOT=$(npm root -g)/@deepseek-ai/dsh node --test test/real-cordis.test.mjs

# 端到端验证：临时 DSH_HOME + SDK profile + 本地 mock provider
# 第一个请求返回 insufficient_quota，插件切换到 key #2 后重试成功。
node test/e2e/sdk-e2e.mjs
```

端到端脚本会断言：

- mock provider 收到的请求顺序是 `key #1 -> key #2`；
- 凭证存储中的 `POOL_ACTIVE` 已被改写成 key #2；
- 重试后的请求产生了 assistant 消息。

### 目录结构

| 路径 | 作用 |
|---|---|
| `src/config.js` | 配置校验、默认值、按 provider 归一化。 |
| `src/rotation.js` | 轮转算法、per-provider 串行队列、每步骤轮转预算。 |
| `src/index.js` | 插件入口：`agent/request-error` 监听、切换、重试决策。 |
| `cordis.patch.yml` | bundle patch：插入 `key-pool` 行。 |
| `test/` | 单元测试、真实 Cordis 测试、SDK 端到端脚本。 |

---

## 安全说明

- 配置与日志中只出现凭证引用名，不出现 key 值；插件日志不打印任何 key 内容。
- 插件唯一的写操作是 `ctx.credentials.set(apiKeyEnv, <池中 key 值>)`，沿用
  credentials-local 的权限检查、原子写入和 0600 权限。
- 如果凭证存储只读或写入失败，插件记录 warning 并把失败交回原重试策略，不影响
  正常的错误处理路径。
- 切换会持久化到 `~/.dsh/.credentials.yaml`，这是 DSH 凭证服务的设计行为
  （"改 key 下一次请求生效"），不是插件另建的明文副本。

---

## 卸载

1. 从 `~/.dsh/profiles/superagent/package.json` 的 `dsh.profile.bundles` 中删除 `dsh-key-pool`；
2. 从 `cordis.patch.yml` 中删除 `key-pool` 行；
3. `cd ~/.dsh/profiles/superagent && pnpm remove dsh-key-pool`（或删除 `node_modules/dsh-key-pool` 链接）；
4. 重启 DSH。