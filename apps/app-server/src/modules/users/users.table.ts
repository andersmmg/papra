import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { createPrimaryKeyField, createTimestampColumns } from '../shared/db/columns.helpers';

export const usersTable = sqliteTable(
  'users',
  {
    ...createPrimaryKeyField({ prefix: 'usr' }),
    ...createTimestampColumns(),

    email: text('email').notNull().unique(),
    fullName: text('full_name').notNull(),
  },
  (table) => [
    index('email_index').on(table.email)
  ],
);
