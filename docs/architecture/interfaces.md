# 第一阶段模块接口

## 根目录与运行目录

工程根目录包含源码与配置。`var/` 是忽略版本控制的开发运行目录，含日志、缓存、SQLite、任务与生成数据；发行版运行数据位于用户选择的工作目录。旧版及其数据原位保留。

## HTTP 接口（仅 127.0.0.1，同源资源，不启用 CORS）

- `GET /api/health` → `{status:"ok", renderer_available:boolean, schema_version:"satellite-pose-3.0"}`。
- `GET /api/models` → 模型数组；每项 `{id,name,configuration,radius_m,preview_url,sha256,source_to_body,installation_source}`。`preview_url` 为 `/assets/models/<id>/preview.glb`。几何已经变换至 B 系、米制、原点居中，前端不可再次缩放/居中。
- `POST /api/jobs` → 202，任务对象。请求 `{mode:"single"|"coverage"|"sequence",count:number,scene:Scene}`；single count=1，coverage 默认1000，sequence 默认120。每任务独立目录，每帧序号从000001起。
- `GET /api/jobs` → 最新任务数组。
- `GET /api/jobs/<id>` → 一个任务；`POST /api/jobs/<id>/cancel` → 任务对象。
- `GET /data/<job_id>/<relative_path>` → 本工作区已完成任务产物。拒绝路径穿越。
- 错误统一 `{error:string}`，400 参数错误、404不存在、500内部错误。

`Scene`：`{model_id:string,quaternion_xyzw:[x,y,z,w],distance_m:number,resolution:1024,seed:20260919,noise:{enabled:true,gaussian_sigma:0.012,poisson_peak:96},lighting:{azimuth_deg:35,elevation_deg:28,energy:4}}`。旋转主动映射 B→W，世界 Y 朝上、相机在+Z，Three.js 相机 up=(0,1,0)。10,000≤distance_m≤30,000。首版正式输出固定1024，拒绝其他值。所有数必须有限；seed为非负32位整数。

`Job`：`{id,mode,status,completed_frames,total_frames,created_at,error,latest_image_url,output_directory}`。status取 queued/running/completed/failed/canceled/interrupted。场景快照不可变；SQLite持久化，重启后running→interrupted，已有完整帧保留，首版重新提交可重试。

## 核心与渲染接口

纯Python域逻辑不依赖 bpy。`rendering/client.py` 由根实施者提供 `BlenderRenderer(project_root:Path,blender_path:Path,log_dir:Path)`，方法 `render(frame:dict, output_directory:Path)->dict`、`close()`。第一次render才启动常驻后台进程；每次串行一个请求。输出目录由调用者创建为单帧临时目录。

`frame`：`{frame_id,model_id,quaternion_xyzw,distance_m,resolution,seed,noise,lighting,sequence_id,frame_index,timestamp_s}`。

render写 `clean.png`（1024²灰度8位），返回 `{bbox_xyxy:[xmin,ymin,xmax,ymax],radius_m,fov_y_rad,model_sha256,renderer:{name,version},source_to_body}`。bbox像素坐标由正式、求值后的几何投影计算，不截断掩盖越界。调用者生成noisy.png和姿态/YOLO等文件。

每帧正式产物为 `images_clean/<frame_id>.png`、`images_noisy/<frame_id>.png`、`labels/<frame_id>.txt`、`poses/<frame_id>.json`。核心对临时产物完整解码与校验后提交，frame完成记录最后写入。命名仅由内部ID生成。

模型清单 `assets/models/index.json` 为模型对象数组，含上述字段，另含 `blend_file:"assets/models/<id>/render.blend"`、`preview_file:"assets/models/<id>/preview.glb"`。模型文件不通过外网加载。

## Windows 宿主

WPF + WebView2 仅负责本机服务进程、窗口与导航。开发服务也可使用浏览器访问。启动参数通过工具脚本传递运行时路径，不硬编码开发者账户。构建产物进入 `var/build`；依赖放 `var/tools` 或发行目录，不进入源码根目录。
