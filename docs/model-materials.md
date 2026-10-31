# 四款模型的材质更新

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

GLB 和 Blend 都嵌入所用贴图，运行时无需寻找外部贴图或联网。Three.js 与 Blender 共用 PBR 参数，但灯光、色彩管理和渲染器不同，颜色预览不承诺逐像素一致。

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

# 正式灰度渲染验收和独立彩色材质检查
& $runtime.python ./tools/verify_rendering.py --blender $runtime.blender --project-root $candidate --output ./var/model-update/formal-verification
& $runtime.blender --background --factory-startup --disable-autoexec --python-exit-code 1 --python ./tools/inspect_model_materials.py -- --project-root $candidate --output ./var/model-update/color-inspection

# 查看图像后安装；脚本限制只更新指定四款并保留备份
& $runtime.python ./tools/publish_model_update.py --staging $candidate
& $runtime.python -m unittest discover -s ./tests/assets -v
```

不要用旧 `prepare_assets.py` 的输出覆盖新资产而不再执行此更新流程。材质更新后必须重启已打开的软件；模型 URL 会带有 GLB 内容哈希，避免浏览器沿用旧模型缓存。旧图像任务保留原模型哈希，新任务记录本次模型哈希，以区分数据版本。

彩色检查脚本使用专门的展示灯光，不写回标准资产，也不代替正式数据集渲染。
