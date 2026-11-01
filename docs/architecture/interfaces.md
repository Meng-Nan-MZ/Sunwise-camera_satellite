# V2.3 本机接口与坐标契约

V2 仅使用 `satellite-pose-4.0` / `lh-client-world-v2`。不读取或迁移 V1 请求、任务数据库或 JSON。

## 坐标和四元数

世界/零姿态本体系为左手系：X 图像右、Y 从目标朝观测相机、Z 图像上。观测相机系为左手系：X 图像上、Y 图像左、Z 光轴朝目标。原点分别是目标中心和相机光心。

旋转为主动 local-to-world 列向量映射；使用 Hamilton 数值公式。界面为内禀 XYZ 角（度），所有对外四元数对象按 W、X、Y、Z 保存，单位长度。q 与 -q 表示同一旋转，连续序列保留相邻符号连续。内部数学函数采用 xyzw 数组仅是实现细节。

引擎适配矩阵 P 交换 Y/Z，R_engine = P R_client P.T，q_engine=(-x,-z,-y,w)。GLB/Blend 保持原有引擎几何；公开模型清单的 source_to_body 是源模型坐标到新本体系的变换。

## HTTP（同源，仅 127.0.0.1）

- GET /api/health：status、renderer_available、schema_version；V2.2.1 增加 renderers.blender/threejs，各含 available、reason。原 renderer_available 保留 Blender 可用性含义。
- GET /api/models：六模型名称、构型、半径、预览URL与哈希、source_to_body等。
- POST /api/jobs：202，返回任务。请求 mode=single/coverage/sequence/custom_sequence、count、scene、可选 renderer_backend=blender/threejs；sequence可带服务端轨迹参数。
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

零姿态SatQuat为{W:1,X:0,Y:0,Z:0}。正式观测相机位于世界(0,d,0)，默认CamQuat为{W:.5,X:.5,Y:-.5,Z:.5}。CamQuat由所选引擎实际观测相机矩阵转换，不取自由观察相机或目标载荷相机。

## 相机与投影元数据

observer_camera.camera_to_world和world_to_camera采用甲方相机轴。K以K_basis明确标为CV的X右/Y下/Z前像素投影基。camera_to_cv_rotation=[[0,-1,0],[-1,0,0],[0,0,1]]。

projection_world_to_pixel = K @ camera_to_cv_rotation @ world_to_camera[:3,:]。乘世界齐次点后除以第三分量得到像素坐标。不要直接将K乘到甲方相机坐标。

image_basis明确为右手的图像X右/Y上/Z朝观察者；image_basis_to_world=P@实际引擎相机旋转，是含换手性的基映射（行列式-1），不称为SO(3)旋转。payload_camera为独立载荷相机的仿真假设安装变换，不能用于Location.CamQuat。

## 可靠性与隔离

正式帧在staging完整解码、校验姿态/矩阵/六角/YOLO/相机/文件清单后发布。失败不得显示completed。重启将运行中任务标为interrupted，完整帧保留；无自动续跑。

V2工作区数据库含协议标识。打开已存在目录时先只读检查，旧/未标记数据库或非空未标记任务目录明确拒绝，不自动清空、不改写旧数据。安装默认使用%LOCALAPPDATA%/SatelliteDatasetStudioV2/workspace。

相机距离精度：顶层distance_m及observer_camera.distance_m记录请求配置；observer_camera.actual_distance_m记录实际相机位置长度。Blender以float32保存位置，校验仅接受请求double值或其最近float32值；Three.js矩阵保留double精度。逆变换、投影矩阵必须与实际位置一致，不笼统放宽其他矩阵校验。


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

## V2.2.1 网页正式采集

`renderer_backend` 提交后冻结，未带此字段的 API 请求和旧任务按 `blender` 解释；新界面默认明确提交 `threejs`。噪声版本不接受后端选择，复用来源记录。工作区标识与姿态协议仍为4.0，不重新解释旧数据；无自动引擎回退。

Three.js r180 在现有工作台持有专用隐藏画布，不复用交互预览对象、相机或画布。固定引擎相机 `(0,0,d)`、Y向上、朝原点，FOV与现有模型规则一致。目标仅应用一次 `q_engine=(-x,-z,-y,w)`；GLB 本身不再应用 source_to_body。包围框为实际可见层级、有效索引/drawRange/材质组提交三角形的连续像素投影框，不是遮挡或 alpha 分割框。超出图像或近远裁剪范围时明确拒绝，仅容忍边界浮点误差。主动骨骼、实例、变形和线/点对象明确拒绝，当前六模型支持。

