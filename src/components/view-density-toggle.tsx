import Link from "next/link";

type SearchParams = Record<string, string | undefined>;

export function ViewDensityToggle({ current, params }: { current: "standard" | "compact"; params: SearchParams }) {
  const href = (view: "standard" | "compact") => {
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value && key !== "view") next.set(key, value);
    }
    if (view === "compact") next.set("view", "compact");
    const query = next.toString();
    return query ? `?${query}` : "?";
  };
  const item = (view: "standard" | "compact", label: string) => (
    <Link
      href={href(view)}
      className={`rounded-full px-3 py-1.5 text-xs transition ${current === view ? "bg-white text-slate-950" : "text-slate-400 hover:bg-white/10 hover:text-slate-100"}`}
    >
      {label}
    </Link>
  );
  return (
    <div className="inline-flex rounded-full border border-white/10 bg-white/[0.035] p-1 shadow-sm shadow-black/10">
      {item("standard", "標準表示")}
      {item("compact", "コンパクト表示")}
    </div>
  );
}
