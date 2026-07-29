# Thumbnail Policy V1 導入サマリー

- 画像選定は `thumbnail-policy-v1.md` の8ルールとgold labelsで運用する。
- 新規追加時は全件候補比較ではなく、低信頼・新パターンだけをレビューする。
- 古いレビュー資料は削除せず、必要時のみ `tmp/.../archive/` へ移動する。
- 巨大PDF、重複したcontact sheet、不要な画像再生成は禁止する。
- コード変更がない限り `build`、`lint`、`vercel-build` は実行しない。
- `node_modules` と `.next` はキャッシュとして保持し、依存変更や明確な不整合時だけ再生成する。
- 主担当はTerra。Solは使用しない。
- gold labelsは72件。`1SILK02031` と `1STCVS00050` は最終候補が未確定のため、正解データには入れず `needs_user_review` として扱う。
