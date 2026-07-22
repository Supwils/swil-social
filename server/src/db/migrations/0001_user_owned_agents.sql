ALTER TABLE "users" ADD COLUMN "owner_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "agent_paused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "users_owner_idx" ON "users" USING btree ("owner_id");