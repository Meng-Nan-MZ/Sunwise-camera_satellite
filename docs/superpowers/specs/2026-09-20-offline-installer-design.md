# Windows 离线安装包

用户已要求继续制作离线安装包，沿用 Windows 优先、本地离线、全部源文件按职责归档的决定。本次直接实现完整打包链路，不改变姿态或采样算法。

## 交付与安装

生成 Windows x64 安装程序，安装当前用户可运行的工作台，提供开始菜单及可选桌面快捷方式。桌面壳采用 .NET 自包含发布；包内包括本地网页、Python及NumPy/Pillow、后端源文件、六个标准模型、Blender和WebView2固定运行时。安装和首次启动都不下载依赖。

默认安装到用户程序目录，数据写入 `%LOCALAPPDATA%/SatelliteDatasetStudio/workspace`。卸载只移除安装程序创建的应用文件和快捷方式，保留任务、图片和日志。测试安装使用工作区内独立目录，不替换开发版或已有数据。

## 文件约定

包根含 `SatelliteStudio.Desktop.exe` 和 .NET 发布依赖；其下 `apps/ui/dist`、`python/src`、`assets/models`、`runtime/python`、`runtime/blender`、`runtime/webview2`、`docs`、`licenses`。用 `release-manifest.json` 保存版本、来源和文件SHA256。运行时只使用相对包根路径，无开发机绝对路径。

源代码：`packaging/installer/` 存安装器定义，`packaging/` 存版本和依赖锁定配置，`tools/packaging/` 存下载、组装、检查工具，`tests/packaging/` 存发行边界测试。下载、staging、安装测试与日志在 `var/packaging/`；可交付产物在 `var/releases/`。

购买原始压缩包、SDK、node_modules、开发配置、已有任务和审计临时文件不进入发行包。模型仅在本机组包，不上传。保留依赖许可和模型来源记录。

## 启动契约

无参数双击桌面EXE按 `AppContext.BaseDirectory` 找到包根和三个运行时；开发版显式启动参数保持兼容。固定WebView2缺失时不能悄悄回退到开发机已有版本。WebView用户数据在工作目录。Python禁写源码字节码，内嵌Python的路径配置显式包含后端和依赖；Blender worker同样禁写项目字节码。

## 验证与边界

测试路径包含空格和中文，打包后不依赖旧版Blender、Codex Python、全局.NET或全局WebView2。检查所有清单哈希、六模型预览资源、真实灰度渲染、小批量队列、取消和关闭；执行实际安装/卸载并检查卸载保留用户数据。用空白工作目录、受限外网的应用启动验证离线链路。

没有可用干净Windows虚拟机时，不把开发机的隔离路径测试描述成跨机器验收。安装程序无签名证书时，如实标记为未签名本地构建。系统显卡驱动属于系统前提，不打入应用包。
