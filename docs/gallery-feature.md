# 画廊（Gallery）功能设计说明

> 在 LoRA Manager 的 Web UI 中新增画廊：浏览 ComfyUI 输出目录里的图片，对每张图按
> **+3 / +1 / −1 / −3 四档**评分，自动记录图中用到的**画师**与 **LoRA**，并按画师 / LoRA
> 聚合出加权偏好统计。

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
| `py/services/gallery/gallery_indexer.py` | 输出目录解析、目录遍历、单张图片的元数据解析；提示词里的 LoRA 名 → 本地 sha256（`build_lora_index` / `resolve_lora_hash`） |
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
gallery_image_loras(image_path, lora_name, weight, exists_locally, lora_hash,
                    PRIMARY KEY(image_path, lora_name))
gallery_meta(key PK, value)
```

画师与 LoRA 拆成子表，是为了让统计变成一次 `GROUP BY` 而不是全表 JSON 扫描。
`rating` 存在主表且**重扫时不覆盖** —— 评分是用户数据，不可再生。

`rating` 是四档评分：`+3`（特别中意）、`+1`（喜欢）、`-1`（不喜欢）、`-3`（特别讨厌），
`0` 表示未评分。强度就是权重：统计里的加权得分 `score = Σ rating`，因此一张「特别中意」
的图等于三张「喜欢」。旧存档里的 `±1` 原样保留、无需迁移。

`lora_hash` 是后加的列（老库靠 `ALTER TABLE ... ADD COLUMN` 就地迁移，不需要重建），
存的是这个 LoRA 名在**本机 LoRA 库**里解析出的 sha256 —— 画廊 → LoRA 页的跳转就靠它。
冷缓存时为空，只是暂时没有跳转入口，不影响评分与统计。

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
| GET | `/api/lm/gallery/images` | 分页列表。参数 `page`、`page_size`、`sort`(`newest/oldest/rating_desc/rating_asc/name`)、`rating`(`all/loved/like/dislike/hate/unrated`，精确到四档；`positive/negative`、`liked/disliked`、`hated` 为兼容别名)、`metadata`(`all/with/without`)、`artist`、`lora`、`q` |
| POST/GET | `/api/lm/gallery/rating` | `{"image_path","rating"}`，rating 取 `3/1/-1/-3/0` |
| GET | `/api/lm/gallery/summary` | 全库评分分布：`images/rated/unrated/liked/disliked/loved/hated/score/net/levels{love,like,dislike,hate}/like_ratio`，供侧栏分档计数与分布条使用 |
| GET | `/api/lm/gallery/stats` | `by`(`artist/lora`)、`sort`(`score/loved/liked/disliked/hated/likes/dislikes/net/total/ratio`，默认 `score` 加权得分)、`limit`、`min_total`；每行带 `score`、`net`、`levels{love,like,dislike,hate}` 与 `images` 样本缩略图 |
| POST/GET | `/api/lm/gallery/index` | 启动后台扫描，`force=1` 强制重新解析 |
| GET | `/api/lm/gallery/index/status` | 扫描进度：`running/stage/progress/total/added/updated/removed/failed/root/root_source/error` |
| GET | `/api/lm/gallery/image?path=` | 图片字节流（含包含性校验） |
| GET | `/api/lm/gallery/config` | 生效的输出目录、目录来源、画师表状态、已索引数量 |
| GET | `/api/lm/gallery/for-lora` | 用过某个 LoRA 的图（LoRA 弹窗的 Gallery 标签用）。参数 `hash` 或 `name` 二选一（都没有返回 400）、`page`、`page_size`；响应里的 `lora` 回显解析到的名字与 hash |
| GET | `/gallery` | 页面 |

图片记录里的每个 LoRA 带 `name` / `weight` / `exists_locally` / `hash`（`hash` 为空表示
没解析到本地模型）；统计表的 LoRA 行也可能带 `hash`，只有名字时前端再调一次 `for-lora` 换 hash。

同时通过 `/ws/fetch-progress` 广播 `{"type": "gallery_index_progress", ...}`，
与仓库既有的扫描进度约定一致（也支持轮询 `index/status`）。

## 4. 界面与交互细节

页面是「固定侧栏 + 内容区」两栏：侧栏承载开关与筛选，内容区在「图片」与「统计」两个视图间
切换，切换不重建侧栏。

### 四档评分怎么落到界面上

强度就是权重，所以界面必须让人**一眼看出档位**，而不是把强度藏在图标后面：

- **卡片按钮**：每张卡片底部一排四个按钮，直接显示 `+3 / +1 / −1 / −3`；命中档位实心填充，
  弱档（±1）着色、强档（±3）实心，点当前档位再点一次即清除。悬停提示同时给出该档的键盘快捷键。
- **键盘**：`↑ / U` = +1，`Shift+↑ / I` = +3，`↓ / D` = −1，`Shift+↓ / K` = −3；
  `←/→/Home/End` 在卡片间移动焦点（每张卡是 roving focus 的焦点单元），`Enter` 打开大图。
  键盘评分是刻意保留的主路径：一屏几十张图时，鼠标来回点按钮太慢。
- **大图查看器**：共享的 `MediaViewer` 新增两个可选钩子（`footer(container, item, index)` 与
  `onKey(event, index)`），画廊借此在底部放一条四档评分条——判断一张图要在原尺寸下看，
  所以评分不能要求先关掉查看器；`←/→` 翻页仍然归查看器，评分键由画廊优先消费。
- **投票即时反映**：卡片与大图评分条先乐观更新，接口失败再回退并 toast。
  若当前筛选是「未评分」而这张图刚被评了分，卡片会**就地移出网格**（不整页重载、不丢滚动位置）。
- **分布与计数去抖刷新**：一次评分只触发一次统计/侧栏刷新（400ms 合并），连续键盘投票不会打出一串请求。

### 侧栏：四档筛选与分布

侧栏不再用「点赞 / 点踩」下拉框，而是六个**分档切片**：`全部 / +3 / +1 / −1 / −3 / 未评分`，
每个切片带全库计数（来自 `/api/lm/gallery/summary`），上方显示加权得分，下方是一条四段分布条。
未评分部分画成空白轨道而不是第五种颜色——它表示「还没决定」，不是一种偏好。
侧栏底部还会显示「已评分 N / M」：排名是否可信，取决于这个比例。
切片点击即筛选（`rating=loved|like|dislike|hate|unrated`），**再点当前档位即取消**（回到全部），
与排序、元数据、画师/LoRA 芯片、关键词筛选可叠加；筛选条件仍由「清除筛选」横幅统一清除。

### 统计视图：四档而非两侧

- 汇总卡：`图片 / 已评分 / +3 / +1 / −1 / −3 / 加权得分`，四档沿用侧栏的分档配色，
  加权得分带正负色。
- 排行卡：**加权得分单独放在卡片右上角的大号色块里**（正分绿、负分红，可点击按得分排序），
  因为榜单首先就是按这个数读的；下面一行是四档**精确计数**（旧的 👍/👎 只能说明两侧，
  无法区分强弱），每个计数既是数值也是排序按钮（`sort=loved|liked|disliked|hated`），
  再下面是四段分布条与点赞率。
- 排序 pill：`加权得分 / +3 / −3 / 总数 / 点赞率`。`likes/dislikes/net` 作为兼容键仍由后端接受。
- LoRA 弹窗的 Gallery 标签摘要同样按四档显示（`for-lora` 的 `summary.levels`）。

## 5. 与 LoRA 页的互相联通

画廊里的 LoRA 和 LoRA 库里的模型是同一个东西，所以两边互相能跳；两个方向都是**显式动作**，
不会因为点错地方而顶掉对方正在看的视图。

| 方向 | 入口 | 行为 |
|---|---|---|
| 画廊 → LoRA 页 | 卡片上 LoRA 芯片**旁边**的 ↗ 按钮 | `openModelInLoraPage(hash)` → `/loras?model=<sha256>`，直接打开那个模型的弹窗 |
| 画廊 → LoRA 页 | 统计表 LoRA 分组每行的 ↗ 按钮 | 同上；行里只有名字（没有 hash）时先调 `for-lora` 换成 hash 再跳 |
| LoRA 页 → 画廊 | 模型弹窗里的 **Gallery** 标签（仅 `loras` 类型） | `GalleryTab.js` 调 `/api/lm/gallery/for-lora`，列出用过这个 LoRA 的图 |

- **芯片本身仍然只做过滤**（点击 = 按这个 LoRA 筛图），跳转是旁边一个独立的图标按钮。
  两个动作语义不同，不共用同一次点击；两个按钮都带 `data-lora-hash` 与共享类
  `gallery-open-lora`，页面脚本与测试按同一个选择器找「打开模型」这个动作。
- **只有解析到本地模型的 LoRA 才有 ↗**：名字对不上、或一个名字匹配到多个文件
  （无法确定是哪一个）时不给按钮，芯片照旧可以过滤。
- hash 来自扫描阶段：把提示词里的 LoRA 名对照 LoRA 库缓存解析成 sha256，
  写进 `gallery_image_loras.lora_hash`。冷缓存时为空，只是暂时没有 ↗。
- 深链本身是仓库既有能力（`static/js/utils/modelDeepLink.js`，`/loras?model=<sha256>`），
  画廊复用它而不是另造一套。

前端文件：

| 文件 | 职责 |
|---|---|
| `static/js/utils/modelDeepLink.js` | 构造/解析 `/loras?model=<sha256>` 深链；按 hash 取模型并打开弹窗 |
| `static/js/components/shared/GalleryTab.js` | 模型弹窗的 Gallery 标签：加载、空态、失败态 |
| `static/js/gallery.js` | 两处 ↗ 按钮的渲染与点击分流（`gallery-open-lora` / `[data-lora-hash]`） |

## 6. 设置项

新增于 `DEFAULT_SETTINGS`（`py/services/settings_manager.py`）：

| 键 | 默认 | 说明 |
|---|---|---|
| `gallery_output_path` | `""` | ComfyUI 输出目录。**留空则自动取 ComfyUI 自己的 output 目录**；显式填写是 ComfyUI 不在本机（例如 standalone 模式）时的唯一可用方式 |
| `gallery_artist_list_path` | `""` | **可选**的画师表（一行一个画师标签）。留空也能用：自带的 `refs/danbooru_e621_merged.csv`（84,383 位画师）会自动参与归一化；填了则与自带表合并，你的表在显示名上优先 |
| `gallery_recursive` | `true` | 是否扫描输出目录的子目录 |
| `gallery_sort` | `"newest"` | 记住的排序方式 |

## 7. 测试

```bash
# 后端（本机沙箱需先钉住设置目录，否则导入期 Config() 会去写真实用户目录）
export LORA_MANAGER_SETTINGS_DIR=/tmp/lm-settings     # Windows: $env:LORA_MANAGER_SETTINGS_DIR="..."
pytest tests/utils/test_artist_tags.py tests/services/test_animadex_artists.py \
       tests/services/test_gallery_service.py \
       tests/routes/test_gallery_handlers.py tests/routes/test_gallery_integration.py

