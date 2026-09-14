# product-api —— 数据读写代理

页面不直接读写仓库，所有数据操作都经过这个函数。它做三件事：

1. **校验访问口令**（HTTP 访问服务本身是公开的，口令是唯一的一道门）
2. **合并**：把「本机带上来的那份」与「云端最新那份」按 `shared/merge.js` 的规则合并
3. **读写** `product-expiry` 仓库里的 `data.json`（令牌只在云函数环境变量里）

## 接口

`POST https://<环境ID>-<随机后缀>.ap-shanghai.app.tcloudbase.com/api`
（HTTP 访问服务：`/api` → `product-api`，本项目的地址写在 `script.js` 顶部的 `API_BASE`）

请求体（JSON）：

| 字段 | 说明 |
|---|---|
| `action` | `hello`（只校验口令）/ `pull`（合并后返回，不改云端）/ `push`（合并 → 写回 → 返回） |
| `key` | 访问口令，也可以放在请求头 `x-api-key` |
| `products` / `mappings` | 本机的活记录 |
| `tombstones.products` / `tombstones.mappings` | 本机的删除标记（墓碑） |

响应：

```json
{
  "code": 0,
  "data": {
    "config": { "remindDays": 30 },
    "rev": "写入后的 commit sha（pull 时没有）",
    "products": [], "mappings": [],
    "tombstones": { "products": [], "mappings": [] }
  },
  "stats": {
    "remoteLive": 67, "remoteTombstones": 1,
    "products": 67, "mappings": 66
  }
}
```

`stats.remoteLive` / `remoteTombstones` 是云端写入前的计数，页面用它提示「本机还有几条没上传」。

## 为什么合并放在服务端

- **不丢数据**：每次写入前都重读云端最新版本再合并，两台设备先后提交不会互相覆盖
- **先点哪个按钮都安全**：`pull` 只读不改，`push` 先合并再写，两个方向都保留两端更新的记录
- **规则只有一份**：合并逻辑在 `shared/merge.js`，页面和两个云函数共用，改一处三处生效

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `API_KEY` | 是 | 访问口令，页面填一次后存本机 |
| `GITHUB_TOKEN` | 是 | 读私有仓库用的 PAT（`repo` 权限） |
| `REMIND_DAYS` | 否 | 临期窗口天数，默认 30；页面也从这个接口取，保证两边一致 |
| `GITHUB_OWNER` / `GITHUB_REPO` / `GITHUB_FILE` / `GITHUB_REF` | 否 | 覆盖默认仓库设置 |

## 部署

```bash
# 在项目根目录（会自动同步 shared/ 到 lib/ 并写入环境变量）
powershell -File scripts/deploy.ps1

# 只测接口，不写数据
npm run smoke
```

## 排查

- **401 访问口令不正确** → 页面填的口令与 `API_KEY` 不一致
- **500 未配置 API_KEY** → `cloudbaserc.json` 里引用了 `.env.local` 的 `{{env.API_KEY}}`，确认该文件存在且跑过 `tcb config update fn product-api`（部署脚本已包含这一步）
- **写入仓库失败（HTTP 403）** → 请求头缺 User-Agent 或令牌失效；代码里已固定带 User-Agent，通常是令牌问题
- **HTTP 409/422 冲突** → 正常并发场景，函数会自动重读重试（最多 3 次）
