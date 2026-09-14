# expire-notify —— 每天早上的到期提醒

每天早上 **7:30（北京时间）** 扫一遍仓库里的 `data.json`，把该提醒的商品通过 **PushPlus** 推到微信。

## PushPlus 收费吗

**完全免费**（实名后即可，**2024 年 8 月起未实名就不能发消息**，所以必须实名一次）。

实名用户每日限额：
- 微信渠道 200 条/天（你的场景每天最多 1 条）
- 接口频率 1 分钟最多 5 次
- **相同内容 1 小时最多 3 条** —— 所以手动反复触发测试时可能被拒（返回 `code: 999 请勿频繁推送相同内容`），这是它的风控，不是函数坏了

## 拿 token（5 分钟）

1. 浏览器打开 <https://www.pushplus.plus/login.html>
2. 用微信扫码登录（或手机号注册）
3. 关注它推给你的服务号（不关注收不到推送）
4. 右上角头像 →「个人信息」→ 复制 **用户 token**（32 位）
5. 填到项目根目录 `.env.local` 的 `PUSHPLUS_TOKEN`，然后跑 `npm run deploy`

> ⚠️ token 等同于密码，别贴到公开的地方。

## 推送节奏

不是每天都推同样的话，否则很快就被无视：

| 情况 | 什么时候推 |
|---|---|
| 已过期 / 今天到期 | **每天**推（这是真该处理的） |
| 只是临期（1 ~ `REMIND_DAYS` 天） | **每周一**汇总推一次 |
| 什么都没有 | 按 `PUSH_WHEN_EMPTY`：`weekly`（默认，周一推「请放心」）/ `daily` / `never` |
| **运行失败** | 立刻推一条写着「运行失败」的消息 + 原因 |

最后一条很重要：没有它，**「函数出错」和「今天没事」在微信里长得一模一样**，漏推你也不会发现。

想改回每天都收到消息：把 `PUSH_WHEN_EMPTY` 设成 `daily` 再部署。

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `PUSHPLUS_TOKEN` | 是 | 推送到微信 |
| `GITHUB_TOKEN` | 是 | 读私有仓库 `data.json` |
| `TZ` | 是 | **`Asia/Shanghai`，别删**。云函数运行环境默认是 UTC，而定时器按北京时间 7:30 触发（= UTC 前一天 23:30），不设 TZ 会把「今天」算成前一天，日期和剩余天数整体差一天 |
| `REMIND_DAYS` | 否 | 临期窗口天数，默认 30（和 product-api 保持一致） |
| `PUSH_WHEN_EMPTY` | 否 | `weekly`（默认）/ `daily` / `never` |
| `GITHUB_OWNER` / `GITHUB_REPO` / `GITHUB_FILE` / `GITHUB_REF` | 否 | 覆盖默认仓库设置 |

## 定时触发器

cron 表达式**按北京时间解释**（官方文档没写，实测确认：写 `13:35` 就是北京时间 13:35 触发）。

```bash
# 每天北京时间 7:30
tcb fn trigger create expire-notify \
    --trigger-name daily-730 \
    --cron "0 30 7 * * * *"
```

## 手动验证

```bash
# 不加参数：按当前日期判断今天该不该推
tcb fn invoke expire-notify -e trae-projects-4g5aob6ufac38569

# 加 force：忽略「今天该不该推」，立刻推一次（内容与当天一致时可能被 PushPlus 风控拒收）
echo '{"force":true}' > body.json
tcb fn invoke expire-notify -e trae-projects-4g5aob6ufac38569 -d '@body.json'
```

返回示例：

```json
{"code":0,"scanned":62,"pushed":true,"reason":"urgent",
 "counts":{"expired":2,"dueToday":1,"soon":5},
 "pushplus":{"status":200,"body":{"code":200,"msg":"执行成功"}}}
```

`reason` 取值：`urgent`（有紧急的，推）/ `weekly`（周一汇总）/ `empty`（没内容但按配置推）/ `skip`（今天不推）。

## 依赖

只用到 Node 内置的 `https`（直连 GitHub 与 PushPlus），没有第三方依赖，
`shared/` 下的日期与分档逻辑由部署脚本复制到 `lib/`。
