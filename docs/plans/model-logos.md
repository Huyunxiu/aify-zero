# Provider Icons and Model Icons

Two things are different: the icon of the **provider** and the icon of the **model**. They are
not two sets of files. They are two layers of resolution on the same set of brand images.
Before the change, one component, `ModelLogo`, held one table. That table mixed providers
(`openrouter`, `tencentcloud`) and models (`deepseek`, `kimi`). When the component did not know
the brand, it drew the OpenAI image.

## Decision

| Decision          | Result                                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Concept           | Provider Icon and Model Icon are two concepts and two components. They share one renderer.                                                             |
| Renderer          | `BrandIcon`: a colored image uses `<img>`, and a monochrome image uses a mask that follows the text color.                                             |
| Icon Key contract | The key name is the brand name. The `-color` suffix marks a colored image. The suffix carries the information, so the `monochrome` boolean is removed. |
| Key source        | The change adds no persisted field. A provider key comes from `ProviderPreset.icon`. For a model key, the id prefix gives the Model Maker.             |
| Resolution order  | Explicit key → model id family prefix → key of the provider that serves the model → fallback                                                           |
| Migration         | One change to the new keys. No compatible alias stays. No persisted data holds an old key.                                                             |
| Manifest          | 40 brand images that cover the preset providers and the model families. The set holds no PNG.                                                          |
| Fallback          | Provider: a square with the first letter of the name. Model: the neutral `generic` icon.                                                               |
| Asset import      | `import.meta.glob` gets `?url`. The code derives the key name from the file name, so an added image needs no code change.                              |
| Source            | The project creates no third-party notice. This document records the source and the convention.                                                        |

## Terms

Three words go into `packages/ui/GLOSSARY.md`: Provider Icon, Model Icon, and Model Maker.

**A Model Icon draws the Model Maker, not the version.** An icon stops at the brand level. There
is no version-level image for `gpt-4o` or `claude-3-5`. Therefore `claude-sonnet` and
`claude-opus` draw the same image, and that result is deliberate.

## Why the Model Maker Comes First

In aify-zero, the user types the address and the name of a provider. The provider has no catalog
id to look up, unlike the id in models.dev. So the order can only be: first the Model Maker,
from the family prefix of the model id; then the provider that serves the model.

This order is better for a relay provider. When `anthropic/claude-x` sits under "My Relay", it
draws the Claude image, not the image of the relay. The maker of the model is more useful than
the provider that serves the model.

An unknown model draws the neutral `generic` icon. It does not draw an empty space. A list that
mixes icons and empty spaces makes the row start jump. The neutral icon makes the unknown case
look the same, and it does not give the model a false brand.

## Icon Key Contract

The key name is the file name without `.svg`. The `-color` suffix marks a colored image, and
`<img>` renders it in its own colors. A key without the suffix marks a monochrome image, and a
CSS mask follows `currentColor`. The suffix carries the information, so the `monochrome`
boolean is no longer necessary.

```ts
/** Icon Key to asset address. The key name is the file name without `.svg`, derived by glob. */
const ICONS = import.meta.glob("../assets/icons/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;
```

`generic` is not a file. It is an inline SVG in `BrandIcon`, so it does not enter the glob table.

## Manifest

### Model Makers (13)

`claude-color`, `deepseek-color`, `gemini-color`, `minimax-color`, `mistral-color`,
`mimocode`, `openai`, `qwen-color`, `stepfun-color`, `xai`, `zai`, `zhipu-color`,
`longcat`

### Clouds and Hosting (8)

`volcengine-color`, `tencentcloud-color`, `baiducloud-color`, `bedrock-color`,
`nvidia-color`, `modelscope-color`, `siliconcloud-color`, `voyage-color`

### Platforms, Relays, and Tools (19)

`openrouter`, `opencode`, `vercel`, `cloudflare-color`, `together-color`,
`fireworks-color`, `aihubmix-color`, `ai302-color`, `nousresearch`, `ollama`,
`groq`, `kimi`, `gmicloud`, `commandcode`, `cherryin-color`, `pipellm-color`,
`cline`, `kilo`, `yylx`

### Not Included

- PNG. The renderer has only two branches, a colored `<img>` and a monochrome mask. It does not
  read a bitmap.
- A second variant of one brand. One brand has one key. Of `anthropic` and `claude-color`, only
  the second stays. Of `moonshot` and `kimi`, only the second stays.
- An icon that has no relation to a model: editor and agent tools (`vscode`, `zed`, `raycast`,
  `obsidian`), and icons only for a cloud architecture diagram.

## Migration of the Existing Keys

Of the 12 keys in `LOGO_MAP`, 7 keys get a new name, 1 key merges into another, and 4 keys do
not change.

