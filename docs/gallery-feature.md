# 画廊（Gallery）功能设计说明

> 在 LoRA Manager 的 Web UI 中新增画廊：浏览 ComfyUI 输出目录里的图片，对每张图点赞/点踩，
> 自动记录图中用到的**画师**与 **LoRA**，并按画师 / LoRA 聚合出「喜欢 / 不喜欢」统计。

## 1. 画师识别：为什么是 `@`

本项目面向 **Anima** 模型（CircleStone Labs × Comfy Org 的 2B 文生图模型）。其模型卡
*Prompting → Artist tags* 一节明确规定：

> Prefix artist with @. E.g. `"@big chungus"`. **You must put @ in front of the artist.**
> The effect will be very weak if you don't.

因此「用了哪个画师」这件事只能从**正向提示词里 `@` 开头的标签**读出来。三个由此确定的设计点：

1. **画师名保留空格。** Anima 要求 `@nnn yryr`、`@big chungus` 这种带空格的写法，
   所以按「逗号分段 → 段首为 `@` → 取 `@` 之后整段」解析，而不是按单词切分。
2. **只读正向提示词。** Anima 官方推荐负向提示词里就写着字面量 `artist name`，
   扫负向会凭空造出一个叫 "artist name" 的画师。
3. **画师表用于确认与归一化，两个来源合并。** 画师识别只依赖提示词里的 `@`，画师表负责：确认这个名字确实是画师、
   统一大小写与下划线/空格的写法差异、并给出规范拼写。表里查不到的画师**仍然记录**，只标记 `known: false`，避免静默丢数据。
   两个来源**互补**，因此合并使用（用户表在显示名上优先）：
   - **自带** `refs/danbooru_e621_merged.csv`：84,383 位画师（category 1 = danbooru、8 = e621），
     名称为下划线写法（`hammer_(sunset_beach)`），`_fold` 会与 Anima 的空格写法互相匹配。零配置即可用。
   - **可选用户画师表**（`gallery_artist_list_path`）：一行一个画师标签，通常是 Anima 的空格写法。
   实测合并后共 **104,472** 位：自带表能认出用户表里 61% 的画师，合并后 100%，
   且自带表额外带来 **53,268** 位用户表没有的画师。

兼容的写法（均有测试覆盖）：

| 提示词片段 | 解析结果 |
|---|---|
| `@nnn yryr, smile` | `nnn yryr` |
| `@big chungus. An anime girl with blonde hair.` | `big chungus` |
| `(@nnn yryr:1.2)` / `{@nnn yryr:1.5}` | `nnn yryr` |
| `@k.k. slider` | `k.k. slider`（不按句点截断） |
| `@alpha artist, @beta artist` | 两个画师 |
| `worst quality, artist name, blurry` | 无（负向词） |
| `c@rbon`、`asp@juken`、`civitai:123@456` | 无（`@` 属于名字/URN 的一部分） |

## 2. 后端结构

| 文件 | 职责 |
|---|---|
| `py/utils/artist_tags.py` | `@` 画师名提取；画师表加载（按 `路径+mtime+size` 缓存）；归一化 |
| `py/services/gallery/gallery_cache.py` | SQLite 持久化：图片事实、画师/LoRA 子表、评分、聚合查询 |
| `py/services/gallery/gallery_indexer.py` | 输出目录解析、目录遍历、单张图片的元数据解析 |
| `py/services/gallery/gallery_service.py` | 单例；扫描编排与进度；列表/评分/统计；图片白名单校验 |
| `py/routes/gallery_route_registrar.py` | 声明式路由注册（沿用仓库既有 registrar 约定） |
| `py/routes/handlers/gallery_handlers.py` | HTTP 处理器：参数校验 → 服务 → 统一 JSON 契约 |
| `py/routes/gallery_routes.py` | 控制器与 `GET /gallery` 页面渲染 |

**元数据解析完全复用既有管线**，没有写第二个解析器：
`ExifUtils._load_structured_metadata()` 取出 PNG/JPEG/WebP/AVIF 里的内嵌块，
再交给 `extract_generation_metadata()` —— 它会沿着 KSampler 的真实连线遍历
ComfyUI 图（因此能正确抓到 `LoraLoaderModelOnly` 这类其他解析器会漏掉的节点），
同时也能读 A1111 的 `parameters` 文本。

### 数据库

位置：`{设置目录}/cache/gallery/gallery.sqlite`

```sql
gallery_images(image_path PK, file_name, mtime, size, width, height,
               prompt, negative_prompt, parser, gen_params_json,
               rating, rated_at, indexed_at, has_metadata)
gallery_image_artists(image_path, artist_name, canonical_name, known,
                      PRIMARY KEY(image_path, artist_name))
gallery_image_loras(image_path, lora_name, weight, exists_locally,
                    PRIMARY KEY(image_path, lora_name))
gallery_meta(key PK, value)
```

