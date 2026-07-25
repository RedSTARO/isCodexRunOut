# 安全与隐私

## 边界

- 一键脚本会请求管理员权限，临时修改当前 AppX `app.asar` 的 owner/ACL，原位覆盖后恢复继承 ACL 和 `TrustedInstaller` owner。
- 不重新签名 AppX，修改后的内容会偏离 Store 发布签名状态。
- 不创建原版 ASAR 备份。`%LOCALAPPDATA%\isCodexRunOut` 只保存非敏感状态和构建临时文件；临时文件在操作结束后删除。
- 补丁只使用当前 Codex 已有的 renderer→主进程请求桥。认证由 Codex 主进程附加。
- 源码不包含认证值，不读取浏览器 Cookie，不访问系统凭据存储。
- 不启用长期远程调试。开发验收使用的 localhost 调试端口只用于独立测试配置，测试后关闭。

## 持久化内容

允许保存：

- 显示和轮询配置
- 归一化额度窗口采样
- 最近一个归一化快照
- 脱敏诊断状态和错误代码

不保存：

- 完整请求或响应正文
- Authorization、Cookie、访问/刷新/会话令牌
- 聊天、Prompt、回复、用户代码
- 账号标识或支付信息

调试日志默认关闭。打开后只输出事件名、错误代码、HTTP 状态、窗口数量和非敏感轮询配置；不输出 headers 或 body。

## 本地历史

历史与配置存在 Codex 用户 profile 的 `app://-` origin `localStorage`。卸载器不会直接编辑 Chromium LevelDB，因为按文件删除会同时破坏 Codex 业务数据。需要删除额度历史时先在详情面板使用“清空历史”。

原位卸载只去掉补丁注入，不恢复微软原始 ASAR 哈希。需要官方字节级恢复时使用 Store 修复或重装。

损坏的补丁 JSON 被截断到有限大小后隔离到专用 key，再重建空数据。默认历史 30 天，每窗口最多 5000 条，避免无限增长。

## 报告问题

可提供：

- `npm run status` 输出
- 补丁版本、Codex 版本
- 界面中的错误代码和兼容状态

不要提供完整 usage 响应、请求头、用户 profile 文件、`Local Storage`/`Cookies` 数据库或任何令牌。
