# Satellite Dataset Studio V2.1

Windows 本地离线卫星姿态图像生成工具。V2.1 在已统一的甲方左手坐标协议上增加自定义起止姿态序列，支持过渡预览及批量出图。

## 启动

本机开发构建完成后双击 `tools/start-desktop.cmd`，窗口和界面显示 V2.1（版本2.1.0）。本轮直接更新开发构建，不制作安装包。

历史 V2.0 安装包位于 `var/releases/`，不包含V2.1新功能；后续稳定发行时再统一打包。V2 系列安装目录为 `%LOCALAPPDATA%\Programs\SatelliteDatasetStudioV2`，数据目录为 `%LOCALAPPDATA%\SatelliteDatasetStudioV2\workspace`，可与 V1 共存。

开发模式数据保存在当前工程 `var/workspace/`。V2 不导入旧任务；请勿将 V1 数据目录指定为 V2 工作区。

## 坐标和输出

- 世界/零姿态本体系：X 向图像右、Y 朝观测相机、Z 向图像上，左手系。
- 观测相机系：X 向图像上、Y 向图像左、Z 沿光轴朝目标。
- 四元数为主动 local-to-world 变换，对外固定 `{W,X,Y,Z}`；默认卫星为 `{W:1,X:0,Y:0,Z:0}`，默认观测相机为 `{W:0.5,X:0.5,Y:-0.5,Z:0.5}`。
- JSON 位于 `poses/`，包含 `Location.SatQuat`、`Location.CamQuat` 和坐标说明。协议为 `satellite-pose-4.0` / `lh-client-world-v2`。
- Three.js/Blender 的引擎坐标由内部转换层处理，模型二进制和零姿态外观保持一致。用户无需切换坐标模式。
- 正式图片为 1024×1024、8 位灰度 PNG，辅助轴和界面控件不进入图片。

详见 [使用指南](docs/user-guide.md)、[协议说明](docs/architecture/interfaces.md)、[V2.1 验证记录](docs/verification-v2.1.md)。

## 自定义姿态序列

选择“自定义姿态序列”，设置起始姿态、结束姿态与帧数（至少2帧，包含首尾）。可以将当前手动姿态记录为端点，播放或逐帧查看过渡，再提交整批任务。距离、相机和光照在同一批内固定。

姿态沿最短路径过渡；相同起止姿态得到静止序列，不表示转满一圈。原有单张、全姿态采样和随机连续序列继续保留。预览不覆盖端点；预览时“生成当前单帧”抓取实际显示的姿态。

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

开发阶段直接修改V2源码并更新可运行开发构建，使用tools/start-desktop.cmd检查功能。按用户2026-11-01指示，不在每轮修改后自动压缩或制作安装包；待功能稳定、用户需要发行时再统一打包。历史V2.0包留在var/releases，不作为后续修改的必经步骤。
