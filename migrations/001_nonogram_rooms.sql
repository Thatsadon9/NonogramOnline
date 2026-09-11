create table if not exists nonogram_rooms (
  room_code text primary key,
  size smallint not null check (size in (5, 10, 15, 20, 25)),
  puzzle_seed integer not null,
  solution jsonb not null,
  cells jsonb not null,
  revision bigint not null default 0 check (revision >= 0),
  completed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists nonogram_room_players (
  room_code text not null references nonogram_rooms(room_code) on delete cascade,
  player_id text not null,
  display_name text not null check (char_length(display_name) between 1 and 24),
  color text not null,
  last_seen timestamptz not null default now(),
  primary key (room_code, player_id)
);

create index if not exists nonogram_room_players_active_idx
  on nonogram_room_players (room_code, last_seen desc);
