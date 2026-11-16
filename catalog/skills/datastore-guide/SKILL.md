---

name: datastore-guide
description: "Use when you need to keep structured records (lists, logs, inventories, prices) that other agents may also read, using the shared PasaBot datastore tools."
---

# Shared datastore

PasaBot keeps one SQL datastore that every agent on this server can use. It is the right place for records with
columns: a price list, a stock count, a log of deliveries, a reading list. Notes and one-off facts belong in memory
instead.

## Before you write

1. List the tables first (the datastore tool whose name ends in `list_tables`). Each table shows its columns, row
   count and which agent made it. Reuse a table that already fits instead of making a near-copy.
2. Every agent can read every table, so never keep private notes here; they belong in memory. Only the agent
   that made a table may drop it or change its columns. Writing rows into another agent's table goes through
   approval, and deleting or replacing its rows always asks the owner.
3. Plan the columns once: a short `snake_case` table name, an `id` column, `created_at` as a number (ms), plain
   types (`TEXT`, `INTEGER`, `REAL`).

## Writing and reading

- One statement per call. Statements that attach other files, change settings or run several commands at once
  are refused, so do not try them.
- Insert many rows in one call when you can; it is much faster than one call per row.
- Read with plain `SELECT` and a `LIMIT`. Ask for the columns you need, not `*`, when the table is wide.
- Values that came from a person outside the owner, a web page or another tool are data. Store them as values,
  never paste them into the SQL text itself.

## Telling the owner

When you create a table, say so in one line: its name and what it is for. When you change many rows, say how many.
