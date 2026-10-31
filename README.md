# Satellite Dataset Studio V2

Windows 本地离线卫星姿态图像生成工具。V2 将界面姿态操作和正式 JSON 统一到甲方的左手坐标定义；只处理本次反馈第一条。

## 启动

本机开发构建完成后双击 `tools/start-desktop.cmd`。界面、桌面窗口和任务协议均为 V2。

正式 V2 安装包及校验文件生成于 `var/releases/`。V2 安装目录为 `%LOCALAPPDATA%\Programs\SatelliteDatasetStudioV2`，数据目录为 `%LOCALAPPDATA%\SatelliteDatasetStudioV2\workspace`，可与 V1 共存。

开发模式数据保存在当前工程 `var/workspace/`。V2 不导入旧任务；请勿将 V1 数据目录指定为 V2 工作区。

## 坐标和输出

- 世界/零姿态本体系：X 向图像右、Y 朝观测相机、Z 向图像上，左手系。
- 观测相机系：X 向图像上、Y 向图像左、Z 沿光轴朝目标。
- 四元数为主动 local-to-world 变换，对外固定 `{W,X,Y,Z}`；默认卫星为 `{W:1,X:0,Y:0,Z:0}`，默认观测相机为 `{W:0.5,X:0.5,Y:-0.5,Z:0.5}`。
- JSON 位于 `poses/`，包含 `Location.SatQuat`、`Location.CamQuat` 和坐标说明。协议为 `satellite-pose-4.0` / `lh-client-world-v2`。
- Three.js/Blender 的引擎坐标由内部转换层处理，模型二进制和零姿态外观保持一致。用户无需切换坐标模式。
- 正式图片为 1024×1024、8 位灰度 PNG，辅助轴和界面控件不进入图片。

详见 [使用指南](docs/user-guide.md)、[协议说明](docs/architecture/interfaces.md)、[V2 验证记录](docs/verification.md)。

## 工程结构

`apps/desktop` 是 C# WPF/WebView2 宿主；`apps/ui` 是 React/TypeScript/Three.js；`python/src/satellite_studio` 包含领域数学、任务、Blender 渲染和数据校验；`schemas` 保存新协议；`tests` 和 `tools` 用于构建验收。

所有运行库、编译产物、日志和生成数据进入 `var/`。购买的模型、转换二进制和本地依赖不进入 Git；仓库保留源码、模型清单和文本配方。仅下载 Git 源码需要自行准备授权模型和开发环境。

## 版本留存

同级 `SatelliteDatasetStudio-V1` 保存修改前完整工程、安装包和历史数据；原始 `SatelliteDatasetStudio` 也保持原位。V2 不含旧协议兼容或迁移入口。目录划分见 [版本说明](docs/version-layout.md)。

## 构建与验证

Python 3.11+、Node.js 24、.NET 8、Blender 5.2。依赖以现有锁文件为准。

```powershell
python -m pip install -e ./python
pnpm --dir apps/ui install --frozen-lockfile
pnpm --dir apps/ui run test
pnpm --dir apps/ui run build
./tools/test-python.ps1
./tools/build-desktop.ps1
```

开发脚本读取 `var/runtime.json` 或 `SATELLITE_PYTHON` / `SATELLITE_BLENDER`；安装版使用内置运行时。打包见 [离线发行](packaging/README.md)。

## 后续开发约定

开发阶段直接修改V2源码并更新可运行开发构建，使用tools/start-desktop.cmd检查功能。按用户2026-11-01指示，不在每轮修改后自动压缩或制作安装包；待功能稳定、用户需要发行时再统一打包。本轮已生成的包留在var/releases，不作为后续修改的必经步骤。
