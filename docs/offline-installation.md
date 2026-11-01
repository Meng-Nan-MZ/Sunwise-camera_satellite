# V2 Windows 离线安装与版本范围

历史 V2.0 安装包为 `SatelliteDatasetStudio-V2-0.2.0-win-x64-setup.exe`，位于 `var/releases/`，其中包含当时的 Python、Blender、.NET、固定 WebView2 与六个模型。这描述历史包，不代表当前开发版。

当前 V2.4 只更新可运行开发构建，不制作新安装包。双击 `tools/start-desktop.cmd` 启动；新运行流程和应用发行配置仅需 GLB，不需要 Blender。旧安装包和本机已安装的 Blender 保留。

V2 使用独立安装标识、开始菜单组和快捷方式“Satellite Dataset Studio V2”。默认安装到 `%LOCALAPPDATA%\Programs\SatelliteDatasetStudioV2`，数据位于 `%LOCALAPPDATA%\SatelliteDatasetStudioV2\workspace`。

V1 可以继续保留；V2 不升级覆盖 V1，也不迁移 V1 数据。卸载 V2 保留 V2 工作目录。

当前版本的实际测试范围以 [V2.4 验证记录](verification-v2.4.md) 为准；[V2.0 验证记录](verification.md) 保留。历史安装验收不替代新版验证；本机开发验收也不代表全新 Windows 或不同显卡已验证。

打包和复验见 [发行说明](../packaging/README.md)。
