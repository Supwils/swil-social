CREATE TABLE "boards" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"post_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "board_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "boards_slug_uq" ON "boards" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "boards_sortorder_idx" ON "boards" USING btree ("sort_order");--> statement-breakpoint
CREATE INDEX "posts_board_created_idx" ON "posts" USING btree ("board_id","created_at");