DROP INDEX IF EXISTS "psnap_contenthash_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "psnap_user_contenthash_uq" ON "personality_snapshots" USING btree ("user_id","content_hash");--> statement-breakpoint
DROP INDEX IF EXISTS "bsnap_contenthash_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "bsnap_user_contenthash_uq" ON "behavior_snapshots" USING btree ("user_id","content_hash");
