# V2.1 本机接口与坐标契约

V2 仅使用 `satellite-pose-4.0` / `lh-client-world-v2`。不读取或迁移 V1 请求、任务数据库或 JSON。

## 坐标和四元数

世界/零姿态本体系为左手系：X 图像右、Y 从目标朝观测相机、Z 图像上。观测相机系为左手系：X 图像上、Y 图像左、Z 光轴朝目标。原点分别是目标中心和相机光心。

旋转为主动 local-to-world 列向量映射；使用 Hamilton 数值公式。界面为内禀 XYZ 角（度），所有对外四元数对象按 W、X、Y、Z 保存，单位长度。q 与 -q 表示同一旋转，连续序列保留相邻符号连续。内部数学函数采用 xyzw 数组仅是实现细节。

引擎适配矩阵 P 交换 Y/Z，R_engine = P R_client P.T，q_engine=(-x,-z,-y,w)。GLB/Blend 保持原有引擎几何；公开模型清单的 source_to_body 是源模型坐标到新本体系的变换。

## HTTP（同源，仅 127.0.0.1）

- GET /api/health：status、renderer_available、schema_version。
- GET /api/models：六模型名称、构型、半径、预览URL与哈希、source_to_body等。
- POST /api/jobs：202，返回任务。请求 mode=single/coverage/sequence/custom_sequence、count、scene；sequence可带服务端轨迹参数。
- GET /api/jobs、GET /api/jobs/<id>：队列及单任务状态。
- POST /api/jobs/<id>/cancel：请求取消；完整帧保留。
- GET /data/<job_id>/<relative_path>：仅访问已发布的逐帧产物。

Scene 必须包含 model_id 和 sat_quat={W,X,Y,Z}。支持 distance_m=10000..30000、resolution=1024、非负32位seed、noise={enabled,gaussian_sigma,poisson_peak}、lighting={azimuth_deg,elevation_deg,energy}。默认距离20000，噪声 .012/96，光照35°/28°/4。旧 quaternion_xyzw 输入明确拒绝；无 sat_quat 不会默认为零姿态。

Job状态为queued/running/completed/failed/canceled/interrupted；每次提交冻结参数。序列起止距离30000到10000、步长1秒、角速度1°/s。全姿态为SO(3)采样，六个相关角不独立随机。

## 正式输出

渲染帧保存images_clean/<id>.png、labels/<id>.txt、poses/<id>.json，开启噪声时再保存images_noisy/<id>.png。图像1024×1024、8位灰度。YOLO标准五列，姿态不插入TXT额外列。JSON包含：

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


## V2.1 自定义姿态序列

mode=custom_sequence时count为2..100000，必须提供trajectory.start_quat与end_quat（WXYZ对象），time_step_s可选，默认1秒。该模式不接受sequence配置；其他模式不接受trajectory。提交后参数完整冻结，已有V2任务快照继续可读。

姿态以t=i/(count-1)沿最短路径插值，包含首尾；距离始终采用scene.distance_m，光照、相机和其他场景参数固定。随机种子不改变姿态，只用于像素噪声。精确180°采用相对旋转轴最大绝对分量为正的确定性路径，q/-q表示变化不会改变物理轨迹。

自定义每帧带trajectory元数据，含type=shortest_path_slerp、归一化端点、count、time_step_s、t；timestamp_s=i*time_step_s、frame_index=i。元数据、当前姿态、场景快照和正式输出交叉校验。数据仍使用schema4.0与lh-client-world-v2，不改变已有字段含义。

UI预览采用同一数学标准。开始生成提交整个端点序列；生成当前单帧使用当前显示姿态，且不把trajectory字段带入single请求。

## V2.2 噪声版本

POST /api/jobs/<id>/noise-variants 接受 `{noise:{enabled:true,gaussian_sigma,poisson_peak},seed}`；seed 为显式 uint32，噪声范围与原 Scene.noise 一致。其他场景参数不接受。来源必须完成；已完成噪声版本会解析到原始渲染任务，形成一层引用。返回202和 mode=noise_variant 的新任务，沿用队列、取消与逐帧发布。

Job 增加 source_job_id、noise、seed、can_generate_noise 和 latest_images={clean,noisy}。没有可用图像的值为null；原 latest_image_url 保留。前端按显式 URL 选择图片，不替换路径推测文件存在。噪声版本的 clean URL 来自原任务同帧，noisy URL 来自本任务。

噪声版本只写 images_noisy/<id>.png、noise_meta/<id>.json 和 job.json，复用来源 images_clean、labels、poses，不复制、不改写。noise_meta 使用 satellite-noise-1.0，独立记录来源相对引用与 SHA256、噪声参数、master_seed/noise_seed、算法/实现版本和输出摘要。源姿态标签仍为原始拍摄记录。保留任务目录的同级关系即可整体移动工作区。

新关闭噪声的渲染帧省略 files.noisy；历史V2/V2.1已声明并发布的关闭噪声配对文件仍接受。姿态协议与工作区标识保持4.0，逐帧验证仍要求开启噪声时存在噪声图。噪声处理独立于渲染器和模型二进制，不触发 Blender。