配置 `threejs-detail-v1` 固定2048²采集、1024²输出，sRGB、ACESFilmic、曝光1.2、Rec709输出灰度、RoomEnvironment强度0.35、固定补光强度0.6、自阴影PCFSoft/2048。Python 完整解码2048²不透明灰度RGB/RGBA后以Lanczos缩到1024²、保存8位L模式PNG，再执行现有噪声、姿态、YOLO和逐帧验证。完整参数和实际抗锯齿状态写入 renderer.settings，共享核对夹具见 `tests/fixtures/web-capture-profile.json`。此配置允许外观变化，不作为真实相机辐射标定。

Three.js 的 model_sha256 和 renderer.asset_sha256 记录实际 GLB 摘要，asset_role=preview_glb；Blender 保持原 Blend 资产语义。逐帧 renderer 另含 name/version/profile_id/settings/render_ms、实际引擎 camera_world/projection_matrix。实际相机与冻结设置交叉校验后生成 observer_camera 和 Location.CamQuat。

网页桥接均为同源 POST，凭证仅在 JSON 中传输：

- `/api/render-worker/register`：空对象；返回 worker_token、lease_s=30、heartbeat_interval_s=5。
- `/api/render-worker/heartbeat` 与 `/poll`：`{worker_token}`；poll 最长0.25秒，返回 `{task:null}` 或 task（task_id、attempt_token、frame、model），无本地文件路径。
- `/api/render-worker/result`：`{worker_token,task_id,attempt_token,png_base64,metadata}`；错误结果用 error 代替 PNG/metadata。metadata 严格包含 bbox_xyxy、camera_world、projection_matrix、asset_sha256、three_revision、profile_id、settings、render_ms。矩阵按嵌套行保存。
- `/api/render-worker/release`：`{worker_token}`。无效/过期 worker 为403；有效 worker 提交过期、取消、重复 attempt 为409，不重试改身份。

一般请求仍限64KiB，结果请求限12MiB，解码PNG限8MiB，metadata限64KiB。验证严格base64、PNG签名/IEND/完整解码、大小/颜色/灰度/不透明性、资产摘要、引擎和配置、实际相机及投影。PNG解码和浏览器等待不持有任务数据库锁；完整帧文件发布与数据库标记共用短锁，与取消串行化。

同一时刻一个worker、一个活动帧；单帧90秒超时，心跳30秒租期。取消、释放、过期或关闭立即使当前attempt失效；图形上下文丢失后UI明确提示重连，受影响任务需重新提交。窗口关闭后重开将未完成任务标为interrupted，完整已生成帧保留。生产环境不依赖Node.js/Playwright或额外浏览器；网页采集要求工作台保持打开，Blender仅用于选择该后端的对照任务。

## V2.3 数据集保存位置

GET `/api/settings/output-directory` 返回 `{output_directory,default_output_directory}`；默认是当前工作区的 jobs 子目录。POST 同一地址只接受 `{output_directory:string}`，验证已有绝对目录及写权限后保存，返回同一对象。错误返回400，原设置保留；沿用同源、Host和请求体限制。设置存于原工作区数据库，不改变服务工作区或日志位置；读取设置不探测离线目录、不自动回退。

数据库以新增 nullable jobs.output_root 保存每个新任务的目录根，并禁止更新。旧任务 NULL 继续映射原工作区/jobs，原 snapshot、摘要及协议标识不变。新采集在提交时冻结当前首选目录，输出为 `<root>/<job_id>/`；更改设置不改变排队或已存在任务的位置。公开路径、staging、文件发布及data/source访问均根据该任务记录解析，仍只提供数据库已发布文件。

噪声版本始终冻结为规范来源任务的父目录，继续使用 satellite-noise-1.0 的 `../<source_job_id>/...` 引用；不跨盘引用、不复制源文件。界面提示此规则。外部目录失去访问能力时明确失败，无自动迁移、续跑或路径替换。目录解析和写探测不持有全局任务数据库锁。

桌面文件夹选择通过受限WebView2消息完成：请求 `{type:'satellite.select-output-directory',request_id,initial_directory}`，回复 `{type:'satellite.output-directory-selected',request_id,path,error?}`。仅接受当前服务同源消息、已知字段和有界字符串；一次一个主窗口拥有的系统选择窗口。取消时 path=null，只返回选择结果，不修改设置。界面按request_id关联回复；实际保存仍经上述POST。独立浏览器可手动输入路径，不提供通用本地文件系统或命令执行接口。
