# V2 实现边界

新协议定义见 architecture/interfaces.md 和 superpowers/specs/2026-10-31-v2-client-coordinates-design.md。

公开场景使用 sat_quat={W,X,Y,Z}；纯数学函数可在内部用 xyzw 数组。V2.4 正式绘制使用 apps/ui 的独立隐藏 Three.js 采集画布，rendering/browser_renderer.py 校验结果。目标仅在引擎边界转换一次，GLB 不二次居中、不镜像更换。

任务提交冻结参数、SQLite 持久化、逐帧 staging 校验后提交的流程继续使用。所有对外姿态与矩阵采用新协议，CamQuat 来自实际正式观测相机。

V1 历史协议实现与验收记录留在 V1，不作为 V2 的当前接口文档。

新请求省略 renderer_backend 时采用 threejs；历史快照省略该字段时仍按原 Blender 定义读取。新请求显式 Blender 被拒绝，历史排队 Blender 任务明确失败。已完成旧任务查看及噪声处理独立于三维引擎，离线模型制作与历史渲染证据不作为新版运行依赖。