# 前端（画廊页面 / LoRA 弹窗 Gallery 标签 / 共享查看器 / 深链）
npx vitest run tests/frontend
```

覆盖范围：画师解析的全部边界写法（含 Anima 的转义括号）、负向词不产生幻影画师、
ComfyUI 图与 A1111 文本两种来源、`LoraLoaderModelOnly` 的 LoRA 抓取、
无元数据图片的降级、递归开关与删除后的剪枝、**重扫保留评分**、
统计聚合与排序（含**按精确档位 loved/hated 排序**与四档计数）、
**四档评分**（每档独立计数、加权得分、`like_ratio` 在无评分时为 null）、
列表各过滤器（精确四档 + 两侧兼容别名 / **元数据有无** / 画师 / LoRA / 关键词）及其组合、
分页总计、包含性校验与扩展名白名单、路由注册完整性（含 summary 端点）、评分接口的参数校验、
**LoRA 名 → hash 解析（名字对不上 / 一个名字多个文件时留空）**、
**画廊 ↔ LoRA 页跳转**（芯片旁的 ↗ 只跳转不过滤、芯片本身仍过滤、
统计行只有名字时先解析再跳、解析失败给提示且不跳）。

前端用例另外覆盖：四档按钮与键盘快捷键、侧栏分档切片的计数/筛选/分布条、
**在大图查看器里评分**（footer 与 onKey 两个钩子、翻页后评分条跟随）、
评分后不匹配当前筛选项的卡片就地移出、统计页四档指标与排序 pill。

## 8. 已知限制 / 后续可做

- **画师表只用于确认，不做模糊匹配。** 表里没有的拼写会作为独立画师统计（标 `known: false`）。
  若同一画师的拼写变体很多，后续可加别名匹配（自带 CSV 的第 4 列就是别名，目前未使用）。
- **不带括号消歧的画师更依赖画师表。** 提示词里只写了 `@name` 时，同一 `name` 在不同作品下可能是不同画师；
  画师表能消歧但不会猜测，未命中就按原样统计。
- **缩略图按需生成并落盘缓存**（`/api/lm/gallery/thumbnail`，WebP），设置页可查看占用并清空；
  冷缓存时首屏仍要等一次生成。
- **`exists_locally` 依赖 LoRA 扫描器缓存**，冷缓存时统一为 `false`（仅影响角标显示）。
- **LoRA 跳转入口同样依赖扫描器缓存。** 冷缓存（还没扫过 LoRA 库）时解析不出 hash，
  芯片上的 ↗ 暂时不出现；扫描完成后重扫一次画廊即可补上。
  一个 LoRA 名在本机匹配到**多个**文件时不猜，按"无法确定"处理，不给跳转入口。
- **侧栏分数刷新是去抖的**：评分后 400ms 才重新拉 `/summary`，极端情况下快速连评的计数会比
  卡片晚一拍；这是刻意的取舍（避免键盘连评打出一串请求）。

## 9. 画师排行只看 animadex

艺术家排行本身只统计本地评过分的画师。统计页工具栏多了一个 **animadex only** 开关，打开后只保留
animadex.net 画师目录里也有同名条目的画师，用来看自己常用的画师里哪些已被 animadex 收录。

- **目录镜像**（`py/services/gallery/animadex_artists.py`）：animadex 的画师搜索接口
  `GET https://animadex.net/api/artists/search?q=&page=N` 是公开的、不需要 token，固定 36 条/页
  （当前约 15.9k 位画师、442 页）。第一次启用时在后台抓全部页（8 并发）建进程内单例索引，
  结果写到 `<缓存目录>/gallery/animadex_artists.json`，TTL 7 天；刷新失败但有旧缓存时继续用旧索引
  （`error` 里记原因），完全没有数据时下一轮可重试。名字先经 `fold_artist_name`
  （`py/utils/artist_tags.py`，与画师表同一套折叠）再比较，大小写、下划线、空格写法差异不影响命中。
- **API**：`GET /api/lm/gallery/stats?by=artist&...&animadex_only=1`。只在 `by=artist` 时生效；
  目录尚未就绪时返回空列表，并带 `animadex: {ready, loading, count, fetched_at, progress: {done, total}, error}`，
  前端据此显示下载进度。
- **前端**：`#galleryStatsAnimadexToggle`（`templates/gallery.html` / `static/js/gallery.js`）。
  打开后从第一页重新加载；目录构建中表格暂时为空，但显示「正在加载 animadex 画师目录… x/y」并每 1.5s
  自动重试，而不是显示「还没有评分」的空态；构建完但没有命中时单独提示「排行榜里没有 animadex 收录的画师」。
  分组切到 LoRA 时开关隐藏并自动关闭（目录只覆盖画师），避免留下看不见的过滤状态。

已知取舍：首次启用要抓 400+ 页，通常十几秒到半分钟，期间以进度文案代替表格；名字只做折叠匹配，
不做模糊/别名匹配，animadex 用不同写法的同名画师可能命中不上。
