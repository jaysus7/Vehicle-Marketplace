-- Blog posts (published via n8n through the API).
-- Run once in the Supabase SQL editor. Safe to re-run.

create table if not exists public.blog_posts (
  id              uuid primary key default gen_random_uuid(),
  slug            text unique not null,
  title           text not null,
  excerpt         text,
  content_html    text not null,
  cover_image_url text,
  author          text not null default 'MarketSync',
  tags            text[] not null default '{}',
  status          text not null default 'published',   -- 'published' | 'draft'
  published_at    timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Fast "newest published first" listing.
create index if not exists blog_posts_published_idx
  on public.blog_posts (published_at desc)
  where status = 'published';

create index if not exists blog_posts_slug_idx on public.blog_posts (slug);
