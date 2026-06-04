import { int, sqliteTable, text } from "drizzle-orm/sqlite-core";

const users_table = sqliteTable("users_table", {
  age: int().notNull(),
  email: text().notNull().unique(),
  id: int().primaryKey({ autoIncrement: true }),
  name: text().notNull(),
});

export { users_table };
