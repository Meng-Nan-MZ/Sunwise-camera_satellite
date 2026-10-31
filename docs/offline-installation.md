# V2 Windows 离线安装

安装包为 `SatelliteDatasetStudio-V2-0.2.0-win-x64-setup.exe`，位于 `var/releases/`。程序内含 Python、Blender、.NET、固定 WebView2 与六个模型，安装时无需下载依赖。

V2 使用独立安装标识、开始菜单组和快捷方式“Satellite Dataset Studio V2”。默认安装到 `%LOCALAPPDATA%\Programs\SatelliteDatasetStudioV2`，数据位于 `%LOCALAPPDATA%\SatelliteDatasetStudioV2\workspace`。

V1 可以继续保留；V2 不升级覆盖 V1，也不迁移 V1 数据。卸载 V2 保留 V2 工作目录。

当前版本的实际测试范围以 [V2 验证记录](verification.md) 为准。旧版的安装验收记录不替代 V2 的验证。跨显卡、全新 Windows 和真实传感器光度定标不因本次坐标修改自动视为通过。

打包和复验见 [发行说明](../packaging/README.md)。
