# V2 验证记录

日期：2026-10-31。范围为反馈第一条：界面及JSON采用甲方坐标，V1/V2隔离。旧版验证记录保存在V1，不计为本轮结果。

## 版本留存

原工程完整复制到同级SatelliteDatasetStudio-V1，27,161个源码、资产、旧安装包、数据及运行文件逐项SHA256与原目录一致。可重建的node_modules、obj、__pycache__、开发SDK缓存不计入证据哈希；完整副本仍保留这些目录。校验清单位于上级version-archives/V1-manifest.json。

V2单独复制代码、必要资产及构建依赖，不复制旧任务。Git基线标签v1-source-baseline，开发分支v2/client-coordinate-protocol。

## 已执行检查

| 检查 | 证据 |
|---|---|
| Python 38项：领域、API、任务、导出、旧协议拒绝 | var/development/backend-python-tests.log；最终复验日志 |
| 渲染资产/生命周期5项 | var/development/backend-rendering-tests.log |
| UI 17项：数学、WXYZ快照、辅助轴、模型灰度 | var/development/ui-tests-green.log |
| TypeScript、Vite生产构建、Prettier | var/development/ui-report.md |
| 桌面17项：路径、参数、安全启动、子进程退出 | var/development/desktop-green.log |
| 打包9项：资产完整性、路径、清单与V2身份隔离 | 本轮执行tests/packaging |
| 实际Blender八姿态 | var/verification/v2-coordinates-final/report.json；对应PNG/TXT/JSON |
| 六模型实际灰度渲染 | var/verification/rendering/report.json与contact-sheet.png |
| 原生桌面六模型、identity/X90输入和实际PNG/JSON、观察模式、关闭清理 | var/verification/v2-desktop/report.json |
| 修正灰度模型与RGB辅助轴后的桌面复验 | var/verification/v2-desktop-colored-axes/report.json与截图 |

八姿态包括零姿态、三轴各±90°和一个非对称复合四元数。验收检查Location.SatQuat/实际CamQuat、逐帧校验、1024²灰度PNG非全黑、引擎/CV与甲方世界坐标的独立点投影一致。

桌面联验实际操作界面输入90°X、点击生成单帧，确认提交sat_quat、保存Location和界面输入一致；六模型载入无页面异常、无资源失败，单一canvas；自由观察不改变采集姿态。关闭原生窗口后自有服务退出。彩色辅助轴复验同时检查画布中心区域RGB像素。

真实批量测试发现Blender相机位置为float32存储，小数采样距离与请求的double存在微小精度差；此项按实际相机数据和明确精度边界修正，不能用整数距离通过代替。旧工作区预检同时提前到CLI和Application写日志/锁文件之前，拒绝时不修改旧目录。

三种真实API采集完成7帧：单帧1、覆盖3、连续3，逐帧新协议JSON检查通过，记录在var/verification/v2-api/report.json。V1最终复核1,506个源码、资产、原任务和发行附件文件仍与归档清单一致。

## 验证边界

这是当前开发电脑的真实测试；全新Windows、其他显卡/驱动、长批量、甲方实际消费程序联调未在本轮完成。界面预览与正式渲染的光照/材质仍可能有视觉差异，正式PNG为准；本轮不调整原有灰度、噪声或曝光需求。安装包测试范围在构建完成后记录。
