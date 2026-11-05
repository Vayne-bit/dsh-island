# dsh-island-overlay

DSH 的 Windows 顶部「灵动岛」：切换页面后仍然置顶显示当前会话状态（思考 / 审批 / 完成 / 失败）。

![正在思考](https://raw.githubusercontent.com/Vayne-bit/dsh-island/main/docs/shots/thinking.png)

| 需要审批（常驻展开） | 完成（绿色勾） |
|---|---|
| ![需要审批](https://raw.githubusercontent.com/Vayne-bit/dsh-island/main/docs/shots/approval.png) | ![完成](https://raw.githubusercontent.com/Vayne-bit/dsh-island/main/docs/shots/done.png) |

| 失败（红色抖动） | 平时缩成小圆点 |
|---|---|
| ![失败](https://raw.githubusercontent.com/Vayne-bit/dsh-island/main/docs/shots/failed.png) | ![空闲](https://raw.githubusercontent.com/Vayne-bit/dsh-island/main/docs/shots/idle.png) |

多个会话同时有事时只显示优先级最高的一个，其余折成 `+N`：

![多会话](https://raw.githubusercontent.com/Vayne-bit/dsh-island/main/docs/shots/multi.png)

动效（转圈、脉冲、勾线、抖动、宽度过渡）在 `island-demo.html` 里可以直接看，浏览器打开即可。

## 原理

两条腿，互不依赖第三方包：

1. **宿主插件** `lib/index.js`：挂在 DSH 主进程里，监听 `session/event`（`turn/start`、`turn/end`、
   `approval/asked`、`approval/decided`、`tool/call`），把各会话状态写进
   `%USERPROFILE%\.dsh\dsh-island-state.json`，每 3 秒心跳一次。
2. **浮层** `overlay/`：一个透明的置顶 Electron 窗口，每 400ms 读那个 JSON 渲染胶囊。
   它**复用 DSH 安装目录里的 Electron**（`process.execPath`），所以不用另外下载 Electron；
   宿主 30 秒没有心跳就先隐藏、5 分钟没心跳才自己退出。

   复用有个前提：安装目录里带着 `resources/app.asar`，Electron 会优先加载它、无视命令行给的
   app 目录。所以首次启动时会把运行时**硬链接**一份到
   `%LOCALAPPDATA%\dsh-island-runtime`（同盘不占空间，已存在就复用），跳过 `app.asar`、
   只保留 `default_app.asar`，浮层才跑得起来。

## 装到新电脑

1. 把整个 `dsh-island` 文件夹拷过去（约 40 KB，不需要 `node_modules`）。
2. 确认那台机器装了 DeepSeek Harness。
3. 在文件夹里跑：

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

脚本会自动找 `dsh.cmd`（默认在 `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\`），
然后执行 `dsh plugin --profile desktop add link:<这个目录>`——这会把这个目录登记成插件，
并在 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 里加上 `dsh-island-overlay`。

DSH 装在非默认路径时自己指定：

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 -Cli "D:\...\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
```

4. **重启 DSH**（托盘退出后再打开）才生效。

> 装的是 `link:`，即 DSH 直接指向这个文件夹。**装完别删/别移动这个文件夹**，否则插件失效。

## 设置

装好后打开 DSH 的「插件」页 → 点开 `dsh-island-overlay` → 页面下方就是设置卡片，改完即时生效。

可调：胶囊缩放、迷你态直径、位置（顶部居中 / 右上角 / 记住拖拽位置）、显示时机（始终 / 仅 DSH 不在前台）、
各状态收起时间、动效开关（小鲸鱼 / 脉冲 / 抖动 / 减少动效）、显示哪些状态、全屏应用时自动隐藏。

配置写在 `%USERPROFILE%\.dsh\dsh-island-config.json`，删掉它就回到默认值。
设置卡片走插件自己的两条同源路由（`/dsh-island/config.json`），带 Host/Origin/Sec-Fetch-Site 校验。

## 状态规则

| 事件 | 显示 |
|---|---|
| `turn/start` | 思考（小鲸鱼 + 计时，2.5s 后缩成小图标） |
| `approval/asked` | 等待审批（琥珀脉冲，常驻展开） |
| `tool/call` = `ask_user_question` | 等待回答（同上） |
| `turn/end` = `completed` | 完成（绿勾，3s 后消失） |
| `turn/end` = `error` / `blocked` / `max-tokens` | 失败（红色抖动，6s 后消失） |
| `turn/end` = `aborted` / `interrupted` / `forked` | 不显示，直接消失 |

多个会话同时有事时只显示优先级最高的一个（审批/回答 > 失败 > 完成 > 思考），其余用 `+N` 角标；最多并列显示 3 个会话，每段各自计时。

交互：拖动可移动位置（记在 `~/.dsh/dsh-island-pos.json`）；点一下把 DSH 拉到前台；
鼠标划过展开全文；检测到前台是全屏程序（视频/游戏）时自动隐藏。

## 卸载

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop remove dsh-island-overlay
```

然后重启 DSH，再把文件夹和 `%LOCALAPPDATA%\dsh-island-runtime` 删掉。

## 排错

- **没反应**：确认 `~/.dsh/dsh-island-state.json` 有内容在变（3 秒刷新一次）。没有 → 插件没加载，
  看 DSH 启动日志，或重新跑一次 `install.ps1`。
- **有 JSON 没胶囊**：浮层没起来。手动试：
  `"C:\Users\<你>\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe" <本目录>\overlay`
  正常会弹出一条黑色胶囊，控制台有无关紧要的 disk_cache 报错。
- **胶囊不置顶 / 盖住别人**：Windows 的置顶窗口在少数全屏独占程序（部分游戏）上会被盖住，这是系统限制。
- **改了 `overlay/index.html` 要重启 DSH**：浮层是启动时拉起的，不热重载。