画师与 LoRA 拆成子表，是为了让统计变成一次 `GROUP BY` 而不是全表 JSON 扫描。
`rating` 存在主表且**重扫时不覆盖** —— 评分是用户数据，不可再生。

### 两条刻意的安全设计

- **重扫不会因为扫描范围变化而丢评分。** 删除只针对「文件确认已不存在」的行，
  而不是「本次没扫到」的行。所以关掉递归、或撞到图片数量上限，都不会误删嵌套目录的评分。
- **图片只服务扫描根目录内的文件。** `GET /api/lm/gallery/image` 用
  `commonpath` 做包含性校验（业务路径 `abspath`，不解析符号链接，符合仓库约定），
  并限制扩展名，构造 `path` 无法读取磁盘其他位置。

## 3. API 契约

全部位于 `/api/lm/gallery`，响应统一为 `{"success": bool, ...}`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/lm/gallery/images` | 分页列表。参数 `page`、`page_size`、`sort`(`newest/oldest/rating_desc/rating_asc/name`)、`rating`(`all/liked/disliked/unrated`)、`artist`、`lora`、`q` |
| POST/GET | `/api/lm/gallery/rating` | `{"image_path","rating"}`，rating 取 `1/-1/0` |
| GET | `/api/lm/gallery/stats` | `by`(`artist/lora`)、`sort`(`net/likes/dislikes/total/ratio`)、`limit`、`min_total` |
| POST/GET | `/api/lm/gallery/index` | 启动后台扫描，`force=1` 强制重新解析 |
| GET | `/api/lm/gallery/index/status` | 扫描进度：`running/stage/progress/total/added/updated/removed/failed/root/root_source/error` |
| GET | `/api/lm/gallery/image?path=` | 图片字节流（含包含性校验） |
| GET | `/api/lm/gallery/config` | 生效的输出目录、目录来源、画师表状态、已索引数量 |
| GET | `/gallery` | 页面 |

同时通过 `/ws/fetch-progress` 广播 `{"type": "gallery_index_progress", ...}`，
与仓库既有的扫描进度约定一致（也支持轮询 `index/status`）。

## 4. 设置项

新增于 `DEFAULT_SETTINGS`（`py/services/settings_manager.py`）：

| 键 | 默认 | 说明 |
|---|---|---|
| `gallery_output_path` | `""` | ComfyUI 输出目录。**留空则自动取 ComfyUI 自己的 output 目录**；显式填写是 ComfyUI 不在本机（例如 standalone 模式）时的唯一可用方式 |
| `gallery_artist_list_path` | `""` | **可选**的画师表（一行一个画师标签）。留空也能用：自带的 `refs/danbooru_e621_merged.csv`（84,383 位画师）会自动参与归一化；填了则与自带表合并，你的表在显示名上优先 |
| `gallery_recursive` | `true` | 是否扫描输出目录的子目录 |
| `gallery_sort` | `"newest"` | 记住的排序方式 |

## 5. 测试

```bash
# 后端（本机沙箱需先钉住设置目录，否则导入期 Config() 会去写真实用户目录）
export LORA_MANAGER_SETTINGS_DIR=/tmp/lm-settings     # Windows: $env:LORA_MANAGER_SETTINGS_DIR="..."
pytest tests/utils/test_artist_tags.py tests/services/test_gallery_service.py tests/routes/test_gallery_handlers.py

# 前端
npx vitest run tests/frontend
```

覆盖范围：画师解析的全部边界写法、Anima 负向词不产生幻影画师、
ComfyUI 图与 A1111 文本两种来源、`LoraLoaderModelOnly` 的 LoRA 抓取、
无元数据图片的降级、递归开关与删除后的剪枝、**重扫保留评分**、
统计聚合与排序、列表各过滤器、分页、包含性校验与扩展名白名单、
路由注册完整性、评分接口的参数校验。

## 6. 已知限制 / 后续可做

- **画师表只用于确认，不做模糊匹配。** 表里没有的拼写会作为独立画师统计（标 `known: false`）。
  若同一画师的拼写变体很多，后续可加别名匹配（自带 CSV 的第 4 列就是别名，目前未使用）。
- **不带括号消歧的画师更依赖画师表。** 提示词里只写了 `@name` 时，同一 `name` 在不同作品下可能是不同画师；
  画师表能消歧但不会猜测，未命中就按原样统计。
- **不做服务端缩略图。** 卡片直接加载原图并配合浏览器懒加载；
  与仓库现状一致（`/api/lm/previews` 同样直接流式返回原图），但大图多时首屏偏重。
- **`exists_locally` 依赖 LoRA 扫描器缓存**，冷缓存时统一为 `false`（仅影响角标显示）。
