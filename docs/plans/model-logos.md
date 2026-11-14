# 供应商图标与模型图标

分清两件事：**供应商**的图标和**模型**的图标。它们不是两套文件，而是同一批品牌图上的
两层解析。改之前只有 `ModelLogo` 一个组件，一张表里混着供应商（`openrouter`、
`tencentcloud`）和模型（`deepseek`、`kimi`），认不出品牌时画 OpenAI 的图。

## 决策

| 决策     | 结论                                                                           |
| -------- | ------------------------------------------------------------------------------ |
| 概念     | 供应商图标与模型图标是两个概念，两个组件，共享一个渲染器                       |
| 渲染器   | `BrandIcon`：彩色图走 `<img>`，单色图走 mask 跟随文字色                        |
| 键契约   | 键名就是品牌名，`-color` 后缀表示彩色；后缀自带信息，删掉 `monochrome` 布尔    |
| 键来源   | 不新增持久化字段；供应商键来自 `ProviderPreset.icon`，模型键按 id 前缀推出品方 |
| 解析顺序 | 显式键 → 模型 id 家族前缀 → 所属供应商的键 → 兜底                              |
| 迁移     | 一次性改成新键，不留兼容别名；没有持久化数据存着旧键                           |
| 清单     | 40 个品牌图，覆盖预置供应商与模型家族；不含 PNG                                |
| 兜底     | 供应商：名字首字母方块；模型：中性 `generic` 图标                              |
| 资源引入 | `import.meta.glob` 取 `?url`，键名从文件名推导，加图不改代码                   |
| 出处     | 不做第三方声明；来源与约定记在本文档                                           |

## 术语

三个词写进 `packages/ui/GLOSSARY.md`：供应商图标、模型图标、模型出品方。

**模型图标画的是出品方，不是版本。** 图标只做到品牌级，没有 `gpt-4o`、`claude-3-5`
这种版本级图。所以 `claude-sonnet` 与 `claude-opus` 画同一张图，这是刻意的。

## 为什么先看出品方

aify-zero 的供应商是用户手填的地址和名字，没有 models.dev 那样的 catalog id 可查，
所以顺序只能是「先按模型 id 的家族前缀看出品方，再退到所属供应商」。

这样对中转类供应商更好：`anthropic/claude-x` 挂在「我的中转」下时，画的是 Claude 的
图，不是中转站的图——模型是谁做的，比它挂在谁下面更有用。

认不出的模型画 `generic` 中性图标，不画空白。列表里有图标和没图标混排会让行首抖，
中性图标让「未知」长得一致，也不给模型安一个假品牌。

## 键契约

键名就是文件名去掉 `.svg`。`-color` 后缀表示这份图是彩色的，用 `<img>` 原色渲染；
没有后缀的是单色图，用 CSS mask 跟随 `currentColor`。后缀自带信息，所以不再需要
`monochrome` 布尔。

```ts
/** 图标键到资源地址。键名即文件名去掉 `.svg`，由 glob 推导。 */
const ICONS = import.meta.glob("../assets/icons/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;
```

`generic` 不是文件，是 `BrandIcon` 里的内联 SVG，所以不进 glob 表。

## 清单

### 模型厂商（13）

`claude-color`、`deepseek-color`、`gemini-color`、`minimax-color`、`mistral-color`、
`mimocode`、`openai`、`qwen-color`、`stepfun-color`、`xai`、`zai`、`zhipu-color`、
`longcat`

### 云与托管（8）

`volcengine-color`、`tencentcloud-color`、`baiducloud-color`、`bedrock-color`、
`nvidia-color`、`modelscope-color`、`siliconcloud-color`、`voyage-color`

### 平台、中转与工具（19）

`openrouter`、`opencode`、`vercel`、`cloudflare-color`、`together-color`、
`fireworks-color`、`aihubmix-color`、`ai302-color`、`nousresearch`、`ollama`、
`groq`、`kimi`、`gmicloud`、`commandcode`、`cherryin-color`、`pipellm-color`、
`cline`、`kilo`、`yylx`

### 不收录

- PNG。渲染器只有「彩色 `<img>` / 单色 mask」两条分支，不解析位图。
- 同一个品牌的第二个变体。一个品牌一个键，`anthropic` 与 `claude-color` 只留后者，
  `moonshot` 与 `kimi` 只留后者。
- 与模型无关的图标：编辑器与 agent 工具（`vscode`、`zed`、`raycast`、`obsidian`）、
  云架构图专用图标。

## 现有键的迁移

`LOGO_MAP` 的 12 个键里，7 个改名、1 个并入、4 个不动。

