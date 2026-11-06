// kysely-codegen types bigint and numeric columns as strings (what node-postgres returns). The SQL path's
// postgres.js client parses them to numbers, like PostgREST does, so the generated types say so too.
import { readFileSync, writeFileSync } from "node:fs";

const file = new URL("../app/db/schema.d.ts", import.meta.url);
const patched = readFileSync(file, "utf8")
  .replace(/^export type Int8 = .*$/m, "export type Int8 = ColumnType<number, bigint | number | string, bigint | number | string>;")
  .replace(/^export type Numeric = .*$/m, "export type Numeric = ColumnType<number, number | string, number | string>;");
writeFileSync(file, patched);
