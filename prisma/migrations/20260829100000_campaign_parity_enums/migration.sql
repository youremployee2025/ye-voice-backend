-- Two new enum members, in a migration of their own.
--
-- Postgres will not let a value added by `ALTER TYPE ... ADD VALUE` be used by
-- the same transaction that added it, and Prisma runs each migration file as
-- one transaction. The columns wave that follows rewrites contact statuses, so
-- folding these in would fail the moment a backfill named one. A separate file
-- is a separate transaction, which is the whole point.
--
-- Both are appended rather than inserted at a position: the physical order of
-- an enum is not a sort key anywhere in this service.

-- AlterEnum
-- Swept out of the queue by the campaign — a stop, or a lowered retry budget.
ALTER TYPE "CampaignContactStatus" ADD VALUE 'SKIPPED';

-- AlterEnum
-- The balance stopped the dialing, not an operator.
ALTER TYPE "CampaignStatus" ADD VALUE 'CREDIT_EXHAUSTED';
