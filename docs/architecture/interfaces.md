# V2 本机接口与坐标契约

V2 仅使用 `satellite-pose-4.0` / `lh-client-world-v2`。不读取或迁移 V1 请求、任务数据库或 JSON。

## 坐标和四元数

世界/零姿态本体系为左手系：X 图像右、Y 从目标朝观测相机、Z 图像上。观测相机系为左手系：X 图像上、Y 图像左、Z 光轴朝目标。原点分别是目标中心和相机光心。

旋转为主动 local-to-world 列向量映射；使用 Hamilton 数值公式。界面为内禀 XYZ 角（度），所有对外四元数对象按 W、X、Y、Z 保存，单位长度。q 与 -q 表示同一旋转，连续序列保留相邻符号连续。内部数学函数采用 xyzw 数组仅是实现细节。

引擎适配矩阵 P 交换 Y/Z，R_engine = P R_client P.T，q_engine=(-x,-z,-y,w)。GLB/Blend 保持原有引擎几何；公开模型清单的 source_to_body 是源模型坐标到新本体系的变换。

## HTTP（同源，仅 127.0.0.1）

- GET /api/health：status、renderer_available、schema_version。
- GET /api/models：六模型名称、构型、半径、预览URL与哈希、source_to_body等。
- POST /api/jobs：202，返回任务。请求 mode=single/coverage/sequence、count、scene；sequence可带服务端轨迹参数。
- GET /api/jobs、GET /api/jobs/<id>：队列及单任务状态。
- POST /api/jobs/<id>/cancel：请求取消；完整帧保留。
- GET /data/<job_id>/<relative_path>：仅访问已发布的逐帧产物。

Scene 必须包含 model_id 和 sat_quat={W,X,Y,Z}。支持 distance_m=10000..30000、resolution=1024、非负32位seed、noise={enabled,gaussian_sigma,poisson_peak}、lighting={azimuth_deg,elevation_deg,energy}。默认距离20000，噪声 .012/96，光照35°/28°/4。旧 quaternion_xyzw 输入明确拒绝；无 sat_quat 不会默认为零姿态。

Job状态为queued/running/completed/failed/canceled/interrupted；每次提交冻结参数。序列起止距离30000到10000、步长1秒、角速度1°/s。全姿态为SO(3)采样，六个相关角不独立随机。

## 正式输出

每帧images_clean/<id>.png、images_noisy/<id>.png、labels/<id>.txt、poses/<id>.json。图像1024×1024、8位灰度。YOLO标准五列，姿态不插入TXT额外列。JSON包含：

- Location.SatQuat、Location.CamQuat：WXYZ对象。
- CoordinateInfo：`left‑handed coordinates; Origin: target center; X:right,Z:up`。
- CameraCoordInfo：`left‑handed coordinates; Z:optical axis, X:UP, Y:left`。
- rotation_world_from_body、six_angles、distance_m、资产哈希、scene快照、种子、文件清单、渲染器信息。
- six_angles按新本体X/Y/Z三轴顺序：alpha=atan2(worldZ,worldX) mod 2π；beta=acos(worldY)，弧度。投影长度小于1e-8时alpha置0并标alpha_valid=false。

零姿态SatQuat为{W:1,X:0,Y:0,Z:0}。正式观测相机位于世界(0,d,0)，默认CamQuat为{W:.5,X:.5,Y:-.5,Z:.5}。CamQuat由实际Blender观测相机matrix_world转换，不取自由观察相机或目标载荷相机。

## 相机与投影元数据

observer_camera.camera_to_world和world_to_camera采用甲方相机轴。K以K_basis明确标为CV的X右/Y下/Z前像素投影基。camera_to_cv_rotation=[[0,-1,0],[-1,0,0],[0,0,1]]。

projection_world_to_pixel = K @ camera_to_cv_rotation @ world_to_camera[:3,:]。乘世界齐次点后除以第三分量得到像素坐标。不要直接将K乘到甲方相机坐标。

image_basis明确为右手的图像X右/Y上/Z朝观察者；image_basis_to_world=P@实际Blender相机旋转，是含换手性的基映射（行列式-1），不称为SO(3)旋转。payload_camera为独立载荷相机的仿真假设安装变换，不能用于Location.CamQuat。

## 可靠性与隔离

正式帧在staging完整解码、校验姿态/矩阵/六角/YOLO/相机/文件清单后发布。失败不得显示completed。重启将运行中任务标为interrupted，完整帧保留；无自动续跑。

V2工作区数据库含协议标识。打开已存在目录时先只读检查，旧/未标记数据库或非空未标记任务目录明确拒绝，不自动清空、不改写旧数据。安装默认使用%LOCALAPPDATA%/SatelliteDatasetStudioV2/workspace。

相机距离精度：顶层distance_m及observer_camera.distance_m记录请求配置；observer_camera.actual_distance_m记录Blender实际相机位置长度。渲染器以float32保存位置，校验仅接受请求double值或其最近float32值，且逆变换、投影矩阵必须与实际位置一致，不笼统放宽其他矩阵校验。
