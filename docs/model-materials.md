# 四款模型的材质更新与离线制作

## V2.5 新增12套资源

V2.5保留本文原四款重建材质与其余两款旧资产，另外接入GOES-R、Sentinel-6、SWOT新版、Europa Clipper、哈勃贴图版、PACE、Landsat 4-5、韦布展开版、NISAR、SMAP、Landsat 9和Chandra。新增哈勃是独立变体，不修改旧哈勃。

`tools/import_curated_models.py`读取原始资源库的清单与自包含GLB，验证源哈希，在开发端离线解压几何、合并世界变换并按真实顶点包围盒中心归零。保留原作者数值尺度；该比例并未独立校准为实物米制。规范化结果为无额外解码器依赖的静态GLB，应用运行不调用Blender。

新增模型的每个目录保留`ATTRIBUTION.txt`、`provenance.json`、`asset-audit.json`。源素材和输出GLB均不上传Git；来源页、使用条款、哈希、坐标变换与未标定说明保存在文本记录中。每帧姿态JSON的`model_provenance`复制服务端记录的来源与尺度信息。使用前请按提供方的原始说明处理素材授权及归属。

重新准备时先关闭采集软件，再调用本机离线Blender：`blender --background --factory-startup --disable-autoexec --python-exit-code 1 --python tools/import_curated_models.py -- --source-library <原始资源库路径> --project-root <V2工程路径>`。重复导入会复用已核验的同一资产，`--rebuild`才重新生成；不要覆盖旧六模型ID。

下文保留此前四款模型的制作依据。

本文描述开发端离线模型制作。V2.4 应用只读取已准备好的 GLB；Blender 和 Blend 原文件可为转换、编辑及历史留存单独保留，不进入新版应用运行依赖或发行包。

本次更新 Sputnik-1、GPS、Galileo、GLONASS。INSAT-3B 和 Hubble 的 GLB/Blend 文件保持原版本。

## 资产来源与外观

源压缩包：`02-四个卫星模型.zip`，SHA256：`435ebce83a05af50745d21e4ebccefebb91fb5ead8fb425daaeb745b39dba416`。

| 模型 | 使用的几何 | 材质处理 |
| --- | --- | --- |
| Sputnik-1 | `sputnik1.obj` | 保留逐角 UV，接入原包的漫反射和法线贴图，重新设置金属度、粗糙度 |
| GPS | `Satellite_GPS.obj` | 金色隔热层、蓝色电池片、银色金属结构 |
| Galileo | `Satellite_Galileo.obj` | 金色隔热层、蓝色电池片、银色金属结构 |
| GLONASS | `Satellite_Glonass.obj` | 金色隔热层、蓝色电池片、银色金属结构 |

三款导航模型的 OBJ 缺少所引用的 MTL；`.max` 中的原生材质不能由当前转换工具直接恢复。因此这些模型的材质是重建的艺术外观，隔热层凹凸使用原包的 `tin foil bump.jpg`，电池片栅格由脚本生成。不是原厂配色或经过物理标定的表面光学参数。

GLB 和离线保留的 Blend 都嵌入所用贴图。V2.4 运行时只需 GLB，无需寻找外部贴图或联网。Three.js 与历史 Blender 出图的灯光、色彩管理不同，不承诺跨引擎逐像素一致。

“自由观察”显示彩色材质；“拍摄视角”及正式数据集保持灰度。更换材质会改变图像亮度与反射，但不改变姿态协议、模型坐标系或原有仿真尺寸。OBJ 单位未经物理核实，配准尺寸沿用此前仿真模型；详见 [配准与分区配方](../assets/recipes/four-satellites/README.md)。

## 存储

- `assets/sources/four-satellites/`：保留解压后的购买素材，不入源码版本控制。
- `assets/recipes/four-satellites/`：源文件哈希、坐标变换和按 OBJ 原始面序号保存的材质分区。
- `assets/textures/four-satellites/`：生成的 PBR 贴图，可重建。
- `assets/models/<id>/`：供软件使用的 `preview.glb` / `render.blend`。
- `var/model-update/`：转换日志、候选资产、验收图、旧版备份。

源包已按各卫星原有子目录解压。Sputnik 贴图位于其目录下的 `textures/`，导航模型嵌套 RAR 内容位于各自目录下的 `native/`。原始文件与候选生成结果均不散放到工程根目录。

## 重建与安装

在工程根目录运行，普通 Python 需要 NumPy/Pillow，Blender 使用配置中的版本。先关闭正在采集的工作台，以便替换后重新加载完整清单。

```powershell
$runtime = Get-Content ./var/runtime.json | ConvertFrom-Json
$sources = './assets/sources/four-satellites'
$textures = './assets/textures/four-satellites'
$recipes = './assets/recipes/four-satellites'
$candidate = './var/model-update/candidate'

& $runtime.python ./tools/model_assets/textures.py --sources $sources --output $textures
& $runtime.blender --background --factory-startup --disable-autoexec --python-exit-code 1 --python ./tools/build_four_models.py -- --sources $sources --textures $textures --recipes $recipes --output $candidate

# 开发端独立彩色材质检查；正式灰度图由新版工作台网页采集验收
& $runtime.blender --background --factory-startup --disable-autoexec --python-exit-code 1 --python ./tools/inspect_model_materials.py -- --project-root $candidate --output ./var/model-update/color-inspection

# 查看图像后安装；脚本限制只更新指定四款并保留备份
& $runtime.python ./tools/publish_model_update.py --staging $candidate
& $runtime.python -m unittest discover -s ./tests/assets -v
```

不要用旧 `prepare_assets.py` 的输出覆盖新资产而不再执行此更新流程。材质更新后必须重启已打开的软件；模型 URL 会带有 GLB 内容哈希，避免浏览器沿用旧模型缓存。旧图像任务保留原模型哈希，新任务记录本次模型哈希，以区分数据版本。

彩色检查脚本使用专门的展示灯光，不写回标准资产，也不代替正式数据集渲染。

历史 Blender 验收入口属于旧版本，V2.4 不再使用它们执行正式采集。安装候选 GLB 后，使用当前工作台和 `tools/verify_v24_workbench.cjs` / `tools/verify_v24_images.py` 检查真实网页图片及标注；Node.js/Playwright 仅用于开发验收，不是用户运行依赖。

## V2.5.1 自制模型与哈勃去重

新增用户提供的`原创遥感卫星.glb`和`SAR雷达卫星.glb`，离线准备为`original_remote_sensing`与`sar_radar`，运行时仍共用GLB进行预览及正式出图。保留原作者数值尺度，未独立标定实星尺寸；来源、源摘要、材质审核和坐标整理记录分别见模型目录的`provenance.json`与`asset-audit.json`。原文件保持不变，不推断公开再分发许可。

原`hubble`与V2.5新增`hubble_textured`来源重复，新任务选择只保留`hubble`。后者标为不可选，仅保留冻结任务所需的原资产和标识；既有任务不迁移、不改姿态协议，也不把旧模型参数映射为另一个准备版本。
