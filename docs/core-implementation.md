# V2 实现边界

新协议定义见 architecture/interfaces.md 和 superpowers/specs/2026-10-31-v2-client-coordinates-design.md。

公开场景使用 sat_quat={W,X,Y,Z}；纯数学函数可在内部用 xyzw 数组。正式绘制在 rendering/scene.py 通过统一坐标适配转换到 Blender，引擎模型不二次居中、不镜像更换。

任务提交冻结参数、SQLite 持久化、逐帧 staging 校验后提交的流程继续使用。所有对外姿态与矩阵采用新协议，CamQuat 来自实际正式观测相机。

V1 历史协议实现与验收记录留在 V1，不作为 V2 的当前接口文档。
