# 测试与验收记录

测试日期：2026-07-29。环境为 Windows、单显示器 1440×900；Codex renderer 实际参数包含 `device-scale-factor=2`。

## 自动化

执行：

```powershell
npm run build
npm run check
npm test
```

结果：21/21 通过。覆盖：

- 配置白名单、轮询上下限、关闭值、后台倍率和固定周期
- wham 与 app-server 两种真实字段形状、多额度桶和非法数据 fail-fast
- ETA 样本不足、无消费、真实时间间隔、重置周期、晚于重置、主窗口选择
- 历史去重、损坏隔离
- in-flight 去重、429、认证失败、不兼容停止和指数退避
- HTML 单次注入
- ASAR patch、重复 patch、unpatch 往返测试，包括 unpacked 集合与内容哈希
- 远程控制 gate 的唯一定位、等长改写和重复 patch
- Windows 设备密钥客户端的唯一定位、等长 helper 加载改写和重复 patch
- P-256 密钥生成、DPAPI 持久化、签名验签、删除及无明文私钥校验
- 恢复文件的校验、切换和临时文件清理

## Store 写入与副本安装

普通权限、管理员 ownership/ACL 修改以及 SYSTEM 身份下直接覆盖 Store
`app.asar` 均未成功。AppX package volume 仍拒绝或阻止该文件替换，因此最终安装路径
不再修改 `WindowsApps`。

当前一键脚本将完整 Store 目录同步到 backup，再从 backup 重建活动副本。已验证：

- Store 源目录和原始 ASAR 哈希不变。
- backup 与 Store 文件布局一致。
- 活动副本从 backup 重建后只改写受管资源。
- 桌面和用户开始菜单 `.lnk` 指向活动副本。
- 卸载恢复原快捷方式和环境变量，并删除两个托管目录。

## 真实 ASAR 远程控制 dry-run

以本机 Store 原始 ASAR 构建临时候选，结果：

- 已安装候选 ASAR SHA-256：
  `afe05e74c5b8f840e3918960c71a29ab1c353decd84c466d5df264aaa6aa3037`
- UI bundle：`webview/assets/remote-connections-settings-D24FMFxV.js`
- gate alias：`m`；派生 visibility alias：`z`；改写偏移：`133401`
- main bundle：`.vite/build/main-DS6zBDC3.js`
- 设备密钥客户端形状：`class`；改写偏移：`1745753`
- 原方法 284 字节，helper stub 199 字节，尾部填充后 bundle 总长度不变
- 原始 macOS-only 错误消失，helper 路径出现一次
- unpacked 文件数仍为 37，集合和内容哈希未变化

设备密钥测试在临时 `CODEX_HOME` 中实际调用 Windows DPAPI，签名经公钥验签通过；
存储 JSON 只含 DPAPI 密文，不含 PKCS#8/PEM 私钥。

`patch.cmd` 连续运行两次均完成。第二次实际先由 `/MIR` 删除活动副本中的
`rc-device-key.cjs` 和已 patch ASAR，再从 backup 重建并重新执行全部补丁；最终
ASAR/helper 哈希与状态记录一致，`installed` 和 `remoteControlEnabled` 均为 true。

## 实际窗口与自适应

使用独立空白用户数据目录启动补丁 `ChatGPT.exe`，临时在 localhost 开启 CDP，只读取 DOM/样式和调整测试 viewport。没有复用或导出当前 Codex 登录材料。

实际主窗结果：

- 注入实例存在，标题栏锚点状态 `mounted`
- 数据 Hook 状态 `existing-client-result`
- 兼容状态 `compatible`
- safe area 状态 `valid`
- slot parent 为第一行标题栏
- 标题栏和 slot 高度均为 36 px，没有增加高度
- slot 是 `drag`，widget 是 `no-drag`
- widget 在标题栏可用 slot 内右对齐，右边界仍受 native safe area 检查
- 右对齐复测：slot 右边界 1143 px，widget 右边界 1135 px，保留 8 px 内边距，`justify-content=flex-end`，safe area 为 `valid`
- 第二行页面 header 从 y=36 开始，没有被注入
- 点击组件可打开详情面板，Escape 可关闭
- `initialRoute=/avatar-overlay` 的辅助窗口没有创建补丁实例

自适应实测：

| viewport 宽度 | slot 宽度 | widget 宽度 | 档位 | 可见字段 |
|---:|---:|---:|---|---|
| 1400 | 988 | 296 | full | 名称、百分比、进度、ETA、重置 |
| 1100 | 784 | 281 | full | 名称、百分比、进度、ETA、重置 |
| 900 | 584 | 271 | full | 名称、百分比、进度、ETA、重置 |
| 760 | 444 | 264 | full | 名称、百分比、进度、ETA、重置 |
| 640 | 324 | 180 | eta | 名称、百分比、进度、ETA |
| 520 | 204 | 103 | bar | 名称、百分比、进度 |

正常 fresh 状态在所有档位均不占标题栏；异常状态只在空间允许时显示。组件收缩时没有覆盖左侧菜单或右侧 native safe area。

当前构建在额度名称与百分比之间插入 `icr-widget-separator`，文本为居中点 `·`，opacity 为 0.45；仅百分比档位会同时隐藏名称和分隔点。

## 真实数据行为

- 已实际收到 Codex 自身 `/wham/usage` 请求结果并显示多个真实额度窗口。
- 详情数据来自 `codex-existing`，没有使用示例百分比。
- 实际账户当时没有 5 小时窗口，界面没有制造 5 小时项。
- 空白历史时显示“数据不足”；积累不变样本后显示“无明显消耗”，不显示具体虚假 ETA。
- 多窗口测试中只有一个 Web Locks Leader，辅助头像窗不启动运行时。

## 尚未自动确认

以下项目不能从当前单显示器和 CDP DOM 测试中得出完整结论，不能标记为已通过：

- 物理第二显示器上的拖动、缩放和每屏 DPI 切换：本机只有一个显示器。
- 鼠标双击标题栏最大化/还原和右键系统菜单：slot 的非组件区域已实测为 `drag`，但没有用禁止的 Computer Use 代替人工输入。
- 长时间休眠/唤醒、数小时后台退避和真实 429：逻辑由自动化测试覆盖，未等待真实服务器制造这些状态。
- 实际认证失效、服务端字段突变和 Credits 消费：只做了合成错误测试。
- 完整发起 Codex 编码任务、终端和插件业务回归：测试副本能启动、渲染主页并读取额度，但未在独立空白配置中执行真实任务。

人工验收时应双击 `patch.cmd`，批准 UAC，等待标准 Store 入口重启后逐项验证双击、右键、最大化、侧栏开关和一段正常任务流程。
