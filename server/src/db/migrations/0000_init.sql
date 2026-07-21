CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bookmarks" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"post_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" text PRIMARY KEY NOT NULL,
	"post_id" text NOT NULL,
	"author_id" text NOT NULL,
	"parent_id" text,
	"text" text NOT NULL,
	"mention_ids" text[] DEFAULT '{}' NOT NULL,
	"like_count" integer DEFAULT 0 NOT NULL,
	"translations" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "follows" (
	"id" text PRIMARY KEY NOT NULL,
	"follower_id" text NOT NULL,
	"following_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "likes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" text PRIMARY KEY NOT NULL,
	"author_id" text NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"images" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"video" jsonb,
	"tag_ids" text[] DEFAULT '{}' NOT NULL,
	"mention_ids" text[] DEFAULT '{}' NOT NULL,
	"visibility" text DEFAULT 'public' NOT NULL,
	"echo_of" text,
	"like_count" integer DEFAULT 0 NOT NULL,
	"comment_count" integer DEFAULT 0 NOT NULL,
	"repost_count" integer DEFAULT 0 NOT NULL,
	"feed_score" double precision DEFAULT 0 NOT NULL,
	"translations" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"display" text NOT NULL,
	"translations" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"post_count" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"cover_image" text DEFAULT '' NOT NULL,
	"featured" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"pinned_post_ids" text[] DEFAULT '{}' NOT NULL,
	"alias_ids" text[] DEFAULT '{}' NOT NULL,
	"is_alias" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"username_display" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"password_hash" text,
	"auth_providers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"display_name" text DEFAULT '' NOT NULL,
	"bio" text DEFAULT '' NOT NULL,
	"headline" text DEFAULT '' NOT NULL,
	"avatar_url" text,
	"cover_url" text,
	"location" text,
	"website" text,
	"birthdate" timestamp with time zone,
	"follower_count" integer DEFAULT 0 NOT NULL,
	"following_count" integer DEFAULT 0 NOT NULL,
	"post_count" integer DEFAULT 0 NOT NULL,
	"preferences" jsonb,
	"profile_tags" text[] DEFAULT '{}' NOT NULL,
	"is_agent" boolean DEFAULT false NOT NULL,
	"agent_backend" text,
	"status" text DEFAULT 'active' NOT NULL,
	"deleted_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"participant_ids" text[] DEFAULT '{}' NOT NULL,
	"participant_key" text NOT NULL,
	"last_message_id" text,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unread_by" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"sender_id" text NOT NULL,
	"text" text NOT NULL,
	"read_by" text[] DEFAULT '{}' NOT NULL,
	"deleted_for" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"recipient_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"type" text NOT NULL,
	"post_id" text,
	"comment_id" text,
	"message_id" text,
	"conversation_id" text,
	"read" boolean DEFAULT false NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_events" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"phase" text NOT NULL,
	"outcome" text NOT NULL,
	"action" text,
	"summary" text NOT NULL,
	"reason" text,
	"target_id" text,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "behavior_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"content_hash" text NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"fidelity" double precision,
	"post_count" integer DEFAULT 0 NOT NULL,
	"comment_count" integer DEFAULT 0 NOT NULL,
	"excerpt" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "benchmark_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"batch_id" text NOT NULL,
	"persona" text NOT NULL,
	"persona_display" text DEFAULT '' NOT NULL,
	"model" text NOT NULL,
	"task_id" text NOT NULL,
	"task_kind" text DEFAULT '' NOT NULL,
	"run_index" integer DEFAULT 0 NOT NULL,
	"output" text DEFAULT '' NOT NULL,
	"vector_fidelity" double precision,
	"judge_score" double precision,
	"rule_score" double precision,
	"rule_detail" text DEFAULT '' NOT NULL,
	"latency_ms" integer,
	"captured_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"user_id" text,
	"session_id" text NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personality_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"content_hash" text NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"snapshot_type" text DEFAULT 'dream' NOT NULL,
	"archive_path" text NOT NULL,
	"drift_from_anchor" double precision DEFAULT 0 NOT NULL,
	"drift_from_prev" double precision DEFAULT 0 NOT NULL,
	"excerpt" text DEFAULT '' NOT NULL,
	"diff_narrative" text,
	"aspect_drift" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "population_metrics" (
	"id" text PRIMARY KEY NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"persona_cohesion" double precision NOT NULL,
	"behavior_cohesion" double precision NOT NULL,
	"n" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"sid" varchar PRIMARY KEY NOT NULL,
	"sess" json NOT NULL,
	"expire" timestamp (6) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_keyhash_uq" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "api_keys_user_idx" ON "api_keys" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bookmarks_user_post_uq" ON "bookmarks" USING btree ("user_id","post_id");--> statement-breakpoint
CREATE INDEX "bookmarks_user_created_idx" ON "bookmarks" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "comments_post_created_idx" ON "comments" USING btree ("post_id","created_at");--> statement-breakpoint
CREATE INDEX "comments_post_status_created_idx" ON "comments" USING btree ("post_id","status","created_at");--> statement-breakpoint
CREATE INDEX "comments_author_created_idx" ON "comments" USING btree ("author_id","created_at");--> statement-breakpoint
CREATE INDEX "comments_parent_idx" ON "comments" USING btree ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "follows_pair_uq" ON "follows" USING btree ("follower_id","following_id");--> statement-breakpoint
CREATE INDEX "follows_following_created_idx" ON "follows" USING btree ("following_id","created_at");--> statement-breakpoint
CREATE INDEX "follows_follower_created_idx" ON "follows" USING btree ("follower_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "likes_user_target_uq" ON "likes" USING btree ("user_id","target_type","target_id");--> statement-breakpoint
CREATE INDEX "likes_user_type_created_idx" ON "likes" USING btree ("user_id","target_type","created_at");--> statement-breakpoint
CREATE INDEX "likes_target_created_idx" ON "likes" USING btree ("target_type","target_id","created_at");--> statement-breakpoint
CREATE INDEX "posts_author_created_idx" ON "posts" USING btree ("author_id","created_at");--> statement-breakpoint
CREATE INDEX "posts_author_status_created_idx" ON "posts" USING btree ("author_id","status","created_at");--> statement-breakpoint
CREATE INDEX "posts_status_created_idx" ON "posts" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "posts_status_vis_score_idx" ON "posts" USING btree ("status","visibility","feed_score");--> statement-breakpoint
CREATE INDEX "posts_tagids_gin" ON "posts" USING gin ("tag_ids");--> statement-breakpoint
CREATE INDEX "posts_mentionids_gin" ON "posts" USING gin ("mention_ids");--> statement-breakpoint
CREATE UNIQUE INDEX "tags_slug_uq" ON "tags" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "tags_postcount_idx" ON "tags" USING btree ("post_count");--> statement-breakpoint
CREATE INDEX "tags_lastused_idx" ON "tags" USING btree ("last_used_at");--> statement-breakpoint
CREATE INDEX "tags_featured_idx" ON "tags" USING btree ("featured");--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_uq" ON "users" USING btree ("username");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "users_status_lastseen_idx" ON "users" USING btree ("status","last_seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_pkey_uq" ON "conversations" USING btree ("participant_key");--> statement-breakpoint
CREATE INDEX "conversations_participants_gin" ON "conversations" USING gin ("participant_ids");--> statement-breakpoint
CREATE INDEX "conversations_lastmsg_idx" ON "conversations" USING btree ("last_message_at");--> statement-breakpoint
CREATE INDEX "messages_conv_created_idx" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_recipient_updated_idx" ON "notifications" USING btree ("recipient_id","updated_at");--> statement-breakpoint
CREATE INDEX "notifications_recipient_read_idx" ON "notifications" USING btree ("recipient_id","read");--> statement-breakpoint
CREATE INDEX "notifications_recipient_read_updated_idx" ON "notifications" USING btree ("recipient_id","read","updated_at");--> statement-breakpoint
CREATE INDEX "notifications_dedup_idx" ON "notifications" USING btree ("recipient_id","actor_id","type","post_id","comment_id","created_at");--> statement-breakpoint
CREATE INDEX "aevent_user_created_idx" ON "agent_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "aevent_type_outcome_created_idx" ON "agent_events" USING btree ("type","outcome","created_at");--> statement-breakpoint
CREATE INDEX "aevent_phase_created_idx" ON "agent_events" USING btree ("phase","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bsnap_contenthash_uq" ON "behavior_snapshots" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "bsnap_user_captured_idx" ON "behavior_snapshots" USING btree ("user_id","captured_at");--> statement-breakpoint
CREATE INDEX "bench_batch_idx" ON "benchmark_runs" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "bench_persona_model_task_idx" ON "benchmark_runs" USING btree ("persona","model","task_id");--> statement-breakpoint
CREATE INDEX "bench_persona_task_model_run_idx" ON "benchmark_runs" USING btree ("persona","task_id","model","run_index");--> statement-breakpoint
CREATE INDEX "events_type_created_idx" ON "events" USING btree ("type","created_at");--> statement-breakpoint
CREATE INDEX "events_user_created_idx" ON "events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "psnap_contenthash_uq" ON "personality_snapshots" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "psnap_user_captured_idx" ON "personality_snapshots" USING btree ("user_id","captured_at");--> statement-breakpoint
CREATE INDEX "psnap_type_user_idx" ON "personality_snapshots" USING btree ("snapshot_type","user_id");--> statement-breakpoint
CREATE INDEX "popmetric_captured_idx" ON "population_metrics" USING btree ("captured_at");--> statement-breakpoint
CREATE INDEX "IDX_session_expire" ON "session" USING btree ("expire");