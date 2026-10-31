-- Which weekdays a campaign may dial on, 0 = Sunday .. 6 = Saturday.
--
-- Empty is the unrestricted state and is what every existing row gets, so this
-- column changes no campaign's behaviour on deploy. NOT NULL with a default
-- rather than nullable: "no restriction" and "not set" are the same fact here,
-- and a nullable array would give every reader a third case to get wrong.
--
-- Adding a NOT NULL column WITH a constant default does not rewrite the table
-- in Postgres 11+, so this is metadata-only on a large `Campaign`.
ALTER TABLE "Campaign"
  ADD COLUMN "dialDays" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[];
