# 核心服务实施记录

Task 2 对应 `docs/superpowers/plans/2026-09-19-first-working-migration.md`，接口以 `docs/architecture/interfaces.md` 为准。

## 已实施

- `domain/`：有限参数验证、不可变场景、xyzw 四元数、R_WB、带有效位的六角、固定包围球视场、CV 观察相机、独立载荷安装矩阵。
- 独立覆盖样本使用归一化四维高斯得到 Haar SO(3) 旋转，距离独立分层并打乱。完整覆盖任务生成 `coverage.json`，含逐轴 alpha、cos(beta) 分箱、最大空缺和距离分布；不宣称这些边缘统计证明完整联合覆盖。
- 连续任务从主种子确定初始 SO(3) 姿态和固定世界旋转轴，左乘步进四元数，邻帧点积非负。默认 120 帧、1 秒、1°/s、30→10 km；可用请求中的 `sequence` 对象设置 `start_distance_m`、`end_distance_m`、`time_step_s`、`angular_speed_deg_s`。单步旋转必须小于 180°。
- `datasets/`：输出 clean/noisy PNG、五列 YOLO TXT 和姿态 JSON。像素噪声顺序为泊松后高斯，使用主种子、模型 ID、六位帧 ID 的 SHA256 派生种子。关闭噪声时两张 PNG 的像素一致。
- 完整解码 1024² L 模式 PNG；交叉验证 YOLO、像素框、六角、四元数、旋转矩阵、观察相机、载荷相机、逐帧场景及文件标识。拒绝非有限 JSON、裁切框、损坏图像和标签不一致。
- `jobs/`：SQLite WAL/FULL 同步、不可变快照触发器、后台串行队列、惰性渲染器、完整帧标记与取消。首次 render 才启动 Blender；服务启动和预览不导入 bpy。
- `server/`：仅绑定 127.0.0.1；Host 和同源 Origin 检查，不启用 CORS；JSON 请求限制 64 KiB。静态站点只来自 `apps/ui/dist`，模型仅暴露登记的 GLB，数据仅暴露数据库登记的完整帧文件。不存在源码根目录映射。CSP 允许同源与 blob 资源连接，支持 Three.js 从 GLB 解码内嵌贴图。
- 工作目录使用操作系统独占文件锁，避免多个服务互相恢复或修改任务。HTTP 请求完成后才关闭 SQLite。

## 启动与宿主协议

```powershell
$env:PYTHONPATH = 'python/src'
python -m satellite_studio --project-root . --workspace var/workspace --blender 'C:/path/to/blender.exe' --port 0
```

stdout 的启动事件为一行 JSON，并立即 flush：

```json
{"event":"ready","port":54321,"url":"http://127.0.0.1:54321"}
```

`--port 0` 请求操作系统分配端口；默认 8765。日志进入 stderr 和工作目录的 `logs/service.log`。不指定 Blender 仍可使用模型预览，正式任务会进入 failed 并提供明确提示。

## 持久化、取消与恢复

每个任务位于 `workspace/jobs/<job_id>/`。提交时保存 `job.json` 和 SQLite 快照；帧先写 `.staging/<frame_id>/`，校验后逐个替换到四个正式子目录，最后才写数据库完整帧记录。未登记的残留文件不经 HTTP 暴露，也不增加完成数。

排队任务取消立即进入 canceled；运行任务按帧边界取消，已完成帧保留，在途帧不提交。取消请求返回 `cancel_requested=true`，正式渲染返回后更新终态。正常关闭会调用渲染器 close 终止所属 Blender，当前任务进入 interrupted。强制结束后，下一次打开数据库会将 running 标记为 interrupted；queued 任务仍可继续处理。中断任务首版通过重新提交重试，不续写旧任务。

保留 `.staging` 中断残留便于诊断，不自动删用户输出。源代码、原始资产和旧数据均未迁移覆盖。SQLite 完整帧登记避免显示半套产物；这不构成断电和存储设备损坏下的数据备份保证。

## 验证证据

先建立数学、参数、持久化和输出测试，首次运行因模块尚未实现失败；实现后 13 项通过。第二组先运行服务/队列缺失失败，再实现为 19 项通过。追加相机参数和非有限指数 JSON 篡改用例，观察到两个断言失败后补上校验；最终 23 项通过。

```powershell
$env:PYTHONPATH = 'python/src'
python -m unittest discover -s tests/python -v
```

使用 Codex 已提供的 Python/NumPy/Pillow 运行测试，无 pytest 或额外下载依赖。测试覆盖 4000 个 SO(3) 样本、400 帧跨 180° 序列、随机旋转往返、畸形参数、重启恢复、取消、损坏 PNG、错误标签/外参、复现噪声、假渲染器端到端任务、HTTP 下载、穿越路径、跨来源与 Host 拒绝、过大请求和工作目录锁。

此处的服务测试以测试渲染器隔离 Blender；六模型正式渲染与桌面验证由整体验收记录单独报告。JSON Schema 已提供用于交换文档，运行时还执行 schema 无法表达的旋转正交性、四元数非零及跨文件一致性校验。连续采样高级参数已在 API 支持，当前界面是否暴露这些字段以界面验收为准。

浏览器验收发现 CSP 未允许 blob 连接，新增响应头断言观察失败后修正。复测还复现 Windows 在请求体未读完时关闭套接字导致 413 响应被 TCP reset 吞掉（10 次中 3 次失败）；增加有字节/时间上限的拒绝体丢弃后，10 次拒绝均返回 413。浏览器关闭产生的常规连接断开单独处理，不隐藏应用异常。

## 实施裁定

- 无 Git 仓库，使用用户指定的新工程子目录隔离；无虚构提交。
- 预览任务需要实时显示进度，因此 `/data` 可读取任意状态任务中**已经登记完成的帧**，不要求整项任务 completed；失败或取消任务也能检查先前完整帧。这是对接口中“已完成任务产物”的保守帧级解释。
- 请求数量上限为 100000，保持六位帧编号并控制错误输入规模；超大任务可分次提交。
- 取消在正式帧返回时生效；关闭服务会主动打断渲染进程。未实现单独取消时即时终止 Blender 后重新拉起的策略。