| 旧键           | 新键                 |
| -------------- | -------------------- |
| `deepseek`     | `deepseek-color`     |
| `gemini`       | `gemini-color`       |
| `minimax`      | `minimax-color`      |
| `moonshot`     | `kimi`（并入）       |
| `qwen`         | `qwen-color`         |
| `tencentcloud` | `tencentcloud-color` |
| `volcengine`   | `volcengine-color`   |
| `zhipu`        | `zhipu-color`        |
| `openai`       | 不变                 |
| `kimi`         | 不变                 |
| `opencode`     | 不变                 |
| `openrouter`   | 不变                 |

`packages/shared/src/model.ts` 里 9 个预置的 `icon` 值同步改成新键。这些键不落库
（`Provider` 与 `ProviderModel` 都没有 icon 字段），所以没有数据迁移。

## 渲染

```
ProviderLogo({ name, icon?, className? })
  key = icon ?? 按名字/别名找键
  有键 → <BrandIcon name={key} />
  无键 → 首字母方块

ModelLogo({ model, providerIcon?, className? })
  key = 显式? → 模型 id 家族前缀
  有键 → <BrandIcon name={key} />
  无键 → providerIcon ? <BrandIcon name={providerIcon} /> : <BrandIcon name="generic" />

BrandIcon({ name, className? })
  键以 -color 结尾 → <img src={url}>，object-contain
  否则             → <span> + mask-image，取 alpha，跟随文字色
  name === "generic" → 内联中性 SVG
```

尺寸默认 `size-4`，由 `className` 覆盖（调用点有 `size-5`）。`aria-hidden` 保持不变，
可访问名字由旁边的文本给出。

## 文件

| 路径                                                           | 动作                                      |
| -------------------------------------------------------------- | ----------------------------------------- |
| `packages/ui/src/assets/icons/*.svg`                           | 40 个品牌图                               |
| `packages/ui/src/assets/app-icon.svg`                          | 应用自身的图标，不跟品牌图混在一起        |
| `packages/ui/src/elements/brand-icon.tsx`                      | 键表、`BrandIcon`、`hasIcon`、`ICON_KEYS` |
| `packages/ui/src/elements/provider-logo.tsx`                   | `ProviderLogo`、别名表、`providerKeyFor`  |
| `packages/ui/src/elements/model-logo.tsx`                      | `ModelLogo`、`makerKeyFor`、家族前缀表    |
| `packages/ui/src/elements/settings/provider-settings.tsx`      | 供应商行与模型行用新组件                  |
| `packages/ui/src/elements/settings/provider-preset-select.tsx` | 预设行用 `ProviderLogo`                   |
| `packages/ui/src/elements/model-select.tsx`                    | 三处模型行传 `providerIcon`               |
| `packages/ui/src/index.d.ts`                                   | 声明 `import.meta.glob` 的这一种形态      |
| `packages/shared/src/model.ts`                                 | 9 个预置的 `icon` 值                      |
| `packages/ui/tests/model-logo.test.ts`                         | 表驱动测试                                |
| `packages/ui/tests/brand-icon.test.tsx`                        | 三个渲染分支的静态标记测试                |

## 测试

1. 每个键都能取到资源地址。
2. 每个预置的 `icon` 都在键表里。
3. 每条家族前缀都能解析到存在的键。
4. `anthropic/claude-x` 这类带 `/` 的模型 id 取后半段再匹配。
5. 认不出的模型退到 `generic`，有供应商键时退到供应商。

## 出处

图标取自 [theSVG](https://thesvg.org)：

```
https://cdn.jsdelivr.net/gh/glincker/thesvg@main/public/icons/{slug}/{variant}.svg
```

注册表是同一仓库的 `src/data/icons.json`。不建 `THIRD_PARTY_NOTICES.md`：品牌的商标
仍归各品牌方，这份文件只记录取图地址。

### 取图规则

文件名（即键名）保持不变，`-color` 后缀仍然表示彩色，渲染器不用管来源。变体选择：
彩色键优先 `color`，没有就用 `default`；单色键优先 `mono`，没有就用 `default`——单色
渲染取的是 alpha，颜色不重要。

几个要绕开的坑：

| 键             | 取的条目                   | 原因                                            |
| -------------- | -------------------------- | ----------------------------------------------- |
| `gemini-color` | `gemini`                   | `google-gemini` 是单色紫，不是那条四色星标      |
| `openai`       | `openai-chatgpt` 的 `mono` | `openai` 的默认条目是白色填充，在白底上等于空白 |

品牌标不一定按方形导出，所以彩色图那一支用 `object-contain`，非方形的图只会留白，
不会被拉变形。
