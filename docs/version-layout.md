# V1 与 V2 的边界

- `SatelliteDatasetStudio-V1`：修改前完整副本，保留原程序、模型、任务数据、旧安装包、构建缓存和历史记录。
- `SatelliteDatasetStudio-V2`：从原代码建立的新版本，仅包含当前新协议的操作和读取路径；使用独立任务数据库。
- 原始 `SatelliteDatasetStudio` 仍原位保留，不由 V2 修改。
- 归档校验清单位于共同上级的 `version-archives/V1-manifest.json`。可重建的 node_modules、obj、__pycache__、开发 SDK 缓存不计入证据哈希；源码、模型、安装包和任务数据逐项核对。
- V2 安装标识 `B46CE219-98FD-430C-AC12-A09EC62CC127` 与 V1 不同；安装/卸载及快捷方式互不覆盖。
- Git 的 `v1-source-baseline` 标签记录改动前源码基线；模型、运行库和历史数据留在本地归档，不上传 GitHub。

V2 不包含 V1 旧协议任务读取、旧 JSON 导出或协议迁移功能；V1 结果用 V1 查看。同一 satellite-pose-4.0 协议下的 V2 系列历史任务仍保留读取能力，V2.4 可查看旧 Blender 任务及基于其已有原图追加噪声，但不再执行 Blender 采集。

说明：归档覆盖原工程目录内的数据；此前安装版在LocalAppData等外部位置的用户数据仍原位保留，本次未将这些外部目录搬入工程归档。最终再次核对了V1源码、资产、发行附件及原工程任务数据共1,506个文件，均与归档清单一致。
