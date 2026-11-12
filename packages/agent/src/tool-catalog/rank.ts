import type { CatalogEntry } from "./catalog";
import { bareNameOf, queryNamespace } from "./catalog";

/** 命中档位，数字越小越靠前。 */
const Tier = {
  /** 整个名字一模一样。 */
  Name: 0,
  /** 分隔符之后那一截一模一样：模型记住了工具名，忘了服务器。 */
  BareName: 1,
  /** 查询就是服务器名。 */
  Namespace: 2,
  /** 名字以此开头。 */
  NamePrefix: 3,
  /** 说明或名字里有这个词。 */
  Keyword: 4,
} as const;

/**
 * 用一个查询给目录排序。
 *
 * 只用词形，分五档：整个名字、短名、服务器名、名字前缀、关键词，先命中先得。
 * 同一档里先比覆盖了几个查询词，再比名字，所以同一个查询在同一个目录上永远
 * 得到同一个答案。
 *
 * `"<服务器>__"` 是快速路径：跳过排序，直接列那台服务器的工具。模型知道要找
 * 哪台服务器时用它。
 */
export function searchCatalog(
  entries: readonly CatalogEntry[],
  rawQuery: string
): CatalogEntry[] {
  const query = rawQuery.trim().toLowerCase();

  if (query.length === 0) {
    return [];
  }

  const askedNamespace = queryNamespace(query);
  if (askedNamespace !== undefined) {
    return entries
      .filter((entry) => entry.namespace?.toLowerCase() === askedNamespace)
      .toSorted((a, b) => a.name.localeCompare(b.name));
  }

  const words = queryWords(query);
  const ranked: RankedEntry[] = [];

  for (const entry of entries) {
    const tier = tierOf(entry, query);
    const hits = countHits(entry, words);

    if (tier === Tier.Keyword && hits === 0) {
      continue;
    }

    ranked.push({ entry, tier, hits });
  }

  return ranked
    .toSorted(
      (a, b) =>
        a.tier - b.tier ||
        b.hits - a.hits ||
        a.entry.name.localeCompare(b.entry.name)
    )
    .map((rankedEntry) => rankedEntry.entry);
}

type RankedEntry = {
  entry: CatalogEntry;
  tier: number;
  hits: number;
};

function tierOf(entry: CatalogEntry, query: string): number {
  const name = entry.name.toLowerCase();

  if (name === query) {
    return Tier.Name;
  }

  if (bareNameOf(name) === query) {
    return Tier.BareName;
  }

  if (entry.namespace?.toLowerCase() === query) {
    return Tier.Namespace;
  }

  if (name.startsWith(query)) {
    return Tier.NamePrefix;
  }

  return Tier.Keyword;
}

/** 这个条目在名字或说明里覆盖了几个查询词。 */
function countHits(entry: CatalogEntry, words: readonly string[]): number {
  const haystack = `${entry.name}\n${entry.description}`.toLowerCase();

  return words.filter((word) => haystack.includes(word)).length;
}

/**
 * 查询里当作词的单位。
 *
 * 只按空白和标点切，不按字符集切：中文查询没有空格，切碎了一个词都匹配不到。
 */
function queryWords(query: string): string[] {
  return query
    .split(/[\s,;:.!?()[\]{}"'`|/]+/)
    .filter((word) => word.length > 0);
}
