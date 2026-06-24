-- Steps Toward Access — schema
-- Three tables: locations (one per barrier), photos (many per location),
-- events (correspondence + timeline steps, many per location).

create table public.locations (
  id           uuid primary key default gen_random_uuid(),
  label        text not null,
  party        text not null,
  email        text,
  status       text not null default 'documented'
               check (status in ('documented','contacted','awaiting','resolved')),
  published    boolean not null default false,
  x            numeric not null default 50,   -- pin left %, 0–100
  y            numeric not null default 50,   -- pin top %, 0–100
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- photos: many per location; alt is REQUIRED (accessibility)
create table public.photos (
  id           uuid primary key default gen_random_uuid(),
  location_id  uuid not null references public.locations(id) on delete cascade,
  src          text not null,            -- public URL from Storage
  alt          text not null,            -- enforced non-empty below
  caption      text,
  sort         int not null default 0,
  constraint alt_not_blank check (length(btrim(alt)) > 0)
);

-- events: correspondence + timeline steps, many per location
create table public.events (
  id           uuid primary key default gen_random_uuid(),
  location_id  uuid not null references public.locations(id) on delete cascade,
  when_label   text not null,            -- human date string, e.g. "Mar 3, 2026"
  occurred_on  date,                     -- optional sortable date
  dir          text not null,            -- "Sent to manager" / "Documented" etc.
  txt          text not null,
  sort         int not null default 0
);

create index on public.photos(location_id);
create index on public.events(location_id);

-- keep updated_at fresh on locations
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger locations_set_updated_at
  before update on public.locations
  for each row execute function public.set_updated_at();