| Old Key        | New Key              |
| -------------- | -------------------- |
| `deepseek`     | `deepseek-color`     |
| `gemini`       | `gemini-color`       |
| `minimax`      | `minimax-color`      |
| `moonshot`     | `kimi` (merged)      |
| `qwen`         | `qwen-color`         |
| `tencentcloud` | `tencentcloud-color` |
| `volcengine`   | `volcengine-color`   |
| `zhipu`        | `zhipu-color`        |
| `openai`       | No change            |
| `kimi`         | No change            |
| `opencode`     | No change            |
| `openrouter`   | No change            |

The 9 preset `icon` values in `packages/shared/src/model.ts` change to the new keys at the same
time. These keys do not enter the database: `Provider` and `ProviderModel` have no icon field.
Therefore no data migration occurs.

## Rendering

```
ProviderLogo({ name, icon?, className? })
  key = icon ?? find the key by name or alias
  key found → <BrandIcon name={key} />
  no key    → square with the first letter

ModelLogo({ model, providerIcon?, className? })
  key = explicit? → model id family prefix
  key found → <BrandIcon name={key} />
  no key    → providerIcon ? <BrandIcon name={providerIcon} /> : <BrandIcon name="generic" />

BrandIcon({ name, className? })
  key ends with -color → <img src={url}>, object-contain
  otherwise            → <span> + mask-image, take alpha, follow the text color
  name === "generic"   → inline neutral SVG
```

The default size is `size-4`, and `className` overrides it; one call site uses `size-5`.
`aria-hidden` does not change. The text next to the icon gives the accessible name.

## Files

| Path                                                         | Action                                                       |
| ------------------------------------------------------------ | ------------------------------------------------------------ |
| `packages/ui/src/assets/icons/*.svg`                         | 40 brand images                                              |
| `packages/ui/src/assets/app-icon.svg`                        | The icon of the app itself, kept apart from the brand images |
| `packages/ui/src/blocks/brand-icon.tsx`                      | The key table, `BrandIcon`, `hasIcon`, `ICON_KEYS`           |
| `packages/ui/src/blocks/provider-logo.tsx`                   | `ProviderLogo`, the alias table, `providerKeyFor`            |
| `packages/ui/src/blocks/model-logo.tsx`                      | `ModelLogo`, `makerKeyFor`, the family prefix table          |
| `packages/ui/src/blocks/settings/provider-settings.tsx`      | The provider row and the model row use the new components    |
| `packages/ui/src/blocks/settings/provider-preset-select.tsx` | The preset row uses `ProviderLogo`                           |
| `packages/ui/src/blocks/model-select.tsx`                    | Three model rows pass `providerIcon`                         |
| `packages/ui/src/index.d.ts`                                 | Declares this one form of `import.meta.glob`                 |
| `packages/shared/src/model.ts`                               | The 9 preset `icon` values                                   |
| `packages/ui/tests/model-logo.test.ts`                       | Table-driven test                                            |
| `packages/ui/tests/brand-icon.test.tsx`                      | Static markup test of the three render branches              |

## Tests

1. Every key resolves to an asset address.
2. Every preset `icon` is in the key table.
3. Every family prefix resolves to a key that exists.
4. A model id with `/`, such as `anthropic/claude-x`, matches on the second half.
5. An unknown model falls back to `generic`; when a provider key exists, it falls back to the
   provider.

## Source

The icons come from [theSVG](https://thesvg.org):

```
https://cdn.jsdelivr.net/gh/glincker/thesvg@main/public/icons/{slug}/{variant}.svg
```

The registry is `src/data/icons.json` in the same repository. The project does not create
`THIRD_PARTY_NOTICES.md`: a trademark stays with its brand owner, and this document only records
the address of the image.

### Image Selection Rules

The file name, and therefore the Icon Key, does not change. The `-color` suffix still marks a
colored image, and the renderer does not care about the source. Variant selection: a colored key
prefers `color`, and uses `default` when `color` is absent; a monochrome key prefers `mono`, and
uses `default` when `mono` is absent. A monochrome render takes alpha, so the color does not
matter.

Some traps to avoid:

| Key            | Entry Used                 | Reason                                                                               |
| -------------- | -------------------------- | ------------------------------------------------------------------------------------ |
| `gemini-color` | `gemini`                   | `google-gemini` is a monochrome purple, not the four-color star mark                 |
| `openai`       | `mono` of `openai-chatgpt` | The default entry of `openai` has a white fill, so it is empty on a white background |

A brand mark is not always square. Therefore the colored branch uses `object-contain`. A
non-square image only gets empty space. It does not stretch.
