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

LoRA 分组另有一个**提示词权重得分** `weighted_score = Σ rating × |weight|`：同一张图里
`<lora:foo:0.3>` 只按 0.3 计入 `foo` 的分数，而不是像 `score` 那样不论强度都给全分。
没写权重的 LoRA 按 `1.0` 计（`ABS(COALESCE(weight, 1.0))`，负权重取绝对值），
所以老数据不会凭空变成 0。画师分组没有权重概念，`weighted_score` 恒等于 `score`。
两个分数并存：榜单默认仍读 `score`，`weighted_score` 是一个可切换的排序键。

行里还带一个 `average_strength`：**只对已评分的图**求平均倍数
（`AVG(CASE WHEN rating != 0 THEN |weight| END)`），用于在界面上解释两个分数为什么不同——
平均值 `1.00` 就意味每一票都按满强度投的，此时 `weighted_score` 只能等于 `score`；
没有已评分的图则为 `null`，界面退回不带平均值的说明。

**平均分（除以已评分图片数）**：每行还有 `average_score = score / rated` 与
`average_weighted_score = weighted_score / rated`，分母 `rated` 是 `likes + dislikes`，
即只数 `rating != 0` 的图 —— 未评分的图不会稀释一个 LoRA。这样「只出现 1 次且被特别中意」
的 LoRA 不会被「被看过 200 次、褒贬各半」的行靠数量压过去。两个累计总分仍然并排保留，
平均分只是额外的排序键（`sort=average` / `sort=weighted_average`），不改默认榜单。

**LoRA 组合排行**：`by=combo` 时后端对同一张图的 LoRA 子表做两两自连接
（`a.lora_name < b.lora_name`），枚举所有共同出现过的配对 `A + B`，忽略三件及以上的组合。
只收 `rating != 0` 的已评分图，并用 `HAVING COUNT(*) >= min_rated` 卡门槛
（默认 `max(3, min_total)`，即至少 3 张已评分图，样本太少的组合不进榜）。
配对的权重取两个 LoRA 里较弱的那个 `MIN(|a.weight|, |b.weight|)`，与单 LoRA 口径一致；
每行带 `first_lora` / `second_lora`，没有 `hash`（组合是派生行，不跳 LoRA 页）。
组合行同样提供 `score` / `weighted_score` / `average_score` / `average_weighted_score` /
`average_strength` / `levels` / `images`，默认按平均分排序。

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
| GET | `/api/lm/gallery/images` | 分页列表。参数 `page`、`page_size`、`sort`(`newest/oldest/rating_desc/rating_asc/name`)、`rating`(`all/loved/like/dislike/hate/unrated`，精确到四档；`positive/negative`、`liked/disliked`、`hated` 为兼容别名)、`metadata`(`all/with/without`)、`artist`、`lora`、`lora_a` + `lora_b`（同时给了才按「一张图里同时用了这两个 LoRA」过滤，供组合卡片点击跳网格）、`q` |
| POST/GET | `/api/lm/gallery/rating` | `{"image_path","rating"}`，rating 取 `3/1/-1/-3/0` |
| GET | `/api/lm/gallery/summary` | 全库评分分布：`images/rated/unrated/liked/disliked/loved/hated/score/net/levels{love,like,dislike,hate}/like_ratio`，供侧栏分档计数与分布条使用 |
| GET | `/api/lm/gallery/stats` | `by`(`artist/lora/combo`)、`sort`(`score/strength/average/weighted_average/loved/liked/disliked/hated/likes/dislikes/net/total/ratio`，默认 `score` 加权得分；`strength` 只在 `by=lora` 时有意义，`average`/`weighted_average` 是除以已评分图片数后的排序，仅在 `lora`/`combo` 可选)、`limit`、`offset`、`min_total`（`combo` 时也是样本门槛，下限 3）、`order`；每行带 `score`、`weighted_score`、`average_score`、`average_weighted_score`、`average_strength`、`net`、`levels{love,like,dislike,hate}` 与 `images` 样本缩略图；`by=combo` 的行另带 `first_lora`/`second_lora` 且 `known=false`（无跳转） |
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

### 关键词框默认就带 `2pass`

画廊落地状态是**已经过滤过的**：搜索框预填 `2pass`，第一页就按它查（`q=2pass`），
不必先看到全库再手打一遍。清空输入框仍然回到全部图片。
默认词是「落地状态」而不是「用户施加的筛选」，所以它**不会**让空画廊显示「无匹配」——
没配输出目录或还没索引时，提示的仍然是「还没图片」，只有用户真正输入的词才算筛选
（`search !== DEFAULT_GALLERY_SEARCH` 才算 `filtersActive`）。

### 统计视图：四档而非两侧

- 汇总卡：`图片 / 已评分 / +3 / +1 / −1 / −3 / 加权得分`，四档沿用侧栏的分档配色，
  加权得分带正负色。
- 排行卡：**加权得分单独放在卡片右上角的大号色块里**（正分绿、负分红，可点击按得分排序），
  因为榜单首先就是按这个数读的；下面一行是四档**精确计数**（旧的 👍/👎 只能说明两侧，
  无法区分强弱），每个计数既是数值也是排序按钮（`sort=loved|liked|disliked|hated`），
  再下面是四段分布条与点赞率。
