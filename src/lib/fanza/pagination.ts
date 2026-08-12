export const FANZA_CONTINUATION_SORTS = ["date"] as const;

export type FanzaContinuationSort = typeof FANZA_CONTINUATION_SORTS[number];

export type FanzaPaginationOptions = {
  startOffset: number;
  maxItems: number;
  pageSize: number;
  sort: FanzaContinuationSort;
};

const integer = (value: unknown, name: string, minimum: number, maximum: number) => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name.toUpperCase().replaceAll("-", "_")}_${minimum}_TO_${maximum}_REQUIRED`);
  }
  return parsed;
};

export function normalizeFanzaPaginationOptions(input: Partial<FanzaPaginationOptions> = {}): FanzaPaginationOptions {
  const sort = input.sort ?? "date";
  if (!FANZA_CONTINUATION_SORTS.includes(sort)) throw new Error("FANZA_SORT_UNSUPPORTED");
  return {
    startOffset: integer(input.startOffset ?? 1, "start-offset", 1, Number.MAX_SAFE_INTEGER),
    maxItems: integer(input.maxItems ?? 100, "max-items", 1, 1_000_000),
    pageSize: integer(input.pageSize ?? 100, "page-size", 1, 100),
    sort,
  };
}

export function parseFanzaPaginationCli(
  arguments_: string[],
  defaults: Partial<FanzaPaginationOptions> = {},
): FanzaPaginationOptions {
  const values: Record<string, string> = {};
  let positionalMaxItems: string | undefined;
  for (const argument of arguments_) {
    if (!argument.startsWith("--")) {
      if (positionalMaxItems !== undefined) throw new Error(`UNKNOWN_ARGUMENT_${argument}`);
      positionalMaxItems = argument;
      continue;
    }
    const separator = argument.indexOf("=");
    if (separator < 3) throw new Error(`UNKNOWN_ARGUMENT_${argument}`);
    const name = argument.slice(2, separator);
    if (!["start-offset", "max-items", "page-size", "sort"].includes(name)) {
      throw new Error(`UNKNOWN_ARGUMENT_${argument}`);
    }
    values[name] = argument.slice(separator + 1);
  }
  if (positionalMaxItems !== undefined && values["max-items"] !== undefined) {
    throw new Error("MAX_ITEMS_SPECIFIED_TWICE");
  }
  return normalizeFanzaPaginationOptions({
    startOffset: values["start-offset"] === undefined ? defaults.startOffset : Number(values["start-offset"]),
    maxItems: values["max-items"] === undefined
      ? (positionalMaxItems === undefined ? defaults.maxItems : Number(positionalMaxItems))
      : Number(values["max-items"]),
    pageSize: values["page-size"] === undefined ? defaults.pageSize : Number(values["page-size"]),
    sort: (values.sort ?? defaults.sort) as FanzaContinuationSort | undefined,
  });
}

export function fanzaWindowEndOffset(options: FanzaPaginationOptions) {
  return options.startOffset + options.maxItems - 1;
}
