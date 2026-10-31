# Satellite Dataset Studio

Windows 本地卫星姿态图像生成工作台。使用 Three.js 交互预览，使用后台 Blender 生成正式的灰度图像和姿态标注。本目录是独立的新工程；同级旧版本与已有数据保留原位。

## 离线安装与启动

安装包构建产物位于 `var/releases/`，安装说明见 [Windows 离线安装](docs/offline-installation.md)。安装后通过开始菜单或桌面快捷方式打开，不需要另装 Python、Blender、.NET 或 WebView2，也不需要配置开发路径。

安装版的数据保存在 `%LOCALAPPDATA%\SatelliteDatasetStudio\workspace`；升级和卸载不删除该目录。批量采集步骤见 [详细使用指南](docs/user-guide.md)。

本次离线安装包已完成本机安装、只读程序目录启动、六模型、单帧/批量/取消及卸载保留数据验证。范围和证据见 [安装包验收记录](docs/offline-verification.md)。

## 开发目录启动

本机已配置 `var/runtime.json`。双击 **`tools/start-desktop.cmd`**，或在 PowerShell 执行：

```powershell
./tools/start-desktop.ps1
```

开发时也可执行 `./tools/start-server.ps1`，在浏览器打开 `http://127.0.0.1:8765`。桌面壳会自动选择空闲端口。查看和旋转模型不需要启动 Blender；提交正式图像或批量采集后才启动渲染器。

开发脚本读取本机运行时配置；向另一台电脑交付时使用完整离线安装包。复现构建见 [离线打包说明](packaging/README.md)。

## 工程结构

```text
SatelliteDatasetStudio/
├─ README.md
├─ .editorconfig
├─ .gitignore
├─ apps/
│  ├─ desktop/                    # C# WPF/WebView2 窗口与子进程管理
│  └─ ui/                         # React/TypeScript/Three.js
├─ python/
│  ├─ pyproject.toml
│  └─ src/satellite_studio/
│     ├─ domain/                  # 纯数学、参数、采样和坐标定义
│     ├─ jobs/                    # SQLite任务记录与串行执行
│     ├─ rendering/               # Blender进程与正式渲染适配
│     ├─ datasets/                # 噪声、标签、文件校验与导出
│     └─ server/                  # 同源本机API与静态文件服务
├─ schemas/                       # JSON参数/标注协议
├─ assets/                        # 模型、来源与材质配方
│  ├─ models/                     # 标准GLB/Blend与版本清单
│  ├─ recipes/                    # 可复现的坐标配准和材质分区
│  ├─ sources/                    # 本地购买源文件，不入版本控制
│  └─ textures/                   # 生成的PBR贴图，不入版本控制
├─ tests/                         # 数学、队列、API与渲染生命周期测试
├─ tools/                         # 启动、构建、模型准备、验收
├─ packaging/                     # 运行时与离线交付说明
├─ docs/                          # 设计、接口、迁移与验证记录
└─ var/                           # 本机生成内容；不入源码版本控制
   ├─ build/                     # 编译后的程序
   ├─ tools/                     # 开发SDK与依赖缓存
   ├─ logs/                      # 资产转换和验收日志
   ├─ verification/              # 验收图片与报告
   ├─ workspace/                 # 开发模式的任务数据库、输出、桌面日志
   ├─ packaging/                 # 锁定下载、运行时、安装内容与隔离验收
   └─ releases/                  # 离线安装程序、SHA256及第三方源码附包
```

目录按职责组织。业务规则不放入界面组件，`bpy` 不进入普通 Python 服务，运行时路径不硬编码到源码，临时文件不堆在根目录。模型二进制仅本地存放；来源清单随代码保留。

## 使用流程

第一次操作或需要批量采集时，参见 [详细使用指南](docs/user-guide.md)。

1. 选择模型，调整机体姿态、10–30 km 距离、光照和噪声。拍摄视角的焦距对该模型固定，距离改变会改变目标像素尺寸。
2. “自由观察”用于检查彩色材质；“拍摄视角”显示灰度预览。正式拍摄使用独立的采集相机，正式图像以 Blender 保存的 PNG 为准。
3. 提交单帧、SO(3)覆盖集或连续序列。任务使用提交时的参数快照；之后修改面板不会改变已入队任务。
4. 查看队列进度和保存的结果。取消在帧边界生效；重启时之前运行中的任务标为 interrupted，完整帧保留，重新提交可重试；等待中的任务继续排队。

每帧输出干净/带噪图、YOLO五列标签与JSON：四元数、六角、极点有效标记、K、观察相机/载荷相机外参、距离、种子与渲染信息。默认是评估数据，不自动把同一图片同时列为训练与验证集。

## 开发与验证

Python 3.11+，依赖见 `python/pyproject.toml`；Node.js 24、pnpm；.NET 8 SDK、WebView2 Runtime；Blender 5.2。

```powershell
# 安装开发依赖（只在准备环境时联网）
python -m pip install -e ./python
pnpm --dir apps/ui install --frozen-lockfile

# 构建与检查
pnpm --dir apps/ui test
pnpm --dir apps/ui build
./tools/test-python.ps1 -PythonPath C:/path/to/python.exe
./tools/build-desktop.ps1
```

运行时路径可通过 `SATELLITE_PYTHON` / `SATELLITE_BLENDER` 环境变量、启动脚本参数或 `var/runtime.json` 配置。复制 `packaging/runtime.example.json` 为该文件并填写路径即可。

四款更新模型来自 `02-四个卫星模型.zip`，使用嵌入贴图的 PBR 材质，详见 [模型更新与重建](docs/model-materials.md)。已打开的软件需要重启以读取最新模型清单。

以下命令仅用于从旧版建立初始模型库，会覆盖现有材质；执行后须按上述文档重新构建四款更新模型。不执行资产自带脚本：

```powershell
& C:/path/to/blender.exe --background --factory-startup --disable-autoexec --python-exit-code 1 --python ./tools/prepare_assets.py -- --source-assets C:/legacy/assets --destination ./assets/models
python ./tools/verify_rendering.py --blender C:/path/to/blender.exe
```

新旧标签坐标协议不兼容，禁止混合后直接训练。详见 [迁移范围](docs/migration.md)、[模块接口](docs/architecture/interfaces.md)、[验证记录](docs/verification.md) 和 [完整设计](docs/superpowers/specs/2026-09-19-satellite-studio-reconstruction-design.md)。
