# V2 甲方坐标与姿态协议设计

日期：2026-10-31。用户已确认开始实施，仅处理反馈第一条，并允许使用其 GitHub 仓库管理源码。

## 范围和版本

- V1 是现版工程的完整归档，源码、模型、旧安装包、历史数据原样留存，校验清单位于上级 version-archives。
- V2 从现版代码和必要资产复制，独立工作区、安装身份和启动入口，不复制旧任务，不读取或迁移旧协议。
- 原始 SatelliteDatasetStudio 目录保留不动，V1 是额外归档；只修改 SatelliteDatasetStudio-V2。
- 应用版本 0.2.0 / V2；新数据 schema `satellite-pose-4.0`，坐标标识 `lh-client-world-v2`。
- 本轮不新增单翼模型、自定义轨迹、噪声解耦、路径选择或主题。

## 已选择的方案

界面和对外数据统一使用甲方坐标，Three.js/Blender 保持现有引擎坐标，通过单一数学适配边界转换。不全局改写引擎；不提供旧协议模式。用户已经批准此方向。

## 数学和接口

- 世界/零姿态本体系：左手系，X 图像右、Y 朝观测相机、Z 图像上。
- 观测相机系：左手系，X 图像上、Y 图像左、Z 光轴朝目标。
- 四元数定义：Hamilton 数值公式，主动 local-to-world 列向量变换。正轴角以该公式为准，界面内禀 XYZ；相机和目标都按此规则。
- 新世界/机体坐标到引擎坐标的矩阵 P 交换 Y/Z，P=[[1,0,0],[0,0,1],[0,1,0]]。R_engine=P R_client P.T；q_client=(x,y,z,w) 对应 q_engine=(-x,-z,-y,w)。目标零姿态外观保持原模型外观。
- 公开 scene API 使用 `sat_quat:{W,X,Y,Z}`，拒绝旧 `quaternion_xyzw` 输入；内部数学函数可使用 xyzw 数组，但不将旧字段作为对外兼容接口。
- 输出 `Location.SatQuat`、`Location.CamQuat`，键顺序 W,X,Y,Z。默认 CamQuat=(.5,.5,-.5,.5)，SatQuat=(1,0,0,0)。连续序列保留四元数符号连续。
- 输出 `CoordinateInfo` 为 `left‑handed coordinates; Origin: target center; X:right,Z:up`；`CameraCoordInfo` 为 `left‑handed coordinates; Z:optical axis, X:UP, Y:left`（描述中的连字符 U+2011 与反馈一致）。
- 完整元数据可放在同一新协议 JSON，但所有世界/机体/观测相机矩阵须符合新定义，不能保留未标明的旧协议字段。保留 K 时明确其 CV 像素投影基，并提供 camera_to_cv_rotation 和对应投影矩阵，不把旧 K 伪称为新相机基的直接投影。
- 正式 CamQuat 从实际 Blender 观测相机 matrix_world 转换；不取自由观察相机或卫星载荷相机。
- 六角描述新本体三轴在照片上的方向，alpha=atan2(worldZ,worldX)，beta=acos(worldY)，极点保留 alpha_valid。模型源坐标到新本体坐标的变换也同步转换。
- API/JSON/图像继续逐帧一致，文件目录本轮保留现有 poses 命名并在说明中写明。

## 界面和隔离

UI 显示左手系轴向说明、WXYZ 四元数和默认 CamQuat；坐标轴红X/绿Y/蓝Z，零姿态绿色朝相机、蓝色向上。姿态控件、轴辅助线与导出属于同一定义；自由观察仍不改变采集姿态。

V2 使用独立 LocalAppData 子目录、安装 AppId、安装目录、开始菜单组、快捷方式、卸载名和窗口标题。显式 workspace 参数检测旧协议数据库，拒绝将旧任务当作V2任务读取。

## 验收

测试先失败再实现：默认相机、零姿态、三轴 ±90°、非对称任意姿态、q/-q 等价、转换往返、正交性、同一点投影一致、旧请求拒绝、旧数据目录拒绝。验证前端、Python、桌面构建及实际 Blender 单帧/批量；取得新界面截图和已保存 PNG，检查 JSON/图像对应。V1 归档哈希再次核对。

源码使用 Git 管理；模型二进制、购买素材、运行库、用户数据不提交远程。远程有已有历史时保留其历史，不强推。
