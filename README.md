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
   宿主 30 秒没有心跳就先隐藏（不显示过期状态），心跳回来后自动重新显示，5 分钟都没恢复才退出。

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

## 从 npm 装

已发布到 npm（[dsh-island-overlay](https://www.npmjs.com/package/dsh-island-overlay)），不用拷文件夹：

```powershell
dsh plugin --profile desktop add dsh-island-overlay
```

或者在 DSH 的「插件市场」里搜 `dsh-island-overlay` 安装。装完同样要**重启 DSH**。

## 设置

装好后打开 DSH 的「插件」页 → 点开 `dsh-island-overlay` → 页面下方就是设置卡片，改完即时生效。

可调：胶囊缩放、迷你态直径、位置（顶部居中 / 右上角 / 记住拖拽位置）、显示时机（始终 / 仅 DSH 不在前台）、
多会话展示（单行折叠 / 多行，最多行数）、各状态收起时间、动效开关（小鲸鱼 / 脉冲 / 抖动 / 减少动效）、
显示哪些状态、审批/提问气泡开关、全屏应用时自动隐藏。

配置写在 `%USERPROFILE%\.dsh\dsh-island-config.json`，删掉它就回到默认值。
设置卡片走插件自己的两条同源路由（`/dsh-island/config.json`），带 Host/Origin/Sec-Fetch-Site 校验。

## 状态规则

| 事件 | 显示 |
|---|---|
| `turn/start` | 思考（小鲸鱼 + 计时，2.5s 后缩成小图标） |
| `approval/asked` | 等待审批（琥珀脉冲，常驻展开，计时接着走） |
| `tool/call` = `ask_user_question` | 等待回答（同上） |
| `turn/end` = `completed` | 完成（绿勾，3s 后消失） |
| `turn/end` = `error` / `blocked` / `max-tokens` | 失败（红色抖动，6s 后消失） |
| `turn/end` = `aborted` / `interrupted` / `forked` | 不显示，直接消失 |

多个会话同时有事时按优先级排序（审批/回答 > 失败 > 完成 > 思考），单行模式折叠成 `+N`，多行模式每会话一行。
计时读的是**回合开始时间**，所以「思考 20 分钟 → 弹审批 → 继续思考」是一条连续的时间轴，不会归零。

交互：拖动可移动位置（自动切到「自定义位置」，记在 `~/.dsh/dsh-island-pos.json`）；点一下把 DSH 拉到前台；
鼠标划过展开全文（DSH 在前台时也能展开）；检测到前台是全屏程序（视频/游戏）时自动隐藏。

## 审批 / 提问气泡

DSH 在后台时，审批与提问不再只弹官方卡片——胶囊下方会浮出一张气泡，直接点「允许一次 / 拒绝」，
提问则选选项或填自定义回答，回车即提交。点「改用官方卡片」可让这一条转回 DSH 自己的 UI。

- **DSH 在前台**、或**浮层被隐藏**（全屏应用、心跳过期）时**不拦**审批，直接交给官方卡片。
  这一点是硬要求：气泡画在看不见的窗口里，用户既看不到气泡、官方卡片也不出现。
- **右键气泡**可暂时收起。它不会替你作答，决定权仍在宿主/官方卡片；下一个新请求进来会重新弹出。
- 设置页可分别关掉「审批气泡」「提问气泡」，关掉后一律走官方卡片。
- 浮层与宿主之间用两个小文件通信：`~/.dsh/dsh-island-answers.json`（决定）和
  `~/.dsh/dsh-island-foreground.json`（前台/可见性 + 握手 token）。决定必须带回宿主下发的
  token 才会被接受，避免往文件里写一条就批准。

## 多行布局

设置页「多会话展示」可切 `单行（折叠 +N）` / `多行（每会话一行）`，并设「最多行数」（1–20，默认 5）。
超出部分折成最后一行的 `+N`，**不额外占一行**，所以窗口高度就是「行数 × 38px + 留白」，小屏可预期。
折叠的永远是优先级最低的会话——审批/提问/完成不会被折掉。

## 卸载

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop remove dsh-island-overlay
```

然后重启 DSH，再把文件夹和 `%LOCALAPPDATA%\dsh-island-runtime` 删掉。

## 常见问题

### 安装

**`dsh` 命令找不到 / `'dsh' 不是内部或外部命令`**
DSH 不会把 `dsh` 加进 PATH，得用完整路径：

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add dsh-island-overlay
```

装在非默认目录（比如 `D:\`）时，把上面路径换成你的实际位置。

**`install.ps1` 报 `dsh.cmd not found`**
脚本只在 `%LOCALAPPDATA%\Programs`、`Program Files`、`Program Files (x86)` 三个位置找 DSH。装在别处就手动指定：

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 -Cli "D:\...\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
```

**`无法加载文件 install.ps1，因为在此系统上禁止运行脚本`**
Windows 默认执行策略拦脚本。加 `-ExecutionPolicy Bypass`（上面的命令已经带了），不要改全局策略。

**需要自己装 pnpm / node 吗**
不需要。DSH 自带一份 pnpm（`resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.mjs`），
`dsh plugin` 内部用 DSH 自己的 Electron 跑它，跟系统的 node/pnpm 无关。系统里有别的 pnpm 也不会冲突。

**pnpm 报 `ERR_PNPM_...` / 网络超时**
`dsh plugin` 用的是你 npm 配置里的 registry。国内网络建议：

```powershell
npm config get registry   # 一般是 https://registry.npmmirror.com
```

本包在 npmmirror 已同步。若公司网络拦 npm，可临时指定源：
`dsh plugin --profile desktop add dsh-island-overlay --registry=https://registry.npmmirror.com`。

**装完没反应**
装完必须**重启 DSH**（托盘右键退出，再打开）。热重载不会拉起浮层。
确认 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 里有 `dsh-island-overlay`。

**已经用 `link:` 装过本地目录，又想换成 npm 版**
先卸再装，否则 pnpm 会把 link 改写成 npm 版本、你本地的改动就不再生效：

```powershell
& "<dsh.cmd 完整路径>" plugin --profile desktop remove dsh-island-overlay
& "<dsh.cmd 完整路径>" plugin --profile desktop add dsh-island-overlay
```

反过来（npm 版换成本地开发）把 `add dsh-island-overlay` 换成 `add link:<本目录绝对路径>`。

### 运行时

**状态文件在变，但屏幕上看不到胶囊**
先看日志，两个文件都在 `%USERPROFILE%\.dsh\`：

- `dsh-island-plugin.log`：`runtime prepared` + `spawn ...` 说明浮层被拉起过；
  只有 `skip: isElectron=false` 说明插件没跑在 DSH 主进程里。
- `dsh-island-overlay.log`：每次启动写 `start v0.2.x`，之后每 60 秒一条 `alive`。
  没有 `start` → 浮层根本没起来。

手动起浮层验证：

```powershell
& "$env:LOCALAPPDATA\dsh-island-runtime\DeepSeek Harness.exe" "<本目录>\overlay"
```

正常会弹出一条黑色胶囊（控制台里的 `disk_cache` 报错可以忽略）。

**浮层起不来，日志里连 `start` 都没有**
多半是运行时镜像不完整。删掉 `%LOCALAPPDATA%\dsh-island-runtime` 再重启 DSH，插件会自动重建
（同盘用硬链接，不额外占空间）。镜像里必须有 `resources\default_app.asar`，缺它 Electron 就不认命令行给的 app 目录。

**跑一阵子自己消失了**
已修（0.2.0+）。旧版在心跳短暂中断后不会恢复显示，看起来就是「消失了」。升级后：心跳断 30 秒先隐藏，
恢复后自动重新显示，连续 5 分钟没恢复才退出进程。仍复现的话看 `dsh-island-overlay.log` 最后几行。

**点胶囊后 DSH 变成窗口化 / 反应慢**
已修（0.2.0+）。旧版用 `SW_RESTORE` 会把最大化窗口还原；现在只在窗口最小化时才还原。
慢是因为旧版每次点击都新起一个 PowerShell，现在复用常驻的 `watch.ps1`（约 150–250ms）。

**「完成」一直卡着不下去**
已修（0.3.0+）。宿主删除终态靠一个 3 秒定时器，而状态文件是「写 tmp → rename 覆盖」；
Windows 上 rename 撞到浮层正在读文件会抛 `EPERM`，以前这个异常被静默吞掉，磁盘上就留着
一条永远不走的「完成」，直到下次状态变化才被覆盖。现在两头都堵：`flush()` 失败会写
`flush FAIL` 到日志，且每条状态带 `stateAt`，浮层自己按 TTL 兜底丢弃超龄的 done/failed。

**审批卡住不动、官方卡片也不出现**
已修（0.3.0+）。旧版在浮层被隐藏时（全屏应用、心跳过期）仍然拦下审批，气泡画在看不见的
窗口里，一直卡到 30 分钟超时才失败。现在浮层会把自己的可见性写进
`dsh-island-foreground.json`，宿主只在「浮层真的在屏幕上且 DSH 不在前台」时才拦审批。

**日志里刷屏 `overlay exited code=0`**
已修（0.3.0+）。浮层是 detached 进程，DSH 重启不会带走它；新宿主每 3 秒拉起一个 Electron、
抢单实例锁失败就退出，如此循环（实测 3 分钟 53 次）。现在秒退 + code 0 会被识别为
「已有实例在服务」，推迟 60 秒再试。

**胶囊挡到浏览器标签页**
鼠标事件是穿透的（只挡视觉，不挡点击）。想少挡：设置里把「迷你态」调小，或改用「顶部居中 → 右上角」，
或开「仅 DSH 不在前台时显示」。拖动可以直接改位置（记在 `~/.dsh/dsh-island-pos.json`）。

**换了显示器 / 拔了副屏后胶囊不见了**
位置会被夹回最近的屏幕工作区，理论上不会跑到屏幕外。真丢了就删 `~/.dsh/dsh-island-pos.json` 重启 DSH。

**改了 `overlay/index.html` 没生效**
浮层是 DSH 启动时拉起的独立进程，不热重载。改完重启 DSH，或手动 `taskkill` 掉浮层进程（插件 3 秒内会重拉）。

**全屏看视频 / 打游戏时胶囊还在**
设置里开「全屏应用时自动隐藏」。注意它只认「窗口铺满整块屏幕」，最大化窗口不算全屏。
少数独占全屏的游戏连置顶窗口都能盖住，这是 Windows 的限制，插件绕不过去。

**多个 DSH 实例会不会叠出两个胶囊**
不会，浮层有单实例锁，第二个实例直接退出。


