import { ImageResponse } from "next/og";

export const alt = "Okazu DB - Search works by product code";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", padding: 90, color: "white", background: "radial-gradient(circle at top right, #6d28d9, #020617 60%)" }}>
      <div style={{ fontSize: 28, color: "#c4b5fd" }}>WORK DISCOVERY DATABASE</div>
      <div style={{ marginTop: 22, fontSize: 86, fontWeight: 900 }}>OKAZU DB</div>
      <div style={{ marginTop: 24, fontSize: 34, color: "#cbd5e1" }}>Search by product code, actress, maker or series</div>
    </div>,
    size,
  );
}