- **LoRA 分组是两个并排的大号色块**：左边 `得分`（`score`）、右边 `提示词权重`
  （`weighted_score`，虚线框表示这是同一行的第二个读数）。两个数各带标签与各自的
  排序按钮，因为用户要能同时读「按票数算」与「按权重算」两种结果；
  画师分组只有一个 `得分` 块。
  权重块的 tooltip 会带上 `average_strength`（如「平均 0.20×」），直接解释两个数为什么不同；
  没有已评分的图时用不带平均值的说明。
- **平均分**：LoRA 与 LoRA 组合分组的卡片在四档计数那一行多两个紧凑数值 ——
  `每张已评分图的得分`（`average_score`）与 `每张已评分图的加权得分`（`average_weighted_score`），
  各自带正负色、标签与排序按钮（`sort=average` / `sort=weighted_average`）。
  累计总分仍留在右上角的大号色块里，平均分只是同一批票的第二种读法。
- 排序 pill：`加权得分 / +3 / −3 / 总数 / 点赞率`，LoRA 分组再多一个 `提示词权重`，
  LoRA 与组合分组再多一个 `平均分`（`sort=average`）。
  `likes/dislikes/net` 作为兼容键仍由后端接受。
- **提示词权重**（`sort=strength`）只出现在 LoRA 分组：画师没有提示词权重，组合是派生行
  也没有单件强度，所以那个 pill 在画师榜与组合榜里都隐藏；切到非 LoRA 分组时若正按
  `strength`（或 `average`/`weighted_average` 在画师榜）排会自动退回 `score`——控制项永远与可见的行一致。
- **第三个分组按钮 `LoRA 组合`**（`by=combo`）：把统计视图切成两两配对榜。卡片标题是
  `A + B` 而不是单个名字，没有 ↗ 跳 LoRA 页按钮；点击整张卡会带着 `lora_a` + `lora_b`
  跳回图片网格，只显示「同时用了这两个 LoRA」的图，筛选横幅也写明这一对。
  组合默认也是按平均分读，样本门槛见上文（至少 3 张已评分图）。

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
统计聚合与排序（含**按精确档位 loved/hated 排序**与四档计数、
**LoRA 按提示词权重加权**：同一档位在 `weight=0.3` 的图上分数只有 0.3 倍、
`sort=strength` 的次序与 `sort=score` 可以不同、画师分组的 `weighted_score` 恒等于 `score`、
**`average_strength` 只对已评分的图求平均且全未评分时为 `null`**）、
**平均分**（`average_score`/`average_weighted_score` 的分母只数已评分图、未评分图不稀释，
`sort=average`/`sort=weighted_average` 与 `sort=score` 的次序不同、累计总分不变）、
**LoRA 组合排行**（两两自连接、忽略三件以上、只收已评分图、`min_rated` 默认下限 3 且
`min_total=4` 会整榜清空、配对权重取两者较小者、组合行 `known=false` 无跳转、
`by=combo` 不走 animadex 过滤、平均分排序时同分由样本数作次级键）、
**组合卡片跳网格的双 LoRA 过滤**（`lora_a`/`lora_b` 两条 EXISTS，只给齐两个名字才生效，
单给一个不过滤）、
**四档评分**（每档独立计数、加权得分、`like_ratio` 在无评分时为 null）、
列表各过滤器（精确四档 + 两侧兼容别名 / **元数据有无** / 画师 / LoRA / 关键词）及其组合、
分页总计、包含性校验与扩展名白名单、路由注册完整性（含 summary 端点）、评分接口的参数校验、
**LoRA 名 → hash 解析（名字对不上 / 一个名字多个文件时留空）**、
**画廊 ↔ LoRA 页跳转**（芯片旁的 ↗ 只跳转不过滤、芯片本身仍过滤、
统计行只有名字时先解析再跳、解析失败给提示且不跳）。

前端用例另外覆盖：四档按钮与键盘快捷键、侧栏分档切片的计数/筛选/分布条、
**落地即按 `2pass` 过滤且清空后回到全库**、
**在大图查看器里评分**（footer 与 onKey 两个钩子、翻页后评分条跟随）、
评分后不匹配当前筛选项的卡片就地移出、统计页四档指标与排序 pill、
**提示词权重 pill 只在 LoRA 分组出现**（切回画师分组时自动退回 `score` 排序）、
**LoRA 排行卡把 `得分` 与 `提示词权重` 并排成两个带标签的大号块**（权重块不再藏在四档计数行里、
带 `average_strength` 的 tooltip、点击按 `strength` 排序）、
**平均分 pill 只在 LoRA / 组合分组出现**（画师榜隐藏、切回画师自动退回 `score`）、
**LoRA 与组合行的两个平均分数**（累计总分仍并排保留、点击按 `average` 排序）、
**组合卡片点击后按两个 LoRA 同时过滤网格**（`lora_a`/`lora_b` 都进请求、横幅写明这一对、
组合行没有 ↗ 跳转按钮、strength pill 在组合榜隐藏）。

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
- **组合排行只算两两配对。** 一张图里同时用了 3 个及以上 LoRA 时，会拆成所有可能的
  `A+B` 对分别计分，不会产出「三件套」或更高阶组合行；这是刻意的范围，不是漏算。
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
