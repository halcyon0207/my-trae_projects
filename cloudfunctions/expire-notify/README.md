# 云端定时到期提醒（PushPlus 版）

每天 9:00 定时扫 `products` 集合，把过期/30 天内到期的商品通过 **PushPlus** 推送到你的微信。

## PushPlus 收费吗

**完全免费**（实名后即可，**2024 年 8 月起未实名就不能发消息**，所以必须实名一次）。

实名用户每日限额：
- 微信渠道 200 条/天（你的场景每天只发 1 条）
- 接口频率 1 分钟最多 5 次（每天一次根本不会触发）
- 相同内容 1 小时最多 3 条（每天一条、内容天天不同，不会触发）

对你来说绰绰有余，不需要付费。

## 拿 token（5 分钟）

1. 浏览器打开 <https://www.pushplus.plus/login.html>
2. 用微信扫码登录（或手机号注册）
3. 关注它推给你的服务号（**登录后页面会直接给二维码**，不关注收不到推送）
4. 右上角点头像 → 「个人信息」 → 复制 **用户 token**（一串 32 位的字母数字）
5. 把这个 token 给我，我帮你填到云函数环境变量并部署

> ⚠️ 不要把这个 token 贴到公开的 issue/聊天记录里，等同于密码。

## 部署流程

> 这一节是给开发者看的，你只要做完上面五步把 token 给我就行。

```bash
# 1. 部署函数
tcb fn deploy expire-notify -e trae-projects-4g5aob6ufac38569

# 2. 配置 token（项目根目录有 cloudbaserc.json，envVariables.PUSHPLUS_TOKEN）
tcb config update fn expire-notify

# 3. 配置定时触发器（每天 9:00）
tcb fn trigger create expire-notify \
    --trigger-name daily-9am \
    --cron "0 0 9 * * * *"

# 4. 手动验证一次
tcb fn invoke expire-notify -e trae-projects-4g5aob6ufac38569
```

执行成功的话微信会立刻收到一条「测试消息」。